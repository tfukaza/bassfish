import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BassfishError, activeStates, increment, prepareMutation, requireThat, reservedStates } from './domain.js';
import type { Actor, Clock, ContentStore, ControlState, ControlStore, DurableTask, TurnRequest, Instance, Mutation, MutationResult, Note, NoteMutation, PendingCommit, ProjectRestoreChange, ProjectRestoreOperation, ProjectRestoreResult, ProjectSnapshot, ResourceType, StorageResult, Thread, ThreadMutation, WriteOperation } from './domain.js';
import { KeyedMutex } from './runtime.js';
import { schemas, nameSchema } from './api.js';
import type { ToolName } from './api.js';
import { normalizeLabels, normalizeLinks, outline, prepareNote } from './note.js';
import { NoteSearchIndex } from './storage/search.js';
import { exportProject as writeProjectExport } from './export.js';
import { RE2 } from 're2-wasm';

export interface Limits { offerMs: number; leaseMs: number; reconnectMs: number; instanceMs: number; queueMs: number; retentionMs: number; waitMs: number }
export const defaultLimits: Limits = { offerMs: 30_000, leaseMs: 30_000, reconnectMs: 30_000, instanceMs: 20_000, queueMs: 3_600_000, retentionMs: 3_600_000, waitMs: 20_000 };
const values = Object.values;
const uid = () => randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();
const pendingFor = (state: ControlState, instanceId: string) => values(state.requests).filter(r => r.instanceId === instanceId && activeStates.includes(r.state));
function toMutation(input: Record<string, unknown>): Mutation {
  return input as unknown as Mutation;
}
const threadMutationKinds = ['appendMessage','renameThread','setThreadDescription','archiveThread','activateThread','deleteThread','retractMessage','reinstateMessage'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sortThreads = (threads: Thread[]): Thread[] => [...threads].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
const encodeCursor = (pair: [string, string]) => Buffer.from(JSON.stringify(pair)).toString('base64url');
function decodeCursor(cursor: unknown): [string, string] | undefined {
  if (!cursor) return undefined;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { throw new BassfishError('INVALID_CURSOR', 'The cursor is invalid.'); }
  requireThat(Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string'), 'INVALID_CURSOR', 'The cursor is invalid.');
  return value as [string, string];
}

/** Application service: all coordination is persisted by ControlStore; all content uses ContentStore. */
export class Bassfish {
  readonly epoch = uid();
  readonly limits: Limits;
  private readonly writers = new KeyedMutex();
  private readonly restoreSecret = randomBytes(32);
  constructor(readonly control: ControlStore, readonly content: ContentStore, readonly clock: Clock, limits: Partial<Limits> = {}, private readonly searchIndex?: NoteSearchIndex, private readonly dataDir?: string) {
    this.limits = { ...defaultLimits, ...limits };
  }

  async initialize(): Promise<void> {
    const now = this.clock.now();
    this.control.update(state => {
      for (const instance of values(state.instances)) instance.active = false;
      for (const request of values(state.requests)) {
        if (request.state === 'QUEUED' || request.state === 'READY') request.reconnectUntil = Math.min(request.queueUntil, now + this.limits.reconnectMs);
        if (request.state === 'READY') request.state = 'QUEUED';
        if (request.state === 'OFFERED' || request.state === 'CLAIMED') this.finish(request, 'EXPIRED', state);
      }
      for (const project of values(state.projects)) project.recovering = true;
    });
    for (const project of this.control.view(s => values(s.projects))) {
      try { await this.content.ensureProject(project.id); await this.recover(project.id); }
      catch { /* Preserve PROJECT_RECOVERING; metadata diagnostics must remain available. */ }
    }
  }

  async open(commonDir: string, preferredName?: string): Promise<{ agentHandle: string; session: unknown }> {
    if (preferredName) nameSchema.parse(preferredName);
    const project = this.control.update(state => {
      let project = values(state.projects).find(p => p.commonDir === commonDir);
      if (!project) { project = { id: `p_${uid().replaceAll('-', '')}`, commonDir, recovering: true }; state.projects[project.id] = project; }
      return project;
    });
    await this.writers.run(project.id, async () => {
      await this.content.ensureProject(project.id);
      await this.recover(project.id);
    });
    this.sweep();
    const handle = uid();
    this.control.update(state => {
      const name = preferredName ?? `Agent_${uid().slice(0, 12).replaceAll('-', '')}`;
      let identity = values(state.identities).find(i => i.projectId === project.id && i.name.toLowerCase() === name.toLowerCase());
      if (!identity) { identity = { id: uid(), projectId: project.id, name }; state.identities[identity.id] = identity; }
      requireThat(!values(state.instances).some(i => i.identityId === identity.id && i.active), 'NAME_IN_USE', 'This identity has a live adapter instance.');
      const instance: Instance = { id: uid(), projectId: project.id, identityId: identity.id, handle, epoch: this.epoch, active: true, lastSeen: this.clock.now() };
      state.instances[instance.id] = instance;
      this.rebind(state, instance);
      this.promote(state);
    });
    return { agentHandle: handle, session: this.info(handle) };
  }

  private actor(state: ControlState, handle: string): Actor {
    const instance = values(state.instances).find(i => i.handle === handle && i.active && i.epoch === this.epoch);
    requireThat(instance, 'SESSION_EXPIRED', 'Open a new Bassfish instance; this handle is no longer current.');
    const identity = state.identities[instance.identityId]!;
    return { projectId: instance.projectId, instanceId: instance.id, identityId: identity.id, name: identity.name };
  }
  private ready(state: ControlState, projectId: string): void {
    requireThat(state.projects[projectId] && !state.projects[projectId].recovering, 'PROJECT_RECOVERING', 'The project has an unresolved storage operation.');
  }
  private creationAllowed(state: ControlState, projectId: string): void {
    this.ready(state, projectId);
    requireThat(!values(state.requests).some(request => request.projectId === projectId && request.resourceType === 'project' && activeStates.includes(request.state)),
      'PROJECT_TURN_PENDING', 'A project turn is queued or active; create the resource after it finishes.');
  }
  private finish(request: TurnRequest, state: 'EXPIRED' | 'CANCELLED' | 'RELEASED' | 'FAILED' | 'COMMITTED', control?: ControlState): void {
    request.state = state;
    request.finishedAt = this.clock.now();
    request.updatedAt = request.finishedAt;
    const task = control && values(control.tasks).find(value => value.requestId === request.id && value.status === 'working');
    if (task) {
      task.updatedAt = request.finishedAt;
      task.discardAt = request.finishedAt + this.limits.retentionMs;
      if (state === 'FAILED') { task.status = 'failed'; task.statusMessage = 'The turn request failed.'; task.error = { code: -32603, message: 'The turn request failed.' }; }
      else if (state !== 'COMMITTED') { task.status = 'cancelled'; task.statusMessage = state === 'EXPIRED' ? 'The turn request expired.' : 'The turn request was cancelled.'; }
    }
  }
  private disconnectIn(state: ControlState, instance: Instance, clean: boolean): void {
    instance.active = false;
    for (const request of values(state.requests).filter(r => r.instanceId === instance.id)) {
      if (request.state === 'QUEUED') {
        if (clean) this.finish(request, 'CANCELLED', state);
        else request.reconnectUntil = Math.min(request.queueUntil, this.clock.now() + this.limits.reconnectMs);
      }
      if (request.state === 'READY') {
        if (clean) this.finish(request, 'CANCELLED', state);
        else { request.state = 'QUEUED'; request.updatedAt = this.clock.now(); request.reconnectUntil = Math.min(request.queueUntil, this.clock.now() + this.limits.reconnectMs); }
      }
      if (request.state === 'CLAIMED' || request.state === 'OFFERED') this.finish(request, clean ? 'RELEASED' : 'EXPIRED', state);
    }
  }
  disconnect(handle: string, clean = true): void {
    this.control.update(state => {
      const instance = values(state.instances).find(i => i.handle === handle && i.epoch === this.epoch);
      if (instance) this.disconnectIn(state, instance, clean);
      this.promote(state);
    });
  }
  heartbeat(handle: string): void {
    this.sweep();
    this.control.update(state => { const actor = this.actor(state, handle); state.instances[actor.instanceId]!.lastSeen = this.clock.now(); });
  }
  sweep(): void {
    const now = this.clock.now();
    const wall = this.clock.wallNow();
    const clockChanged = this.clock.discontinuity();
    this.control.update(state => {
      const discontinuity = clockChanged || (state.wallClockHighWaterMs > 0 && wall + 2_000 < state.wallClockHighWaterMs);
      state.wallClockHighWaterMs = Math.max(state.wallClockHighWaterMs, wall);
      for (const instance of values(state.instances)) if (instance.active && now - instance.lastSeen >= this.limits.instanceMs) this.disconnectIn(state, instance, false);
      for (const request of values(state.requests)) {
        if ((request.state === 'QUEUED' || request.state === 'READY') && (now >= request.queueUntil || (request.reconnectUntil !== undefined && now >= request.reconnectUntil))) this.finish(request, 'EXPIRED', state);
        if (request.state === 'READY' && discontinuity) this.finish(request, 'EXPIRED', state);
        if (request.state === 'OFFERED' && (discontinuity || now >= request.claimBy!)) this.finish(request, 'EXPIRED', state);
        if (request.state === 'CLAIMED' && (discontinuity || now >= request.expiresAt!)) this.finish(request, 'EXPIRED', state);
        if (request.finishedAt !== undefined && now - request.finishedAt >= this.limits.retentionMs) delete state.requests[request.id];
      }
      for (const task of values(state.tasks)) if (now >= task.discardAt) delete state.tasks[task.id];
      this.promote(state);
    });
  }
  private promote(state: ControlState): void {
    for (const project of values(state.projects)) {
      if (project.recovering) continue;
      const all = values(state.requests).filter(r => r.projectId === project.id);
      const projects = all.filter(r => r.resourceType === 'project');
      if (projects.some(r => reservedStates.includes(r.state))) continue;
      const barrier = projects.filter(r => r.state === 'QUEUED').sort((a,b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)[0];
      if (barrier) {
        for (const offered of all.filter(r => r.resourceType !== 'project' && r.state === 'OFFERED')) {
          offered.state = 'QUEUED'; delete offered.offerId; delete offered.claimBy;
        }
        if (all.some(r => r.resourceType !== 'project' && (r.state === 'CLAIMED' || r.state === 'COMMITTING'))) continue;
        if (state.instances[barrier.instanceId]?.active) this.makeAvailable(state, barrier);
        continue;
      }
      for (const resource of values(state.resources).filter(r => r.projectId === project.id && r.type !== 'project' && r.present)) {
        const requests = all.filter(r => r.resourceId === resource.id);
        if (requests.some(r => reservedStates.includes(r.state))) continue;
        const next = requests.filter(r => r.state === 'QUEUED').sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)[0];
        if (!next || !state.instances[next.instanceId]?.active) continue;
        this.makeAvailable(state, next);
      }
    }
  }
  private makeAvailable(state: ControlState, request: TurnRequest): void {
    request.updatedAt = this.clock.now();
    if (request.deliveryMode === 'task') {
      request.state = 'READY';
      const task = values(state.tasks).find(value => value.requestId === request.id);
      if (task) { task.updatedAt = request.updatedAt; task.statusMessage = 'Turn ready; poll the task to receive a 30-second offer.'; }
      return;
    }
    request.state = 'OFFERED'; request.offerId = uid(); request.claimBy = request.updatedAt + this.limits.offerMs;
  }
  private materializeOffer(state: ControlState, request: TurnRequest): void {
    if (request.state !== 'READY') return;
    request.state = 'OFFERED'; request.offerId = uid(); request.claimBy = this.clock.now() + this.limits.offerMs; request.updatedAt = this.clock.now();
    const task = values(state.tasks).find(value => value.requestId === request.id && value.status === 'working');
    if (task) {
      task.status = 'completed'; task.statusMessage = 'The turn offer is ready to claim.'; task.updatedAt = request.updatedAt;
      task.discardAt = task.updatedAt + this.limits.retentionMs; task.result = this.statusIn(state, request);
    }
  }
  private rebind(state: ControlState, instance: Instance): void {
    for (const request of values(state.requests)) {
      if (request.identityId === instance.identityId && (request.state === 'QUEUED' || request.state === 'READY') && request.reconnectUntil !== undefined && request.reconnectUntil > this.clock.now()) {
        request.instanceId = instance.id;
        delete request.reconnectUntil;
      }
    }
  }
  info(handle: string): unknown {
    this.sweep();
    return this.control.view(state => {
      const actor = this.actor(state, handle);
      return { projectId: actor.projectId, identityId: actor.identityId, adapterInstanceId: actor.instanceId, name: actor.name,
        recovering: state.projects[actor.projectId]!.recovering, pendingRequests: pendingFor(state, actor.instanceId).map(r => this.statusIn(state, r)),
        pendingCommits: values(state.pending).filter(p => p.actor.identityId === actor.identityId).map(p => ({ operationId: p.id, resourceId: p.resourceId })) };
    });
  }
  requestName(handle: string, name: string): unknown {
    nameSchema.parse(name); this.sweep();
    this.control.update(state => {
      const actor = this.actor(state, handle);
      requireThat(pendingFor(state, actor.instanceId).length === 0 && !values(state.pending).some(p => p.actor.instanceId === actor.instanceId), 'TURN_REQUEST_EXISTS', 'Finish current operations before changing identity.');
      const target = values(state.identities).find(i => i.projectId === actor.projectId && i.name.toLowerCase() === name.toLowerCase());
      if (target && target.id !== actor.identityId) {
        requireThat(!values(state.instances).some(i => i.identityId === target.id && i.active), 'NAME_IN_USE', 'This identity has a live adapter instance.');
        state.instances[actor.instanceId]!.identityId = target.id;
        this.rebind(state, state.instances[actor.instanceId]!);
      } else state.identities[actor.identityId]!.name = name;
      this.promote(state);
    });
    return this.info(handle);
  }
  private statusIn(state: ControlState, request: TurnRequest): Record<string, unknown> {
    const position = values(state.requests).filter(r => r.resourceId === request.resourceId && r.state === 'QUEUED' && BigInt(r.sequence) <= BigInt(request.sequence)).length;
    const target = request.resourceType === 'project'
      ? { type: 'project', purpose: request.purpose }
      : { type: request.resourceType, id: request.resourceId };
    return { state: request.state.toLowerCase(), requestId: request.id, target,
      ...(request.state === 'QUEUED' ? { position } : {}),
      ...(request.state === 'OFFERED' ? { offerId: request.offerId, claimBy: iso(request.claimBy!) } : {}),
      ...(request.expiresAt !== undefined ? { expiresAt: iso(request.expiresAt) } : {}),
      ...(request.result ? { result: request.result } : {}) };
  }
  private ownRequest(state: ControlState, handle: string, ticketId: string): TurnRequest {
    const actor = this.actor(state, handle);
    const request = state.requests[ticketId];
    requireThat(request && request.projectId === actor.projectId && request.identityId === actor.identityId, 'NOT_TURN_OWNER', 'This ticket does not belong to the calling identity.');
    return request;
  }
  private ownTask(state: ControlState, handle: string, taskId: string): DurableTask {
    const actor = this.actor(state, handle); const task = state.tasks[taskId];
    requireThat(task && task.projectId === actor.projectId && task.identityId === actor.identityId, 'TASK_NOT_FOUND', 'Task not found for this identity.');
    return task;
  }
  private taskView(task: DurableTask): Record<string, unknown> {
    return { taskId: task.id, status: task.status, ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      createdAt: iso(task.createdAt), lastUpdatedAt: iso(task.updatedAt), ttlMs: Math.max(0,task.discardAt-task.createdAt), pollIntervalMs: 1_000,
      ...(task.status === 'completed' && task.result ? { result: task.result } : {}), ...(task.status === 'failed' && task.error ? { error: task.error } : {}) };
  }
  getTask(handle: string, taskId: string, materialize = true): Record<string, unknown> {
    this.sweep();
    return this.control.update(state => {
      const task = this.ownTask(state,handle,taskId); const request = state.requests[task.requestId];
      if (materialize && request) this.materializeOffer(state,request);
      return this.taskView(task);
    });
  }
  cancelTask(handle: string, taskId: string): Record<string, unknown> {
    this.sweep();
    return this.control.update(state => {
      const task = this.ownTask(state,handle,taskId); const request = state.requests[task.requestId];
      if (request && task.status === 'working' && ['QUEUED','READY','OFFERED'].includes(request.state)) this.finish(request,'CANCELLED',state);
      this.promote(state); return this.taskView(task);
    });
  }
  async waitTask(handle: string, taskId: string, updatedAfter: number, timeout: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const until = performance.now() + Math.min(timeout,this.limits.waitMs);
    while (true) {
      const task = this.control.view(state => this.taskView(this.ownTask(state,handle,taskId)));
      const updated = Date.parse(String(task.lastUpdatedAt));
      if (updated > updatedAfter || performance.now() >= until) return task;
      try { await delay(Math.min(100,Math.max(1,until-performance.now())),undefined,{ signal }); }
      catch { throw new BassfishError('CANCELLED','Task observation was cancelled.'); }
    }
  }
  status(handle: string, ticketId: string): Record<string, unknown> {
    this.sweep();
    return this.control.update(state => { const request = this.ownRequest(state, handle, ticketId); this.materializeOffer(state, request); return this.statusIn(state, request); });
  }
  private claimed(state: ControlState, handle: string, turnId: string, fence: string): TurnRequest {
    requireThat(turnId && fence, 'TURN_REQUIRED', 'Current turn credentials are required.');
    const actor = this.actor(state, handle);
    const request = values(state.requests).find(r => r.turnId === turnId);
    requireThat(request && request.projectId === actor.projectId && request.identityId === actor.identityId && request.instanceId === actor.instanceId, 'NOT_TURN_OWNER', 'The turn is not bound to this adapter instance.');
    requireThat(request.fence === fence && state.resources[request.resourceId]?.fence === fence, 'STALE_TURN', 'The fencing token is no longer current.');
    requireThat(request.state !== 'EXPIRED' && this.clock.now() < request.expiresAt!, 'TURN_EXPIRED', 'The turn deadline has elapsed.');
    requireThat(request.state !== 'COMMITTING', 'COMMIT_IN_PROGRESS', 'This turn has an accepted write in progress.');
    requireThat(request.state === 'CLAIMED', 'STALE_TURN', 'The turn has already been released or consumed.');
    this.ready(state, actor.projectId);
    return request;
  }
  async requestResourceTurn(handle: string, resourceTypeOrId: ResourceType | string, maybeResourceId?: string, deliveryMode: 'ticket' | 'task' = 'ticket'): Promise<Record<string, unknown>> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(s => this.ready(s, actor.projectId));
      const resourceId = maybeResourceId ?? resourceTypeOrId;
      const requestedType = maybeResourceId === undefined ? undefined : resourceTypeOrId as ResourceType;
      const actualType = await this.content.resourceType(actor.projectId, resourceId);
      requireThat(requestedType === undefined || actualType === requestedType, 'NOT_FOUND', 'Resource type does not match this identifier.');
      const resourceType = actualType;
      const ticketId = this.control.update(state => {
        this.actor(state, handle); this.ready(state, actor.projectId);
        requireThat(pendingFor(state, actor.instanceId).length === 0, 'TURN_REQUEST_EXISTS', 'This adapter already has a pending turn request.');
        const resource = state.resources[resourceId] ?? { id: resourceId, projectId: actor.projectId, type: resourceType, fence: '0', queueSequence: '0', present: true };
        requireThat(resource.projectId === actor.projectId && resource.present, 'NOT_FOUND', 'Resource not found in this project.');
        state.resources[resourceId] = resource;
        resource.queueSequence = increment(resource.queueSequence);
        const now = this.clock.now();
        const request: TurnRequest = { id: uid(), projectId: actor.projectId, resourceId, resourceType, identityId: actor.identityId, instanceId: actor.instanceId,
          sequence: resource.queueSequence, state: 'QUEUED', createdAt: now, updatedAt: now, queueUntil: now + this.limits.queueMs, deliveryMode };
        state.requests[request.id] = request;
        if (deliveryMode === 'task') state.tasks[request.id] = { id: request.id, projectId: actor.projectId, identityId: actor.identityId, requestId: request.id,
          status: 'working', statusMessage: 'Waiting for the turn.', createdAt: now, updatedAt: now, discardAt: request.queueUntil };
        this.promote(state);
        if (deliveryMode === 'task' && request.state === 'READY') { this.materializeOffer(state, request); delete state.tasks[request.id]; request.deliveryMode = 'ticket'; }
        return request.id;
      });
      return this.status(handle, ticketId);
    });
  }
  async requestProjectTurn(handle: string, purpose: TurnRequest['purpose'], deliveryMode: 'ticket' | 'task' = 'ticket'): Promise<Record<string, unknown>> {
    this.sweep(); const actor = this.control.view(s => this.actor(s,handle));
    return this.writers.run(actor.projectId, async () => {
      const ticketId = this.control.update(state => {
        this.actor(state,handle); this.ready(state,actor.projectId);
        requireThat(pendingFor(state,actor.instanceId).length === 0,'TURN_REQUEST_EXISTS','This adapter already has a pending turn request.');
        const resourceId = `project:${actor.projectId}`;
        const resource = state.resources[resourceId] ?? { id: resourceId, projectId: actor.projectId, type: 'project' as const, fence: '0', queueSequence: '0', present: true };
        state.resources[resourceId] = resource; resource.queueSequence = increment(resource.queueSequence);
        const now = this.clock.now();
        const request: TurnRequest = { id: uid(), projectId: actor.projectId, resourceId, resourceType: 'project', purpose, identityId: actor.identityId,
          instanceId: actor.instanceId, sequence: resource.queueSequence, state: 'QUEUED', createdAt: now, updatedAt: now, queueUntil: now + this.limits.queueMs, deliveryMode };
        state.requests[request.id] = request;
        if (deliveryMode === 'task') state.tasks[request.id] = { id: request.id, projectId: actor.projectId, identityId: actor.identityId, requestId: request.id,
          status: 'working', statusMessage: 'Waiting for the project turn.', createdAt: now, updatedAt: now, discardAt: request.queueUntil };
        this.promote(state);
        if (deliveryMode === 'task' && request.state === 'READY') { this.materializeOffer(state, request); delete state.tasks[request.id]; request.deliveryMode = 'ticket'; }
        return request.id;
      });
      return this.status(handle,ticketId);
    });
  }
  async claimTurn(handle: string, offerId: string, limit: number, noteCursor?: string): Promise<unknown> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      const offer = () => this.control.view(state => {
        this.actor(state, handle); this.ready(state, actor.projectId);
        const request = values(state.requests).find(r => r.offerId === offerId);
        requireThat(request && request.instanceId === actor.instanceId && request.projectId === actor.projectId, 'NOT_TURN_OWNER', 'The offer is not bound to this instance.');
        requireThat(request.state !== 'EXPIRED' && this.clock.now() < request.claimBy!, 'OFFER_EXPIRED', 'The offer claim window has elapsed.');
        requireThat(request.state === 'OFFERED', 'OFFER_UNAVAILABLE', 'This offer is no longer available.');
        return request;
      });
      const request = offer();
      if (request.resourceType === 'project') {
        const commit = await this.content.head(actor.projectId); this.sweep(); offer();
        const turn = this.control.update(state => { const current = state.requests[request.id]!; const resource = state.resources[current.resourceId]!;
          resource.fence = increment(resource.fence); current.state = 'CLAIMED'; current.turnId = uid(); current.fence = resource.fence; current.baseRevision = '0';
          current.snapshotCommit = commit; current.expiresAt = this.clock.now() + this.limits.leaseMs; return current; });
        return { requestId: turn.id, target: { type: 'project', purpose: turn.purpose },
          turn: { id: turn.turnId, fencingToken: turn.fence, expiresAt: iso(turn.expiresAt!) }, snapshot: { commit }, serverTime: iso(this.clock.now()) };
      }
      const snapshot = request.resourceType === 'thread'
        ? await this.content.snapshot(actor.projectId, request.resourceId, limit)
        : await this.content.noteSnapshot(actor.projectId, request.resourceId, noteCursor);
      this.sweep(); offer();
      const turn = this.control.update(state => {
        const current = state.requests[request.id]!;
        const resource = state.resources[current.resourceId]!;
        resource.fence = increment(resource.fence);
        current.state = 'CLAIMED'; current.turnId = uid(); current.fence = resource.fence;
        current.baseRevision = snapshot.resourceType === 'thread' ? snapshot.thread.revision : snapshot.note.revision; current.snapshotCommit = snapshot.commit;
        current.expiresAt = this.clock.now() + this.limits.leaseMs;
        return current;
      });
      this.control.view(s => this.claimed(s, handle, turn.turnId!, turn.fence!));
      const page = snapshot.resourceType === 'thread'
        ? { type: 'thread', thread: snapshot.thread, messages: snapshot.messages, truncated: snapshot.truncated }
        : { type: 'note', note: this.noteMetadata(snapshot.note), ...snapshot.page };
      return { requestId: turn.id, target: { type: snapshot.resourceType, id: request.resourceId },
        turn: { id: turn.turnId, fencingToken: turn.fence, expiresAt: iso(turn.expiresAt!) }, snapshot: { commit: snapshot.commit, revision: turn.baseRevision },
        page, nextCursor: snapshot.resourceType === 'thread' ? snapshot.nextBefore : snapshot.page.nextCursor, serverTime: iso(this.clock.now()) };
    });
  }
  async read(handle: string, turnId: string, fence: string, limit: number, before?: string): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType === 'thread', 'RESOURCE_TYPE_MISMATCH', 'This turn belongs to a note.');
    const snapshot = await this.content.snapshot(request.projectId, request.resourceId, limit, before, request.snapshotCommit);
    this.sweep(); this.control.view(s => this.claimed(s, handle, turnId, fence));
    return { target: { type: 'thread', id: request.resourceId }, snapshot: { commit: snapshot.commit, revision: request.baseRevision },
      page: { type: 'thread', messages: snapshot.messages }, nextCursor: snapshot.nextBefore };
  }
  async readNote(handle: string, turnId: string, fence: string, cursor?: string): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType === 'note', 'RESOURCE_TYPE_MISMATCH', 'This turn belongs to a thread.');
    const snapshot = await this.content.noteSnapshot(request.projectId, request.resourceId, cursor, request.snapshotCommit);
    this.sweep(); this.control.view(s => this.claimed(s, handle, turnId, fence));
    return { target: { type: 'note', id: snapshot.note.id }, snapshot: { commit: snapshot.commit, revision: request.baseRevision }, page: { type: 'note', note: this.noteMetadata(snapshot.note), ...snapshot.page }, nextCursor: snapshot.page.nextCursor };
  }
  async readTurn(handle: string, turnId: string, fence: string, cursor?: string): Promise<unknown> {
    const request = this.control.view(s => this.claimed(s,handle,turnId,fence));
    if (request.resourceType === 'thread') return this.read(handle,turnId,fence,20,cursor);
    if (request.resourceType === 'note') return this.readNote(handle,turnId,fence,cursor);
    throw new BassfishError('RESOURCE_TYPE_MISMATCH','Project turns have operation-specific readers.');
  }
  async noteOutline(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s,handle,turnId,fence));
    requireThat(request.resourceType === 'note','RESOURCE_TYPE_MISMATCH','This turn does not belong to a note.');
    const snapshot = await this.content.noteSnapshot(request.projectId,request.resourceId,undefined,request.snapshotCommit);
    this.sweep(); this.control.view(s => this.claimed(s,handle,turnId,fence));
    return { noteId: request.resourceId, revision: request.baseRevision, snapshotCommit: request.snapshotCommit, headings: outline(snapshot.note.body) };
  }
  async findNote(handle: string, turnId: string, fence: string, query: string, mode: 'literal'|'regex', limit: number): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s,handle,turnId,fence));
    requireThat(request.resourceType === 'note','RESOURCE_TYPE_MISMATCH','This turn does not belong to a note.');
    const snapshot = await this.content.noteSnapshot(request.projectId,request.resourceId,undefined,request.snapshotCommit); const body = snapshot.note.body;
    const ranges: { start: number; end: number }[] = [];
    if (mode === 'literal') { let at = 0; while (ranges.length < limit && (at = body.indexOf(query,at)) >= 0) { ranges.push({ start: at, end: at + query.length }); at += Math.max(1,query.length); } }
    else { const regex = new RE2(query,'gu'); let match: RegExpExecArray | null; while (ranges.length < limit && (match = regex.exec(body) as RegExpExecArray | null)) { ranges.push({ start: match.index, end: match.index + match[0].length }); if (!match[0]) regex.lastIndex++; } }
    this.sweep(); this.control.view(s => this.claimed(s,handle,turnId,fence));
    return { noteId: request.resourceId, revision: request.baseRevision, snapshotCommit: request.snapshotCommit, matches: ranges.map(range => ({
      startCharacter: range.start, endCharacter: range.end, line: body.slice(0,range.start).split('\n').length,
      snippet: body.slice(Math.max(0,range.start - 128),Math.min(body.length,range.end + 384)) })) };
  }
  releaseTurn(handle: string, turnId: string, fence: string): unknown {
    this.sweep();
    return this.control.update(state => {
      const request = this.claimed(state, handle, turnId, fence);
      this.finish(request, 'RELEASED', state); this.promote(state);
      return this.statusIn(state, request);
    });
  }
  cancelTurnRequest(handle: string, ticketId: string): unknown {
    this.sweep();
    return this.control.update(state => {
      const actor = this.actor(state, handle);
      const request = this.ownRequest(state, handle, ticketId);
      requireThat(request.instanceId === actor.instanceId, 'NOT_TURN_OWNER', 'Rebind this queue request before cancelling it.');
      requireThat(request.state !== 'CLAIMED' && request.state !== 'COMMITTING', 'TURN_ALREADY_CLAIMED', 'The turn has already been claimed.');
      if (request.state === 'QUEUED' || request.state === 'READY' || request.state === 'OFFERED') this.finish(request, 'CANCELLED', state);
      this.promote(state); return this.statusIn(state, request);
    });
  }
  async waitForTurn(handle: string, ticketId: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
    requireThat(timeout <= this.limits.waitMs, 'INVALID_ARGUMENT', 'The wait exceeds the configured maximum.');
    const until = performance.now() + timeout;
    while (true) {
      const status = this.status(handle, ticketId);
      if (status.state !== 'queued' || performance.now() >= until) return status;
      try { await delay(Math.min(100, Math.max(1, until - performance.now())), undefined, { signal }); }
      catch { try { this.cancelTurnRequest(handle, ticketId); } catch { /* Claim may already have won. */ } throw new BassfishError('CANCELLED', 'The wait was cancelled; inspect ticket state.'); }
    }
  }
  async createThread(handle: string, title: string, description: string): Promise<unknown> {
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(s => { this.actor(s, handle); this.creationAllowed(s, actor.projectId); });
      const startingHead = await this.content.head(actor.projectId);
      const thread: Thread = { id: uid(), title, description, state: 'active', revision: '1', headSequence: '0', creator: actor.identityId, createdAt: iso(this.clock.now()) };
      const operation: WriteOperation = { id: uid(), actor, resourceId: thread.id, resourceType: 'thread', at: thread.createdAt, thread, mutation: { kind: 'createThread' } };
      this.control.update(state => {
        this.actor(state, handle); this.creationAllowed(state, actor.projectId);
        state.pending[operation.id] = { id: operation.id, projectId: actor.projectId, resourceId: thread.id, resourceType: 'thread', startingHead, kind: 'createThread', actor };
      });
      const result = await this.persist(operation);
      return { threadId: thread.id, title, state: thread.state, ...result };
    });
  }
  private noteMetadata(note: Note): Omit<Note, 'body'> & { contentBytes: number } {
    const { body, ...metadata } = note;
    return { ...metadata, contentBytes: Buffer.byteLength(body, 'utf8') };
  }
  private async validateLinks(projectId: string, links: Note['links']): Promise<void> {
    if (!links.length) return;
    const snapshot = await this.content.projectSnapshot(projectId);
    const ids = {
      note: new Set(snapshot.notes.map(value => value.id)),
      thread: new Set(snapshot.threads.map(value => value.id)),
      message: new Set(snapshot.messages.map(value => value.id)),
    };
    for (const link of links) requireThat(ids[link.targetType].has(link.targetId), 'LINK_TARGET_NOT_FOUND', `The ${link.targetType} link target does not exist in this project.`);
  }
  async createNote(handle: string, input: { path: string; title: string; body: string; labels: string[]; noteKind: string | null; links: { targetType: 'note'|'thread'|'message'; targetId: string }[] }): Promise<unknown> {
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(s => { this.actor(s, handle); this.creationAllowed(s, actor.projectId); });
      const links = normalizeLinks(input.links.map(link => ({ targetType: link.targetType, targetId: link.targetId })));
      await this.validateLinks(actor.projectId, links);
      const startingHead = await this.content.head(actor.projectId); const at = iso(this.clock.now());
      const note: Note = { id: uid(), path: input.path, title: input.title, body: input.body, labels: normalizeLabels(input.labels), kind: input.noteKind,
        state: 'active', revision: '1', creator: actor.identityId, creatorName: actor.name, lastEditor: actor.identityId,
        lastEditorName: actor.name, createdAt: at, updatedAt: at, links };
      const operation: WriteOperation = { id: uid(), actor, resourceId: note.id, resourceType: 'note', at, note, mutation: { kind: 'createNote' } };
      this.control.update(state => { this.actor(state, handle); this.creationAllowed(state, actor.projectId); state.pending[operation.id] = {
        id: operation.id, projectId: actor.projectId, resourceId: note.id, resourceType: 'note', startingHead, kind: 'createNote', actor }; });
      const result = await this.persist(operation);
      return { noteId: note.id, path: note.path, title: note.title, state: note.state, ...result };
    });
  }
  private signRestore(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.restoreSecret).update(body).digest('base64url')}`;
  }
  private verifyRestore(token: string): Record<string, unknown> {
    const [body, signature, extra] = token.split('.');
    requireThat(body && signature && !extra, 'INVALID_PREVIEW', 'The restore preview token is invalid.');
    const expected = createHmac('sha256', this.restoreSecret).update(body).digest(); const actual = Buffer.from(signature, 'base64url');
    requireThat(actual.length === expected.length && timingSafeEqual(actual, expected), 'INVALID_PREVIEW', 'The restore preview token is invalid.');
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>; }
    catch { throw new BassfishError('INVALID_PREVIEW', 'The restore preview token is invalid.'); }
  }
  async resourceHistory(handle: string, turnId: string, fence: string, offset: number, limit: number): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType !== 'project', 'RESOURCE_TYPE_MISMATCH', 'Project turns do not have one resource history.');
    const entries = await this.content.history(request.projectId, request.resourceType, request.resourceId);
    this.sweep(); this.control.view(s => this.claimed(s, handle, turnId, fence));
    return { target: { type: request.resourceType, id: request.resourceId }, entries: entries.slice(offset, offset + limit), nextOffset: offset + limit < entries.length ? offset + limit : null };
  }
  async resourceAt(handle: string, turnId: string, fence: string, revision: string, limit: number, cursor?: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType !== 'project', 'RESOURCE_TYPE_MISMATCH', 'Use a resource turn for historical reads.');
    const commit = await this.content.commitAtRevision(request.projectId, request.resourceType, request.resourceId, revision);
    const snapshot = request.resourceType === 'thread' ? await this.content.snapshot(request.projectId, request.resourceId, limit, undefined, commit)
      : await this.content.noteSnapshot(request.projectId, request.resourceId, cursor, commit);
    this.sweep(); this.control.view(s => this.claimed(s, handle, turnId, fence));
    return snapshot.resourceType === 'thread'
      ? { target: { type: 'thread', id: request.resourceId }, revision, snapshotCommit: commit, page: { type: 'thread', thread: snapshot.thread, messages: snapshot.messages, truncated: snapshot.truncated }, nextCursor: snapshot.nextBefore }
      : { target: { type: 'note', id: request.resourceId }, revision, snapshotCommit: commit, page: { type: 'note', note: this.noteMetadata(snapshot.note), ...snapshot.page }, nextCursor: snapshot.page.nextCursor };
  }
  async diffResource(handle: string, turnId: string, fence: string, revision: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType !== 'project', 'RESOURCE_TYPE_MISMATCH', 'Use a resource turn for diffs.');
    const targetCommit = await this.content.commitAtRevision(request.projectId, request.resourceType, request.resourceId, revision);
    if (request.resourceType === 'note') {
      const [target,current] = await Promise.all([this.content.noteSnapshot(request.projectId,request.resourceId,undefined,targetCommit),this.content.noteSnapshot(request.projectId,request.resourceId)]);
      this.sweep(); this.control.view(s => this.claimed(s,handle,turnId,fence));
      return { target: { type: 'note', id: request.resourceId }, fromRevision: revision, toRevision: current.note.revision, fromCommit: targetCommit, toCommit: current.commit,
        metadataChanged: JSON.stringify(this.noteMetadata(target.note)) !== JSON.stringify(this.noteMetadata(current.note)), before: target.page, after: current.page };
    }
    const [target,current] = await Promise.all([this.content.snapshot(request.projectId,request.resourceId,1_000_000,undefined,targetCommit),this.content.snapshot(request.projectId,request.resourceId,1_000_000)]);
    this.sweep(); this.control.view(s => this.claimed(s,handle,turnId,fence));
    const targetIds = new Set(target.messages.filter(message => !message.retracted).map(message => message.id));
    const currentIds = new Set(current.messages.filter(message => !message.retracted).map(message => message.id));
    return { target: { type: 'thread', id: request.resourceId }, fromRevision: revision, toRevision: current.thread.revision, fromCommit: targetCommit, toCommit: current.commit,
      metadataChanged: JSON.stringify(target.thread) !== JSON.stringify(current.thread), messagesAdded: [...currentIds].filter(id => !targetIds.has(id)), messagesRemoved: [...targetIds].filter(id => !currentIds.has(id)) };
  }
  async previewRestore(handle: string, turnId: string, fence: string, revision: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(request.resourceType !== 'project', 'RESOURCE_TYPE_MISMATCH', 'Use a resource turn for this restore preview.');
    const targetCommit = await this.content.commitAtRevision(request.projectId, request.resourceType, request.resourceId, revision);
    const preview = await this.diffResource(handle, turnId, fence, revision);
    const token = this.signRestore({ turnId, fence, projectId: request.projectId, resourceType: request.resourceType, resourceId: request.resourceId,
      currentRevision: request.baseRevision, targetRevision: revision, targetCommit, expiresAt: request.expiresAt });
    return { ...preview as object, previewToken: token, expiresAt: iso(request.expiresAt!) };
  }
  async restoreRevision(handle: string, turnId: string, fence: string, token: string): Promise<MutationResult> {
    this.sweep(); const payload = this.verifyRestore(token); const actor = this.control.view(s => this.actor(s,handle));
    return this.writers.run(actor.projectId, async () => {
      const request = this.control.view(s => this.claimed(s,handle,turnId,fence));
      requireThat(payload.turnId === turnId && payload.fence === fence && payload.projectId === actor.projectId && payload.resourceId === request.resourceId &&
        payload.resourceType === request.resourceType && payload.currentRevision === request.baseRevision && Number(payload.expiresAt) > this.clock.now(), 'PREVIEW_STALE', 'The restore preview no longer matches this turn.');
      const at = iso(this.clock.now()); let operation: WriteOperation;
      if (request.resourceType === 'note') {
        const [target,current] = await Promise.all([this.content.noteSnapshot(actor.projectId,request.resourceId,undefined,payload.targetCommit as string),this.content.noteSnapshot(actor.projectId,request.resourceId)]);
        requireThat(current.note.revision === request.baseRevision, 'REVISION_CHANGED', 'The current note changed after the turn was claimed.');
        const note: Note = { ...target.note, revision: increment(current.note.revision), lastEditor: actor.identityId, lastEditorName: actor.name, updatedAt: at };
        operation = { id: uid(), actor, resourceId: request.resourceId, resourceType: 'note', at, note, mutation: { kind: 'replaceNoteBody', body: note.body } };
      } else {
        const [target,current] = await Promise.all([this.content.snapshot(actor.projectId,request.resourceId,1_000_000,undefined,payload.targetCommit as string),this.content.snapshot(actor.projectId,request.resourceId,1_000_000)]);
        requireThat(current.thread.revision === request.baseRevision, 'REVISION_CHANGED', 'The current thread changed after the turn was claimed.');
        const thread: Thread = { ...target.thread, revision: increment(current.thread.revision), headSequence: current.thread.headSequence };
        const targetVisibility = new Map(target.messages.map(message => [message.id,!message.retracted]));
        const visibilityChanges = current.messages.filter(message => (!message.retracted) !== (targetVisibility.get(message.id) ?? false)).map(message => ({ messageId: message.id, visible: targetVisibility.get(message.id) ?? false }));
        operation = { id: uid(), actor, resourceId: request.resourceId, resourceType: 'thread', at, thread, mutation: { kind: 'restoreThreadRevision', targetRevision: payload.targetRevision as string }, visibilityChanges };
      }
      this.control.update(state => { const current = this.claimed(state,handle,turnId,fence); current.state = 'COMMITTING'; state.pending[operation.id] = {
        id: operation.id, projectId: actor.projectId, resourceId: request.resourceId, resourceType: request.resourceType, turnRequestId: request.id,
        startingHead: request.snapshotCommit!, kind: 'restoreRevision', actor }; });
      return this.persist(operation);
    });
  }
  private projectTurn(state: ControlState, handle: string, turnId: string, fence: string, purpose?: TurnRequest['purpose']): TurnRequest {
    const request = this.claimed(state,handle,turnId,fence); requireThat(request.resourceType === 'project','RESOURCE_TYPE_MISMATCH','A project turn is required.');
    requireThat(!purpose || request.purpose === purpose,'PROJECT_PURPOSE_MISMATCH','This project turn was acquired for another purpose.'); return request;
  }
  async projectSnapshotInfo(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'snapshot'));
    const snapshot = await this.content.projectSnapshot(request.projectId,request.snapshotCommit);
    this.sweep(); this.control.view(s => this.projectTurn(s,handle,turnId,fence,'snapshot'));
    return { snapshotCommit: snapshot.commit, threads: snapshot.threads.map(thread => ({ id: thread.id, title: thread.title, description: thread.description, state: thread.state, revision: thread.revision })),
      notes: snapshot.notes.map(note => this.noteMetadata(note)), messageCount: snapshot.messages.length };
  }
  private cursorOffset(token: string | undefined, expected: Record<string, unknown>): number {
    if (!token) return 0;
    const payload = this.verifyRestore(token);
    for (const [key,value] of Object.entries(expected)) requireThat(payload[key] === value,'INVALID_CURSOR','The cursor does not match this snapshot or query.');
    requireThat(Number.isSafeInteger(payload.offset) && Number(payload.offset) >= 0,'INVALID_CURSOR','The cursor offset is invalid.');
    return Number(payload.offset);
  }
  private nextCursor(offset: number | null, expected: Record<string, unknown>): string | null { return offset === null ? null : this.signRestore({ ...expected, offset }); }
  async projectSearch(handle: string, turnId: string, fence: string, query: string, states: string[], limit: number, cursor?: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'search'));
    requireThat(this.searchIndex,'SEARCH_UNAVAILABLE','The rebuildable search index is unavailable.');
    const key = { kind: 'currentSearch', snapshotCommit: request.snapshotCommit, query, states: JSON.stringify(states) }; const offset = this.cursorOffset(cursor,key);
    const snapshot = await this.content.projectSnapshot(request.projectId,request.snapshotCommit); this.searchIndex.ensure(request.projectId,snapshot.commit,snapshot.notes);
    const matches = this.searchIndex.search(request.projectId,query,states,limit,offset);
    this.sweep(); this.control.view(s => this.projectTurn(s,handle,turnId,fence,'search'));
    return { snapshotCommit: snapshot.commit, matches: matches.map(match => ({ noteId: match.noteId, path: match.path, revision: match.revision, snippet: match.snippet })), nextCursor: this.nextCursor(matches.length === limit ? offset + limit : null,key) };
  }
  async projectHistorySearch(handle: string, turnId: string, fence: string, query: string, noteId: string | undefined, states: string[], limit: number, cursor?: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'search'));
    requireThat(this.searchIndex,'SEARCH_UNAVAILABLE','The rebuildable search index is unavailable.');
    const key = { kind: 'historySearch', snapshotCommit: request.snapshotCommit, query, noteId: noteId ?? null, states: JSON.stringify(states) }; const offset = this.cursorOffset(cursor,key);
    const history = await this.content.historicalNotes(request.projectId,request.snapshotCommit!); this.searchIndex.ensureHistory(request.projectId,request.snapshotCommit!,history);
    const matches = this.searchIndex.searchHistory(request.projectId,query,states,noteId,limit,offset);
    this.sweep(); this.control.view(s => this.projectTurn(s,handle,turnId,fence,'search'));
    return { snapshotCommit: request.snapshotCommit, matches, nextCursor: this.nextCursor(matches.length === limit ? offset + limit : null,key) };
  }
  async projectHistoryList(handle: string, turnId: string, fence: string, limit: number, cursor?: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'restore'));
    const key = { kind: 'projectHistory', snapshotCommit: request.snapshotCommit }; const offset = this.cursorOffset(cursor,key);
    const entries = await this.content.projectHistory(request.projectId); const page = entries.filter(value => value.doltCommit).slice(offset,offset+limit);
    this.sweep(); this.control.view(s => this.projectTurn(s,handle,turnId,fence,'restore'));
    return { snapshotCommit: request.snapshotCommit, entries: page, nextCursor: this.nextCursor(page.length === limit ? offset+limit : null,key) };
  }
  private async buildProjectRestore(projectId: string, actor: Actor, current: ProjectSnapshot, target: ProjectSnapshot): Promise<{ snapshot: ProjectSnapshot; changes: ProjectRestoreChange[]; digest: string; summary: Record<string, unknown> }> {
    const changes: ProjectRestoreChange[] = []; const at = iso(this.clock.now());
    const currentThreads = new Map(current.threads.map(value => [value.id,value])); const targetThreads = new Map(target.threads.map(value => [value.id,value]));
    const currentNotes = new Map(current.notes.map(value => [value.id,value])); const targetNotes = new Map(target.notes.map(value => [value.id,value]));
    const threadShape = (snapshot: ProjectSnapshot, id: string) => ({ thread: snapshot.threads.find(value => value.id === id) ? (() => { const { revision: _r, headSequence: _s, ...rest } = snapshot.threads.find(value => value.id === id)!; return rest; })() : null,
      messages: snapshot.messages.filter(value => value.threadId === id), visibility: snapshot.visibility.filter(value => value.threadId === id).map(({ threadRevision: _r, ...rest }) => rest) });
    const noteShape = (note: Note | undefined) => note ? (() => { const { revision: _r, lastEditor: _e, lastEditorName: _n, updatedAt: _u, ...rest } = note; return rest; })() : null;
    const changedThreads = new Map<string,string>(); const changedNotes = new Map<string,string>();
    for (const id of new Set([...currentThreads.keys(),...targetThreads.keys()])) {
      const before = currentThreads.get(id); const after = targetThreads.get(id); if (JSON.stringify(threadShape(current,id)) === JSON.stringify(threadShape(target,id))) continue;
      const next = increment(await this.content.maxRevision(projectId,'thread',id)); changedThreads.set(id,next);
      changes.push({ resourceType: 'thread', resourceId: id, action: !before ? 'create' : !after ? 'delete' : 'update', beforeRevision: before?.revision ?? '0', afterRevision: next });
    }
    for (const id of new Set([...currentNotes.keys(),...targetNotes.keys()])) {
      const before = currentNotes.get(id); const after = targetNotes.get(id); if (JSON.stringify(noteShape(before)) === JSON.stringify(noteShape(after))) continue;
      const next = increment(await this.content.maxRevision(projectId,'note',id)); changedNotes.set(id,next);
      changes.push({ resourceType: 'note', resourceId: id, action: !before ? 'create' : !after ? 'delete' : 'update', beforeRevision: before?.revision ?? '0', afterRevision: next });
    }
    changes.sort((a,b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
    const threads = await Promise.all(target.threads.map(async thread => ({ ...thread, revision: changedThreads.get(thread.id) ?? currentThreads.get(thread.id)?.revision ?? thread.revision,
      headSequence: await this.content.maxSequence(projectId,thread.id) })));
    const notes = target.notes.map(note => changedNotes.has(note.id) ? { ...note, revision: changedNotes.get(note.id)!, lastEditor: actor.identityId, lastEditorName: actor.name, updatedAt: at }
      : { ...note, revision: currentNotes.get(note.id)?.revision ?? note.revision });
    const snapshot = { ...target, threads, notes };
    const summary = {
      threads: { create: changes.filter(c => c.resourceType === 'thread' && c.action === 'create').length, update: changes.filter(c => c.resourceType === 'thread' && c.action === 'update').length, delete: changes.filter(c => c.resourceType === 'thread' && c.action === 'delete').length },
      notes: { create: changes.filter(c => c.resourceType === 'note' && c.action === 'create').length, update: changes.filter(c => c.resourceType === 'note' && c.action === 'update').length, delete: changes.filter(c => c.resourceType === 'note' && c.action === 'delete').length },
      messages: { current: current.messages.length, target: target.messages.length }, links: { current: current.notes.reduce((n,v) => n+v.links.length,0), target: target.notes.reduce((n,v) => n+v.links.length,0) },
      visibility: { current: current.visibility.length, target: target.visibility.length },
    };
    const digest = createHmac('sha256',this.restoreSecret).update(JSON.stringify({ current: current.commit, target: target.commit, changes, summary })).digest('base64url');
    return { snapshot, changes, digest, summary };
  }
  async previewProjectRestore(handle: string, turnId: string, fence: string, targetCommit: string, limit: number, cursor?: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'restore')); const actor = this.control.view(s => this.actor(s,handle));
    const [current,target] = await Promise.all([this.content.projectSnapshot(request.projectId,request.snapshotCommit),this.content.projectSnapshot(request.projectId,targetCommit)]);
    const built = await this.buildProjectRestore(request.projectId,actor,current,target); const key = { kind: 'restoreChanges', currentCommit: current.commit, targetCommit: target.commit, digest: built.digest }; const offset = this.cursorOffset(cursor,key);
    const page = built.changes.slice(offset,offset+limit); const previewToken = this.signRestore({ kind: 'snapshotRestore', turnId, fence, projectId: request.projectId, currentCommit: current.commit, targetCommit: target.commit, digest: built.digest, expiresAt: request.expiresAt });
    this.sweep(); this.control.view(s => this.projectTurn(s,handle,turnId,fence,'restore'));
    return { currentCommit: current.commit, targetCommit: target.commit, summary: built.summary, changes: page, nextCursor: this.nextCursor(page.length === limit ? offset+limit : null,key), previewToken, expiresAt: iso(request.expiresAt!) };
  }
  async restoreProject(handle: string, turnId: string, fence: string, token: string): Promise<ProjectRestoreResult> {
    this.sweep(); const payload = this.verifyRestore(token); const actor = this.control.view(s => this.actor(s,handle));
    return this.writers.run(actor.projectId,async () => {
      const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'restore'));
      requireThat(payload.kind === 'snapshotRestore' && payload.turnId === turnId && payload.fence === fence && payload.projectId === actor.projectId && payload.currentCommit === request.snapshotCommit && Number(payload.expiresAt) > this.clock.now(),'PREVIEW_STALE','The restore preview no longer matches this turn.');
      const [current,target] = await Promise.all([this.content.projectSnapshot(actor.projectId),this.content.projectSnapshot(actor.projectId,String(payload.targetCommit))]);
      requireThat(current.commit === request.snapshotCommit,'PREVIEW_STALE','The project changed after the restore preview.');
      const built = await this.buildProjectRestore(actor.projectId,actor,current,target); requireThat(built.digest === payload.digest,'PREVIEW_STALE','The restore change set changed.');
      requireThat(built.changes.length > 0,'NO_CHANGE','The target snapshot already matches visible project content.');
      const operationId = uid(); const at = iso(this.clock.now());
      const restoredThreadRevisions = new Map(built.changes.filter(change => change.resourceType === 'thread' && change.action !== 'delete').map(change => [change.resourceId,change.afterRevision]));
      const restoredSnapshot = { ...built.snapshot, visibility: built.snapshot.visibility.map(value => restoredThreadRevisions.has(value.threadId)
        ? { ...value, threadRevision: restoredThreadRevisions.get(value.threadId)!, operationId, createdAt: at } : value) };
      const operation: ProjectRestoreOperation = { id: operationId, actor, resourceId: request.resourceId, resourceType: 'project', at, mutation: { kind: 'restoreSnapshot', targetCommit: target.commit }, target: restoredSnapshot, current, changes: built.changes };
      this.control.update(state => { const claimed = this.projectTurn(state,handle,turnId,fence,'restore'); claimed.state = 'COMMITTING'; claimed.updatedAt = this.clock.now(); state.pending[operation.id] = { id: operation.id, projectId: actor.projectId, resourceId: request.resourceId, resourceType: 'project', turnRequestId: request.id, startingHead: current.commit, kind: 'restoreSnapshot', actor }; });
      return this.persist(operation);
    });
  }
  async exportProject(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep(); const request = this.control.view(s => this.projectTurn(s,handle,turnId,fence,'export')); requireThat(this.dataDir,'EXPORT_UNAVAILABLE','Export storage is unavailable.');
    const snapshot = await this.content.projectSnapshot(request.projectId,request.snapshotCommit); const result = await writeProjectExport(this.dataDir,request.projectId,snapshot);
    this.sweep(); this.control.update(s => { const current = this.projectTurn(s,handle,turnId,fence,'export'); this.finish(current,'RELEASED',s); this.promote(s); }); return result;
  }
  async commitTurn(handle: string, turnId: string, fence: string, base: string, mutation: Mutation): Promise<MutationResult> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.sweep();
      const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
      const snapshot = request.resourceType === 'thread' ? await this.content.snapshot(actor.projectId, request.resourceId, 1) : await this.content.noteSnapshot(actor.projectId, request.resourceId);
      const currentRevision = snapshot.resourceType === 'thread' ? snapshot.thread.revision : snapshot.note.revision;
      requireThat(base === request.baseRevision && base === currentRevision, 'REVISION_CHANGED', 'The mutation base must match the current claimed revision.');
      const at = iso(this.clock.now()); let operation: WriteOperation;
      if (snapshot.resourceType === 'thread') {
        requireThat(threadMutationKinds.includes(mutation.kind), 'RESOURCE_TYPE_MISMATCH', 'This mutation does not apply to a thread.');
        if (mutation.kind === 'retractMessage' || mutation.kind === 'reinstateMessage') {
          const current = await this.content.snapshot(actor.projectId,request.resourceId,1_000_000);
          const message = current.messages.find(value => value.id === mutation.messageId);
          requireThat(message, 'NOT_FOUND', 'Message not found in this thread.');
          requireThat(mutation.kind === 'retractMessage' ? !message.retracted : message.retracted, 'NO_CHANGE', `The message is already ${mutation.kind === 'retractMessage' ? 'retracted' : 'visible'}.`);
        }
        const thread = prepareMutation(snapshot.thread, mutation as ThreadMutation);
        operation = { id: uid(), actor, resourceId: request.resourceId, resourceType: 'thread', at, thread, mutation: mutation as ThreadMutation };
      } else {
        requireThat(!threadMutationKinds.includes(mutation.kind), 'RESOURCE_TYPE_MISMATCH', 'This mutation does not apply to a note.');
        const noteMutation = mutation as NoteMutation;
        const note = prepareNote(snapshot.note, noteMutation, actor, at);
        await this.validateLinks(actor.projectId, note.links);
        operation = { id: uid(), actor, resourceId: request.resourceId, resourceType: 'note', at, note, mutation: noteMutation };
      }
      this.control.update(state => {
        const current = this.claimed(state, handle, turnId, fence);
        current.state = 'COMMITTING';
        state.pending[operation.id] = { id: operation.id, projectId: actor.projectId, resourceId: request.resourceId,
          resourceType: request.resourceType, turnRequestId: request.id, startingHead: snapshot.commit, kind: mutation.kind, actor };
      });
      return this.persist(operation);
    });
  }
  private finalize(pending: PendingCommit, result?: StorageResult): void {
    this.control.update(state => {
      if (pending.turnRequestId) {
        const request = state.requests[pending.turnRequestId]!;
        this.finish(request, result ? 'COMMITTED' : 'FAILED', state);
        if (result) request.result = result;
      }
      if (result && pending.resourceType !== 'project' && !state.resources[pending.resourceId]) state.resources[pending.resourceId] = { id: pending.resourceId, projectId: pending.projectId, type: pending.resourceType, fence: '0', queueSequence: '0', present: true };
      if (result && 'changes' in result) {
        for (const change of result.changes) {
          const resource = state.resources[change.resourceId] ?? { id: change.resourceId, projectId: pending.projectId, type: change.resourceType, fence: '0', queueSequence: '0', present: true };
          resource.type = change.resourceType; resource.present = change.action !== 'delete'; state.resources[change.resourceId] = resource;
          if (change.action === 'delete') for (const request of values(state.requests).filter(value => value.resourceId === change.resourceId && activeStates.includes(value.state))) this.finish(request,'FAILED',state);
        }
      }
      delete state.pending[pending.id];
      this.promote(state);
    });
  }
  private persist(operation: WriteOperation): Promise<MutationResult>;
  private persist(operation: ProjectRestoreOperation): Promise<ProjectRestoreResult>;
  private async persist(operation: WriteOperation | ProjectRestoreOperation): Promise<StorageResult> {
    const pending = this.control.view(s => s.pending[operation.id]!);
    try {
      const result = await this.content.write(operation);
      this.finalize(pending, result);
      return result;
    } catch {
      // Never replay a write: inspect its operation marker and committed head instead.
      this.control.update(s => { s.projects[pending.projectId]!.recovering = true; });
      let resolution;
      try { resolution = await this.content.resolve(pending); } catch { resolution = { state: 'unknown' as const }; }
      if (resolution.state === 'committed') {
        this.finalize(pending, resolution.result);
        this.control.update(s => { s.projects[pending.projectId]!.recovering = false; this.promote(s); });
        return resolution.result;
      }
      if (resolution.state === 'absent') {
        this.finalize(pending);
        this.control.update(s => { s.projects[pending.projectId]!.recovering = false; this.promote(s); });
        throw new BassfishError('WRITE_FAILED', 'The write was proven absent. No content mutation was retried.');
      }
      throw new BassfishError('OUTCOME_UNKNOWN', 'Storage outcome is unresolved. The project remains protected.');
    }
  }
  async recover(projectId: string): Promise<void> {
    for (const pending of this.control.view(s => values(s.pending).filter(p => p.projectId === projectId))) {
      const result = await this.content.resolve(pending);
      if (result.state === 'unknown') return;
      this.finalize(pending, result.state === 'committed' ? result.result : undefined);
    }
    this.control.update(s => { s.projects[projectId]!.recovering = false; this.promote(s); });
  }
  inspect(): unknown { this.sweep(); return this.control.view(s => ({ epoch: this.epoch, projects: values(s.projects), turns: values(s.requests).map(r => ({ ...this.statusIn(s, r), projectId: r.projectId, turnId: r.turnId, identityId: r.identityId, instanceId: r.instanceId })) })); }
  hasPendingWork(): boolean { return this.control.view(s => values(s.requests).some(r => activeStates.includes(r.state)) || values(s.pending).length > 0 || values(s.projects).some(p => p.recovering)); }
  forceRelease(turnId: string): void {
    this.sweep();
    this.control.update(state => {
      const request = values(state.requests).find(r => r.turnId === turnId);
      requireThat(request?.state === 'CLAIMED', 'NOT_CLAIMED', 'Only a claimed turn can be force-released; committing writes are protected.');
      this.finish(request, 'RELEASED', state); this.promote(state);
    });
  }
  async call(handle: string, name: string, input: unknown, signal?: AbortSignal, options: { taskCapable?: boolean } = {}): Promise<unknown> {
    requireThat(Object.hasOwn(schemas, name), 'UNKNOWN_TOOL', 'Unknown Bassfish operation.');
    const parsed = schemas[name as ToolName].safeParse(input);
    requireThat(parsed.success, 'INVALID_ARGUMENT', 'Arguments do not match the operation schema.');
    this.heartbeat(handle);
    const args = parsed.data as Record<string, unknown>;
    switch (name as ToolName) {
      case 'getSession': return this.info(handle);
      case 'setAgentName': return this.requestName(handle, args.name as string);
      case 'listAgents': return this.control.view(s => { const actor = this.actor(s, handle); return { agents: values(s.identities).filter(i => i.projectId === actor.projectId).map(i => ({ identityId: i.id, name: i.name, active: values(s.instances).some(a => a.identityId === i.id && a.active) })) }; });
      case 'createThread': return this.createThread(handle, args.title as string, args.description as string);
      case 'listThreads': {
        const actor = this.control.view(s => { const a = this.actor(s, handle); this.ready(s, a.projectId); return a; });
        const cursor = decodeCursor(args.cursor);
        let threads = sortThreads(await this.content.listThreads(actor.projectId)).filter(thread => thread.state === args.state);
        if (args.creatorIdentityId) threads = threads.filter(thread => thread.creator === args.creatorIdentityId);
        if (args.titlePrefix) threads = threads.filter(thread => thread.title.startsWith(args.titlePrefix as string));
        if (cursor) threads = threads.filter(thread => thread.createdAt > cursor[0] || (thread.createdAt === cursor[0] && thread.id > cursor[1]));
        const limit = args.limit as number; const page = threads.slice(0, limit); const last = page.at(-1);
        return { threads: page, nextCursor: threads.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null };
      }
      case 'getThread': {
        const actor = this.control.view(s => { const a = this.actor(s, handle); this.ready(s, a.projectId); return a; });
        const thread = (await this.content.listThreads(actor.projectId)).find(value => value.id === args.threadId);
        requireThat(thread, 'NOT_FOUND', 'Thread not found in this project.');
        return thread;
      }
      case 'searchThreads': {
        const actor = this.control.view(s => { const a = this.actor(s, handle); this.ready(s, a.projectId); return a; }); const query = String(args.query).toLowerCase();
        const threads = sortThreads(await this.content.listThreads(actor.projectId)).filter(thread => thread.state === args.state && [thread.title, thread.description].some(value => value.toLowerCase().includes(query))).slice(0, args.limit as number);
        return { threads };
      }
      case 'createNote': return this.createNote(handle, args as never);
      case 'listNotes': {
        const actor = this.control.view(s => { const a = this.actor(s, handle); this.ready(s, a.projectId); return a; });
        const cursor = decodeCursor(args.cursor);
        let notes = (await this.content.listNotes(actor.projectId)).filter(note => note.state === args.state);
        if (args.pathPrefix) notes = notes.filter(note => note.path.startsWith(args.pathPrefix as string));
        if (args.label) notes = notes.filter(note => note.labels.includes(args.label as string));
        if (args.noteKind) notes = notes.filter(note => note.kind === args.noteKind);
        if (args.creatorIdentityId) notes = notes.filter(note => note.creator === args.creatorIdentityId);
        if (cursor) notes = notes.filter(note => note.path > cursor[0] || (note.path === cursor[0] && note.id > cursor[1]));
        const limit = args.limit as number; const page = notes.slice(0, limit); const last = page.at(-1);
        return { notes: page.map(note => this.noteMetadata(note)), nextCursor: notes.length > limit && last ? encodeCursor([last.path,last.id]) : null };
      }
      case 'searchNotes': {
        const actor = this.control.view(s => { const a = this.actor(s,handle); this.ready(s,a.projectId); return a; }); const query = String(args.query).toLowerCase();
        const notes = (await this.content.listNotes(actor.projectId)).filter(note => note.state === args.state && [note.path,note.title,...note.labels,note.kind ?? ''].some(value => value.toLowerCase().includes(query))).slice(0,args.limit as number);
        return { notes: notes.map(note => this.noteMetadata(note)) };
      }
      case 'requestTurn': {
        const target = args.target as { type: ResourceType; id?: string; purpose?: TurnRequest['purpose'] };
        const mode = options.taskCapable ? 'task' : 'ticket';
        const result = target.type === 'project' ? await this.requestProjectTurn(handle,target.purpose,mode) : await this.requestResourceTurn(handle,target.type,target.id!,mode);
        const task = this.control.view(state => values(state.tasks).find(value => value.requestId === result.requestId));
        return task?.status === 'working' ? { task: this.taskView(task) } : result;
      }
      case 'getTurnRequest': return this.status(handle,args.requestId as string);
      case 'waitForTurn': return this.waitForTurn(handle,args.requestId as string,args.timeoutMs as number,signal);
      case 'cancelTurnRequest': return this.cancelTurnRequest(handle,args.requestId as string);
      case 'claimTurn': return this.claimTurn(handle,args.offerId as string,20);
      case 'readTurn': { const credential = args.turn as { id: string; fencingToken: string }; return this.readTurn(handle,credential.id,credential.fencingToken,args.cursor as string | undefined); }
      case 'releaseTurn': { const credential = args.turn as { id: string; fencingToken: string }; return this.releaseTurn(handle,credential.id,credential.fencingToken); }
      case 'commitTurn': { const credential = args.turn as { id: string; fencingToken: string }; return this.commitTurn(handle,credential.id,credential.fencingToken,args.baseRevision as string,toMutation(args.mutation as Record<string,unknown>)); }
      case 'getNoteOutline': { const credential = args.turn as { id: string; fencingToken: string }; return this.noteOutline(handle,credential.id,credential.fencingToken); }
      case 'findInNote': { const credential = args.turn as { id: string; fencingToken: string }; return this.findNote(handle,credential.id,credential.fencingToken,args.query as string,args.mode as 'literal'|'regex',args.limit as number); }
      case 'inspectSnapshot': { const credential = args.turn as { id: string; fencingToken: string }; return this.projectSnapshotInfo(handle,credential.id,credential.fencingToken); }
      case 'searchProjectNotes': { const credential = args.turn as { id: string; fencingToken: string }; return this.projectSearch(handle,credential.id,credential.fencingToken,args.query as string,args.states as string[],args.limit as number,args.cursor as string | undefined); }
      case 'searchProjectNoteHistory': { const credential = args.turn as { id: string; fencingToken: string }; return this.projectHistorySearch(handle,credential.id,credential.fencingToken,args.query as string,args.noteId as string | undefined,args.states as string[],args.limit as number,args.cursor as string | undefined); }
      case 'exportSnapshot': { const credential = args.turn as { id: string; fencingToken: string }; return this.exportProject(handle,credential.id,credential.fencingToken); }
      case 'listSnapshotHistory': { const credential = args.turn as { id: string; fencingToken: string }; return this.projectHistoryList(handle,credential.id,credential.fencingToken,args.limit as number,args.cursor as string | undefined); }
      case 'previewSnapshotRestore': { const credential = args.turn as { id: string; fencingToken: string }; return this.previewProjectRestore(handle,credential.id,credential.fencingToken,args.targetCommit as string,args.limit as number,args.cursor as string | undefined); }
      case 'restoreSnapshot': { const credential = args.turn as { id: string; fencingToken: string }; return this.restoreProject(handle,credential.id,credential.fencingToken,args.previewToken as string); }
      case 'listHistory': { const credential = args.turn as { id: string; fencingToken: string }; return this.resourceHistory(handle,credential.id,credential.fencingToken,args.offset as number,args.limit as number); }
      case 'readRevision': { const credential = args.turn as { id: string; fencingToken: string }; return this.resourceAt(handle,credential.id,credential.fencingToken,args.revision as string,20,args.cursor as string | undefined); }
      case 'diffRevision': { const credential = args.turn as { id: string; fencingToken: string }; return this.diffResource(handle,credential.id,credential.fencingToken,args.revision as string); }
      case 'previewRestore': { const credential = args.turn as { id: string; fencingToken: string }; return this.previewRestore(handle,credential.id,credential.fencingToken,args.revision as string); }
      case 'restoreRevision': { const credential = args.turn as { id: string; fencingToken: string }; return this.restoreRevision(handle,credential.id,credential.fencingToken,args.previewToken as string); }
    }
  }
}
