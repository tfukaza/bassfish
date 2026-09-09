import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BassfishError, activeStates, increment, prepareMutation, requireThat } from './domain.js';
import type {
  Actor,
  AgentHost,
  Clock,
  ContentStore,
  ControlState,
  ControlStore,
  DurableTask,
  TurnRequest,
  Instance,
  Mutation,
  MutationResult,
  ContentTurnRequest,
  FileTurnRequest,
  FileTarget,
  NotificationIntent,
  NotificationReason,
  PendingCommit,
  ProjectRestoreOperation,
  ProjectRestoreResult,
  ResourceType,
  StorageResult,
  Thread,
  ThreadMutation,
  Ticket,
  TicketMutation,
  WriteOperation,
} from './domain.js';
import { KeyedMutex } from './runtime.js';
import { adminSchemas } from './admin-api.js';
import type { AdminToolName } from './admin-api.js';
import { nameSchema } from './contracts.js';
import { outline } from './markdown.js';
import { fileSetsOverlap, resolveFileTargets } from './files.js';
import {
  normalizeDependencies,
  prepareTicket,
  ticketStatuses,
  validateTicketGraph,
} from './ticket.js';
import { exportProject as writeProjectExport } from './export.js';
import { RE2 } from 're2-wasm';
import { selectGeneratedAgentName } from './agent-names.js';
import { mcpSchemas } from './mcp-api.js';
import type { McpToolName } from './mcp-api.js';
import { presentClaim, presentTurnStatus } from './mcp-presenters.js';
import {
  finishRequest,
  materializeRequestOffer,
  pendingFor,
  promoteFileRequests,
  promoteRequests,
} from './service/turn-state.js';
import {
  compare,
  decodeCursor,
  describeTicket,
  describeTickets,
  encodeCursor,
  sortThreads,
} from './service/resources.js';
import {
  isWorkNotification,
  notificationPriority,
  presentNotification,
  WakeSignals,
} from './service/notifications.js';
import { dispatchAdmin } from './service/admin-dispatch.js';
import { dispatchMcp } from './service/mcp-dispatch.js';
import { buildProjectRestore } from './service/project-restore.js';

export interface Limits {
  offerMs: number;
  turnTimeoutMs: number;
  reconnectMs: number;
  instanceMs: number;
  queueMs: number;
  retentionMs: number;
  waitMs: number;
}
export const defaultLimits: Limits = {
  offerMs: 30_000,
  turnTimeoutMs: 60_000,
  reconnectMs: 30_000,
  instanceMs: 20_000,
  queueMs: 3_600_000,
  retentionMs: 3_600_000,
  waitMs: 20_000,
};
const values = Object.values;
const uid = () => randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();
const followKey = (projectId: string, threadId: string, identityId: string) =>
  `${projectId}:${threadId}:${identityId}`;
const hostSessionKey = (projectId: string, host: AgentHost, sessionId: string) =>
  `${projectId}:${host}:${sessionId}`;
const threadMutationKinds = [
  'appendMessage',
  'renameThread',
  'setThreadDescription',
  'archiveThread',
  'activateThread',
  'deleteThread',
  'retractMessage',
  'reinstateMessage',
];
const ticketMutationKinds = [
  'updateTicket',
  'replaceTicketBody',
  'appendTicketBody',
  'patchTicketBody',
];

/** Application service: all coordination is persisted by ControlStore; all content uses ContentStore. */
export class Bassfish {
  readonly epoch = uid();
  readonly limits: Limits;
  private readonly writers = new KeyedMutex();
  private readonly taskAcquisitions = new KeyedMutex();
  private readonly restoreSecret = randomBytes(32);
  private readonly wakeSignals = new WakeSignals();
  constructor(
    readonly control: ControlStore,
    readonly content: ContentStore,
    readonly clock: Clock,
    limits: Partial<Limits> = {},
    private readonly dataDir?: string,
    private readonly selectAgentName: (
      usedNames: Iterable<string>,
    ) => string | undefined = selectGeneratedAgentName,
  ) {
    this.limits = { ...defaultLimits, ...limits };
  }

  async initialize(): Promise<void> {
    const now = this.clock.now();
    this.control.update(state => {
      for (const instance of values(state.instances)) instance.active = false;
      for (const request of values(state.requests)) {
        if (request.resourceType === 'files') {
          if (activeStates.includes(request.state))
            this.finish(request, 'EXPIRED', state, 'daemon_restart');
          continue;
        }
        if (request.state === 'QUEUED' || request.state === 'READY')
          request.reconnectUntil = Math.min(request.queueUntil, now + this.limits.reconnectMs);
        if (request.state === 'READY') request.state = 'QUEUED';
        if (request.state === 'OFFERED' || request.state === 'CLAIMED')
          this.finish(request, 'EXPIRED', state);
      }
      for (const project of values(state.projects)) project.recovering = true;
    });
    for (const project of this.control.view(s => values(s.projects))) {
      try {
        await this.content.ensureProject(project.id);
        await this.recover(project.id);
      } catch {
        /* Preserve PROJECT_RECOVERING; metadata diagnostics must remain available. */
      }
    }
  }

  async open(
    commonDir: string,
    preferredName?: string,
    native?: { host: AgentHost },
    workspace = commonDir,
    hostSessionId?: string,
  ): Promise<{ agentHandle: string; session: unknown }> {
    if (preferredName) nameSchema.parse(preferredName);
    const project = this.control.update(state => {
      let project = values(state.projects).find(p => p.commonDir === commonDir);
      if (!project) {
        project = { id: `p_${uid().replaceAll('-', '')}`, commonDir, recovering: true };
        state.projects[project.id] = project;
      }
      return project;
    });
    await this.writers.run(project.id, async () => {
      await this.content.ensureProject(project.id);
      await this.recover(project.id);
    });
    this.sweep();
    const handle = uid();
    this.control.update(state => {
      const key =
        native && hostSessionId
          ? hostSessionKey(project.id, native.host, hostSessionId)
          : undefined;
      let binding = key ? state.hostSessionBindings[key] : undefined;
      let identity = binding ? state.identities[binding.identityId] : undefined;
      requireThat(
        !binding || identity,
        'SESSION_BINDING_INVALID',
        'The host session binding is invalid.',
      );
      if (!identity) {
        const name =
          preferredName ??
          this.selectAgentName(
            values(state.identities)
              .filter(candidate => candidate.projectId === project.id)
              .map(candidate => candidate.name),
          );
        requireThat(
          name,
          'NAME_POOL_EXHAUSTED',
          'All generated agent names are registered in this repository; provide an explicit name.',
        );
        identity = values(state.identities).find(
          candidate =>
            candidate.projectId === project.id &&
            candidate.name.toLowerCase() === name.toLowerCase(),
        );
        if (identity) {
          const reserved = values(state.hostSessionBindings).some(
            candidate =>
              candidate.projectId === project.id && candidate.identityId === identity!.id,
          );
          requireThat(
            !reserved,
            'NAME_BOUND_TO_SESSION',
            'This name belongs to another host session.',
          );
        } else {
          identity = { id: uid(), projectId: project.id, name };
          state.identities[identity.id] = identity;
        }
      }
      if (!binding)
        requireThat(
          !values(state.instances).some(i => i.identityId === identity.id && i.active),
          'NAME_IN_USE',
          'This identity has a live adapter instance.',
        );
      if (key && native && hostSessionId && !binding) {
        const now = this.clock.now();
        binding = {
          projectId: project.id,
          identityId: identity.id,
          host: native.host,
          sessionId: hostSessionId,
          wakeKey: uid(),
          createdAt: now,
          updatedAt: now,
        };
        state.hostSessionBindings[key] = binding;
      } else if (
        binding &&
        !values(state.instances).some(i => i.identityId === identity.id && i.active)
      ) {
        binding.wakeKey = uid();
        binding.updatedAt = this.clock.now();
      }
      const instance: Instance = {
        id: uid(),
        projectId: project.id,
        identityId: identity.id,
        handle,
        epoch: this.epoch,
        active: true,
        lastSeen: this.clock.now(),
        workspace,
        ...(native
          ? {
              host: native.host,
              ...(hostSessionId ? { hostSessionId } : {}),
            }
          : {}),
      };
      state.instances[instance.id] = instance;
      this.rebind(state, instance);
      this.promote(state);
    });
    return { agentHandle: handle, session: this.info(handle) };
  }

  actor(state: ControlState, handle: string): Actor {
    const instance = values(state.instances).find(
      i => i.handle === handle && i.active && i.epoch === this.epoch,
    );
    requireThat(
      instance,
      'SESSION_EXPIRED',
      'Open a new Bassfish instance; this handle is no longer current.',
    );
    const identity = state.identities[instance.identityId]!;
    return {
      projectId: instance.projectId,
      instanceId: instance.id,
      identityId: identity.id,
      name: identity.name,
    };
  }
  ready(state: ControlState, projectId: string): void {
    requireThat(
      state.projects[projectId] && !state.projects[projectId].recovering,
      'PROJECT_RECOVERING',
      'The project has an unresolved storage operation.',
    );
  }
  private creationAllowed(state: ControlState, projectId: string): void {
    this.ready(state, projectId);
    requireThat(
      !values(state.requests).some(
        request =>
          request.projectId === projectId &&
          request.resourceType === 'project' &&
          activeStates.includes(request.state),
      ),
      'PROJECT_TURN_PENDING',
      'A project turn is queued or active; create the resource after it finishes.',
    );
  }
  private finish(
    request: TurnRequest,
    state: 'EXPIRED' | 'CANCELLED' | 'RELEASED' | 'FAILED' | 'COMMITTED',
    control?: ControlState,
    reason?: string,
  ): void {
    request.terminalReason =
      reason ??
      {
        EXPIRED: 'deadline_elapsed',
        CANCELLED: 'cancelled',
        RELEASED: 'released_by_owner',
        FAILED: 'operation_failed',
        COMMITTED: 'committed',
      }[state];
    finishRequest(request, state, this.clock.now(), this.limits.retentionMs, control);
  }
  private disconnectIn(state: ControlState, instance: Instance, clean: boolean): void {
    instance.active = false;
    for (const request of values(state.requests).filter(r => r.instanceId === instance.id)) {
      if (request.resourceType === 'files') {
        if (activeStates.includes(request.state))
          this.finish(
            request,
            clean ? 'CANCELLED' : 'EXPIRED',
            state,
            clean ? 'session_closed' : 'session_lost',
          );
        continue;
      }
      if (request.state === 'QUEUED') {
        if (clean) this.finish(request, 'CANCELLED', state);
        else
          request.reconnectUntil = Math.min(
            request.queueUntil,
            this.clock.now() + this.limits.reconnectMs,
          );
      }
      if (request.state === 'READY') {
        if (clean) this.finish(request, 'CANCELLED', state);
        else {
          request.state = 'QUEUED';
          request.updatedAt = this.clock.now();
          request.reconnectUntil = Math.min(
            request.queueUntil,
            this.clock.now() + this.limits.reconnectMs,
          );
        }
      }
      if (request.state === 'CLAIMED' || request.state === 'OFFERED')
        this.finish(request, clean ? 'RELEASED' : 'EXPIRED', state);
    }
  }
  disconnect(handle: string, clean = true): void {
    this.control.update(state => {
      const instance = values(state.instances).find(
        i => i.handle === handle && i.epoch === this.epoch,
      );
      if (instance) this.disconnectIn(state, instance, clean);
      this.promote(state);
    });
  }
  heartbeat(handle: string): void {
    this.sweep();
    this.control.update(state => {
      const actor = this.actor(state, handle);
      state.instances[actor.instanceId]!.lastSeen = this.clock.now();
    });
  }
  sweep(): void {
    const now = this.clock.now();
    const wall = this.clock.wallNow();
    const clockChanged = this.clock.discontinuity();
    this.control.update(state => {
      const discontinuity =
        clockChanged ||
        (state.wallClockHighWaterMs > 0 && wall + 2_000 < state.wallClockHighWaterMs);
      state.wallClockHighWaterMs = Math.max(state.wallClockHighWaterMs, wall);
      for (const instance of values(state.instances))
        if (instance.active && now - instance.lastSeen >= this.limits.instanceMs)
          this.disconnectIn(state, instance, false);
      for (const request of values(state.requests)) {
        if (
          (request.state === 'QUEUED' || request.state === 'READY') &&
          (now >= request.queueUntil ||
            (request.reconnectUntil !== undefined && now >= request.reconnectUntil))
        )
          this.finish(request, 'EXPIRED', state);
        if (request.state === 'READY' && discontinuity) this.finish(request, 'EXPIRED', state);
        if (request.state === 'OFFERED' && (discontinuity || now >= request.claimBy!))
          this.finish(request, 'EXPIRED', state);
        if (
          request.resourceType !== 'files' &&
          request.state === 'CLAIMED' &&
          (discontinuity || now >= request.expiresAt!)
        )
          this.finish(request, 'EXPIRED', state);
        if (request.finishedAt !== undefined && now - request.finishedAt >= this.limits.retentionMs)
          delete state.requests[request.id];
      }
      for (const task of values(state.tasks))
        if (now >= task.discardAt) delete state.tasks[task.id];
      this.promote(state);
    });
  }
  private promote(state: ControlState): void {
    promoteRequests(state, this.clock.now(), this.limits.offerMs, uid);
  }
  private promoteFiles(state: ControlState): void {
    promoteFileRequests(state, this.clock.now(), this.limits.offerMs, uid);
  }

  async requestFileTurn(
    handle: string,
    targets: FileTarget[],
    deliveryMode: 'ticket' | 'task' = 'ticket',
  ): Promise<Record<string, unknown>> {
    this.sweep();
    const workspace = this.control.view(
      state => state.instances[this.actor(state, handle).instanceId]!.workspace,
    );
    const paths = await resolveFileTargets(workspace, targets);
    this.sweep();
    const id = this.control.update(state => {
      const actor = this.actor(state, handle);
      requireThat(
        !pendingFor(state, actor.instanceId).some(request => request.resourceType === 'files'),
        'TURN_REQUEST_EXISTS',
        'This session already has a pending or held file set. Release it before acquiring another.',
      );
      state.fileQueueSequence = increment(state.fileQueueSequence);
      const now = this.clock.now();
      const request: FileTurnRequest = {
        id: uid(),
        projectId: actor.projectId,
        identityId: actor.identityId,
        instanceId: actor.instanceId,
        resourceType: 'files',
        paths,
        sequence: state.fileQueueSequence,
        state: 'QUEUED',
        createdAt: now,
        updatedAt: now,
        queueUntil: now + this.limits.queueMs,
        deliveryMode,
      };
      state.requests[request.id] = request;
      if (deliveryMode === 'task')
        state.tasks[request.id] = {
          id: request.id,
          projectId: actor.projectId,
          identityId: actor.identityId,
          requestId: request.id,
          status: 'working',
          statusMessage: 'Waiting for the file set.',
          createdAt: now,
          updatedAt: now,
          discardAt: request.queueUntil,
        };
      this.promoteFiles(state);
      if (deliveryMode === 'task' && request.state === 'READY') {
        this.materializeOffer(state, request);
        delete state.tasks[request.id];
        request.deliveryMode = 'ticket';
      }
      return request.id;
    });
    return this.status(handle, id);
  }

  private fileClaim(request: FileTurnRequest): Record<string, unknown> {
    return {
      state: 'claimed',
      requestId: request.id,
      target: { type: 'files', paths: request.paths },
      turn: { id: request.turnId },
      lifetime: 'session',
    };
  }

  private claimedFiles(state: ControlState, handle: string, turnToken: string): FileTurnRequest {
    const actor = this.actor(state, handle);
    const request = values(state.requests).find(value => value.turnId === turnToken);
    requireThat(
      request &&
        request.projectId === actor.projectId &&
        request.instanceId === actor.instanceId &&
        request.identityId === actor.identityId,
      'NOT_TURN_OWNER',
      'The file turn is not bound to this session.',
    );
    requireThat(
      request.resourceType === 'files',
      'RESOURCE_TYPE_MISMATCH',
      'A file turn is required.',
    );
    requireThat(
      request.state === 'CLAIMED',
      'STALE_TURN',
      'This file turn is no longer held. Acquire a new set and reread its files before editing.',
    );
    return request;
  }

  private claimFiles(handle: string, offerId: string): Record<string, unknown> {
    return this.control.update(state => {
      const actor = this.actor(state, handle);
      const request = values(state.requests).find(value => value.offerId === offerId);
      requireThat(
        request &&
          request.resourceType === 'files' &&
          request.instanceId === actor.instanceId &&
          request.projectId === actor.projectId,
        'NOT_TURN_OWNER',
        'The file offer is not bound to this session.',
      );
      requireThat(
        request.state !== 'EXPIRED' && this.clock.now() < request.claimBy!,
        'OFFER_EXPIRED',
        'The offer claim window has elapsed.',
      );
      requireThat(
        request.state === 'OFFERED',
        'OFFER_UNAVAILABLE',
        'The file offer is no longer available.',
      );
      request.state = 'CLAIMED';
      request.turnId = uid();
      request.updatedAt = this.clock.now();
      return this.fileClaim(request);
    });
  }

  releaseFiles(handle: string, turnToken: string): { released: true } {
    this.sweep();
    return this.control.update(state => {
      this.finish(this.claimedFiles(state, handle, turnToken), 'RELEASED', state);
      this.promoteFiles(state);
      return { released: true };
    });
  }
  private materializeOffer(state: ControlState, request: TurnRequest): void {
    materializeRequestOffer(state, request, this.clock.now(), this.limits.offerMs, uid);
  }
  private rebind(state: ControlState, instance: Instance): void {
    const request = values(state.requests)
      .filter(
        candidate =>
          candidate.resourceType !== 'files' &&
          candidate.identityId === instance.identityId &&
          (candidate.state === 'QUEUED' || candidate.state === 'READY') &&
          candidate.reconnectUntil !== undefined &&
          candidate.reconnectUntil > this.clock.now(),
      )
      .sort((left, right) => {
        const created = left.createdAt - right.createdAt;
        if (created) return created;
        const leftSequence = BigInt(left.sequence);
        const rightSequence = BigInt(right.sequence);
        return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
      })[0];
    if (request) {
      request.instanceId = instance.id;
      delete request.reconnectUntil;
    }
  }
  info(handle: string): unknown {
    this.sweep();
    return this.control.view(state => {
      const actor = this.actor(state, handle);
      return {
        projectId: actor.projectId,
        identityId: actor.identityId,
        adapterInstanceId: actor.instanceId,
        name: actor.name,
        recovering: state.projects[actor.projectId]!.recovering,
        pendingRequests: pendingFor(state, actor.instanceId).map(r => this.statusIn(state, r)),
        pendingCommits: values(state.pending)
          .filter(p => p.actor.identityId === actor.identityId)
          .map(p => ({ operationId: p.id, resourceId: p.resourceId })),
        unreadNotificationCount: values(state.notifications).filter(
          n => n.projectId === actor.projectId && n.identityId === actor.identityId,
        ).length,
      };
    });
  }
  private followIn(state: ControlState, actor: Actor, threadId: string): void {
    state.follows[followKey(actor.projectId, threadId, actor.identityId)] ??= {
      projectId: actor.projectId,
      threadId,
      identityId: actor.identityId,
      createdAt: this.clock.now(),
    };
  }
  async followThread(handle: string, threadId: string): Promise<unknown> {
    const actor = this.control.view(state => this.actor(state, handle));
    requireThat(
      (await this.content.listThreads(actor.projectId)).some(thread => thread.id === threadId),
      'NOT_FOUND',
      'Thread not found in this project.',
    );
    return this.control.update(state => {
      const current = this.actor(state, handle);
      this.followIn(state, current, threadId);
      return { threadId, following: true };
    });
  }
  async unfollowThread(handle: string, threadId: string): Promise<unknown> {
    const actor = this.control.view(state => this.actor(state, handle));
    requireThat(
      (await this.content.listThreads(actor.projectId)).some(thread => thread.id === threadId),
      'NOT_FOUND',
      'Thread not found in this project.',
    );
    return this.control.update(state => {
      const current = this.actor(state, handle);
      delete state.follows[followKey(current.projectId, threadId, current.identityId)];
      return { threadId, following: false };
    });
  }
  listAgents(handle: string, onlineOnly: boolean, includeSelf: boolean): unknown {
    return this.control.view(state => {
      const actor = this.actor(state, handle);
      const agents = values(state.identities)
        .filter(
          identity =>
            identity.projectId === actor.projectId &&
            (includeSelf || identity.id !== actor.identityId),
        )
        .map(identity => {
          const instances = values(state.instances)
            .filter(instance => instance.identityId === identity.id)
            .sort((a, b) => b.lastSeen - a.lastSeen);
          const active = instances.find(instance => instance.active);
          const latest = active ?? instances[0];
          return {
            identityId: identity.id,
            name: identity.name,
            online: Boolean(active),
            lastSeenAt: latest ? iso(latest.lastSeen) : null,
            host: active?.host ?? null,
            self: identity.id === actor.identityId,
          };
        })
        .filter(agent => !onlineOnly || agent.online);
      return { agents };
    });
  }
  private async presentNotifications(items: import('./domain.js').Notification[]) {
    return Promise.all(
      items.map(async item => {
        if (item.resourceType === 'thread') {
          try {
            const snapshot = await this.content.snapshot(
              item.projectId,
              item.resourceId,
              1,
              item.sequence ? increment(item.sequence) : undefined,
            );
            const message = snapshot.messages.find(candidate => candidate.id === item.messageId);
            return presentNotification(item, {
              kind: 'thread_message',
              threadTitle: snapshot.thread.title,
              body: message?.body ?? '',
              retracted: Boolean(message?.retracted || !message),
            });
          } catch {
            return presentNotification(item, {
              kind: 'thread_message',
              threadTitle: 'Unavailable thread',
              body: '',
              retracted: true,
            });
          }
        }
        try {
          const snapshot = await this.content.ticketSnapshot(item.projectId, item.resourceId);
          return presentNotification(item, {
            kind: 'ticket_summary',
            title: snapshot.ticket.title,
            state: snapshot.ticket.state,
            owner: snapshot.ticket.ownerName,
          });
        } catch {
          return presentNotification(item, {
            kind: 'ticket_summary',
            title: 'Unavailable ticket',
            state: 'unknown',
            owner: 'unknown',
          });
        }
      }),
    );
  }
  async listNotifications(handle: string, limit: number, cursor?: string): Promise<unknown> {
    let after: [number, number, string] | undefined;
    if (cursor) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw new BassfishError('INVALID_CURSOR', 'The notification cursor is invalid.');
      }
      requireThat(
        Array.isArray(parsed) &&
          parsed.length === 3 &&
          parsed.every((item, index) =>
            index < 2 ? Number.isInteger(item) : typeof item === 'string',
          ),
        'INVALID_CURSOR',
        'The notification cursor is invalid.',
      );
      after = parsed as [number, number, string];
    }
    const page = this.control.view(state => {
      const actor = this.actor(state, handle);
      let notifications = values(state.notifications)
        .filter(item => item.projectId === actor.projectId && item.identityId === actor.identityId)
        .sort(
          (a, b) =>
            notificationPriority(a) - notificationPriority(b) ||
            a.createdAt - b.createdAt ||
            compare(a.id, b.id),
        );
      if (after)
        notifications = notifications.filter(item => {
          const priority = notificationPriority(item);
          return (
            priority > after![0] ||
            (priority === after![0] &&
              (item.createdAt > after![1] || (item.createdAt === after![1] && item.id > after![2])))
          );
        });
      const page = notifications.slice(0, limit);
      const last = page.at(-1);
      return {
        notifications: page,
        nextCursor:
          notifications.length > limit && last
            ? Buffer.from(
                JSON.stringify([notificationPriority(last), last.createdAt, last.id]),
              ).toString('base64url')
            : null,
      };
    });
    return { ...page, notifications: await this.presentNotifications(page.notifications) };
  }
  private async workNotifications(
    handle: string,
    limit = 100,
  ): Promise<{ notifications: Record<string, unknown>[]; moreAvailable: boolean }> {
    const batch = this.control.view(state => {
      const actor = this.actor(state, handle);
      const matching = values(state.notifications)
        .filter(
          item =>
            item.projectId === actor.projectId &&
            item.identityId === actor.identityId &&
            isWorkNotification(item),
        )
        .sort(
          (a, b) =>
            notificationPriority(a) - notificationPriority(b) ||
            a.createdAt - b.createdAt ||
            compare(a.id, b.id),
        );
      return {
        notifications: matching.slice(0, limit),
        moreAvailable: matching.length > limit,
      };
    });
    return {
      ...batch,
      notifications: await this.presentNotifications(batch.notifications),
    };
  }
  async waitForWork(handle: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
    const until = performance.now() + Math.min(timeout, 20_000);
    while (true) {
      const actor = this.control.view(state => this.actor(state, handle));
      const remaining = Math.max(0, until - performance.now());
      // Register before inspecting the inbox so a commit cannot land between
      // the empty check and waiter registration.
      const waiting = this.wakeSignals.wait(actor.identityId, remaining, signal);
      const batch = await this.workNotifications(handle);
      if (batch.notifications.length > 0 || remaining <= 0) {
        waiting.cancel();
        return batch;
      }
      await waiting.promise;
      if (performance.now() >= until) return { notifications: [], moreAvailable: false };
    }
  }
  ackNotifications(handle: string, notificationIds: string[]): unknown {
    return this.control.update(state => {
      const actor = this.actor(state, handle);
      let acknowledged = 0;
      for (const id of new Set(notificationIds)) {
        const item = state.notifications[id];
        requireThat(
          item && item.projectId === actor.projectId && item.identityId === actor.identityId,
          'NOTIFICATION_NOT_FOUND',
          'Unread notification not found for this identity.',
        );
        delete state.notifications[id];
        acknowledged++;
      }
      return {
        acknowledged,
        unreadNotificationCount: values(state.notifications).filter(
          item => item.projectId === actor.projectId && item.identityId === actor.identityId,
        ).length,
      };
    });
  }
  private signalWake(identityIds: Iterable<string>): void {
    this.wakeSignals.signal(identityIds);
  }
  private async takeDelivery(
    handle: string,
    scope: 'actionable' | 'all',
  ): Promise<{
    kind: 'actionable' | 'activity' | 'none';
    count: number;
    notificationIds: string[];
    threadIds: string[];
    ticketIds: string[];
    reasons: NotificationReason[];
    senders: string[];
    notifications: Record<string, unknown>[];
  }> {
    const empty = {
      kind: 'none' as const,
      count: 0,
      notificationIds: [],
      threadIds: [],
      ticketIds: [],
      reasons: [],
      senders: [],
      notifications: [],
    };
    const selected = this.control.update(state => {
      const actor = this.actor(state, handle);
      const binding = values(state.hostSessionBindings).find(
        candidate =>
          candidate.projectId === actor.projectId && candidate.identityId === actor.identityId,
      );
      if (!binding) return [];
      const available = values(state.notifications).filter(
        item =>
          item.identityId === actor.identityId && item.lastDeliveredWakeKey !== binding.wakeKey,
      );
      const actionable = available.filter(isWorkNotification);
      const chosen = (actionable.length ? actionable : scope === 'all' ? available : []).sort(
        (a, b) =>
          notificationPriority(a) - notificationPriority(b) ||
          a.createdAt - b.createdAt ||
          compare(a.id, b.id),
      );
      for (const item of chosen) item.lastDeliveredWakeKey = binding.wakeKey;
      return chosen;
    });
    if (!selected.length) return empty;
    return {
      kind: selected.some(isWorkNotification) ? 'actionable' : 'activity',
      count: selected.length,
      notificationIds: selected.map(item => item.id),
      threadIds: [...new Set(selected.flatMap(item => (item.threadId ? [item.threadId] : [])))],
      ticketIds: [...new Set(selected.flatMap(item => (item.ticketId ? [item.ticketId] : [])))],
      reasons: [...new Set(selected.flatMap(item => item.reasons))],
      senders: [...new Set(selected.map(item => item.senderName))],
      notifications: await this.presentNotifications(selected),
    };
  }
  async waitForDeliveryHandle(
    handle: string,
    timeout: number,
    scope: 'actionable' | 'all' = 'all',
    signal?: AbortSignal,
  ): Promise<unknown> {
    const until = performance.now() + Math.min(timeout, 20_000);
    while (true) {
      const actor = this.control.view(state => this.actor(state, handle));
      const remaining = Math.max(0, until - performance.now());
      const waiting = this.wakeSignals.wait(actor.identityId, remaining, signal);
      const batch = await this.takeDelivery(handle, scope);
      if (batch.count > 0 || remaining <= 0) {
        waiting.cancel();
        return batch;
      }
      await waiting.promise;
      if (performance.now() >= until)
        return {
          kind: 'none',
          count: 0,
          notificationIds: [],
          threadIds: [],
          ticketIds: [],
          reasons: [],
          senders: [],
          notifications: [],
        };
    }
  }
  requestName(handle: string, name: string): unknown {
    nameSchema.parse(name);
    this.sweep();
    this.control.update(state => {
      const actor = this.actor(state, handle);
      const attachedInstances = values(state.instances).filter(
        instance => instance.identityId === actor.identityId && instance.active,
      );
      requireThat(
        !values(state.requests).some(
          request =>
            request.identityId === actor.identityId && activeStates.includes(request.state),
        ) && !values(state.pending).some(p => p.actor.identityId === actor.identityId),
        'TURN_REQUEST_EXISTS',
        'Finish operations in every attachment of this identity before changing its name.',
      );
      const target = values(state.identities).find(
        i => i.projectId === actor.projectId && i.name.toLowerCase() === name.toLowerCase(),
      );
      if (target && target.id !== actor.identityId) {
        const targetBinding = values(state.hostSessionBindings).find(
          binding => binding.projectId === actor.projectId && binding.identityId === target.id,
        );
        requireThat(
          !targetBinding,
          'NAME_BOUND_TO_SESSION',
          'This name belongs to another host session.',
        );
        requireThat(
          !values(state.instances).some(i => i.identityId === target.id && i.active),
          'NAME_IN_USE',
          'This identity has a live adapter instance.',
        );
        for (const instance of attachedInstances) instance.identityId = target.id;
        const binding = values(state.hostSessionBindings).find(
          candidate =>
            candidate.projectId === actor.projectId && candidate.identityId === actor.identityId,
        );
        if (binding) {
          binding.identityId = target.id;
          binding.updatedAt = this.clock.now();
        }
      } else state.identities[actor.identityId]!.name = name;
      this.promote(state);
    });
    return this.info(handle);
  }
  private statusIn(state: ControlState, request: TurnRequest): Record<string, unknown> {
    const position = values(state.requests).filter(
      other =>
        other.state === 'QUEUED' &&
        BigInt(other.sequence) <= BigInt(request.sequence) &&
        (request.resourceType === 'files'
          ? other.resourceType === 'files' && fileSetsOverlap(other.paths, request.paths)
          : other.resourceType !== 'files' && other.resourceId === request.resourceId),
    ).length;
    const target =
      request.resourceType === 'files'
        ? { type: 'files', paths: request.paths }
        : request.resourceType === 'project'
          ? { type: 'project', purpose: request.purpose }
          : { type: request.resourceType, id: request.resourceId };
    return {
      state: request.state.toLowerCase(),
      requestId: request.id,
      target,
      ...(request.resourceType === 'files' ? { lifetime: 'session' } : {}),
      ...(request.state === 'QUEUED' ? { position } : {}),
      ...(request.state === 'OFFERED'
        ? { offerId: request.offerId, claimBy: iso(request.claimBy!) }
        : {}),
      ...(request.resourceType !== 'files' && request.expiresAt !== undefined
        ? { expiresAt: iso(request.expiresAt) }
        : {}),
      ...(request.resourceType !== 'files' && request.result ? { result: request.result } : {}),
    };
  }
  private ownRequest(state: ControlState, handle: string, ticketId: string): TurnRequest {
    const actor = this.actor(state, handle);
    const request = state.requests[ticketId];
    requireThat(
      request && request.projectId === actor.projectId && request.identityId === actor.identityId,
      'NOT_TURN_OWNER',
      'This ticket does not belong to the calling identity.',
    );
    return request;
  }
  private ownTask(state: ControlState, handle: string, taskId: string): DurableTask {
    const actor = this.actor(state, handle);
    const task = state.tasks[taskId];
    requireThat(
      task && task.projectId === actor.projectId && task.identityId === actor.identityId,
      'TASK_NOT_FOUND',
      'Task not found for this identity.',
    );
    return task;
  }
  taskView(task: DurableTask, includeResult = true): Record<string, unknown> {
    return {
      taskId: task.id,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      createdAt: iso(task.createdAt),
      lastUpdatedAt: iso(task.updatedAt),
      ttlMs: Math.max(0, task.discardAt - task.createdAt),
      pollIntervalMs: 1_000,
      ...(includeResult && task.status === 'completed' && task.result
        ? { result: task.result }
        : {}),
      ...(task.status === 'failed' && task.error ? { error: task.error } : {}),
    };
  }
  async getTask(
    handle: string,
    taskId: string,
    materialize = true,
  ): Promise<Record<string, unknown>> {
    this.sweep();
    if (!materialize)
      return this.control.view(state => this.taskView(this.ownTask(state, handle, taskId), false));
    return this.taskAcquisitions.run(taskId, async () => {
      const pending = this.control.update(state => {
        const task = this.ownTask(state, handle, taskId);
        const request = state.requests[task.requestId];
        if (task.status === 'working' && request?.state === 'READY')
          this.materializeOffer(state, request);
        if (task.status === 'working' && request?.state === 'CLAIMED') {
          task.status = 'completed';
          task.statusMessage = 'The turn is claimed.';
          task.updatedAt = this.clock.now();
          task.discardAt = task.updatedAt + this.limits.retentionMs;
          task.result = { requestId: request.id };
        }
        return {
          task: structuredClone(task),
          request: request ? structuredClone(request) : undefined,
        };
      });
      if (pending.task.status === 'working' && pending.request?.state === 'OFFERED') {
        try {
          await this.claimTurn(handle, pending.request.offerId!, 20);
          this.control.update(state => {
            const task = this.ownTask(state, handle, taskId);
            const request = state.requests[task.requestId];
            requireThat(
              request?.state === 'CLAIMED',
              'OFFER_UNAVAILABLE',
              'The ready turn could not be claimed.',
            );
            task.status = 'completed';
            task.statusMessage = 'The turn is claimed.';
            task.updatedAt = this.clock.now();
            task.discardAt = task.updatedAt + this.limits.retentionMs;
            task.result = { requestId: request.id };
          });
        } catch (error) {
          this.control.update(state => {
            const task = this.ownTask(state, handle, taskId);
            const request = state.requests[task.requestId];
            if (task.status !== 'working') return;
            if (request && activeStates.includes(request.state))
              this.finish(request, 'FAILED', state);
            else {
              task.status = 'failed';
              task.statusMessage = 'The turn could not be acquired.';
              task.updatedAt = this.clock.now();
              task.discardAt = task.updatedAt + this.limits.retentionMs;
              task.error = { code: -32603, message: 'The turn could not be acquired.' };
            }
            this.promote(state);
          });
        }
      }
      const completed = this.control.view(state => {
        const task = this.ownTask(state, handle, taskId);
        return {
          view: this.taskView(task, false),
          requestId: task.status === 'completed' ? task.requestId : undefined,
        };
      });
      if (!completed.requestId) return completed.view;
      return {
        ...completed.view,
        result: await this.claimedSnapshot(handle, completed.requestId, false),
      };
    });
  }
  cancelTask(handle: string, taskId: string): Record<string, unknown> {
    this.sweep();
    return this.control.update(state => {
      const task = this.ownTask(state, handle, taskId);
      const request = state.requests[task.requestId];
      if (
        request &&
        task.status === 'working' &&
        ['QUEUED', 'READY', 'OFFERED'].includes(request.state)
      )
        this.finish(request, 'CANCELLED', state);
      this.promote(state);
      return this.taskView(task);
    });
  }
  async waitTask(
    handle: string,
    taskId: string,
    updatedAfter: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const until = performance.now() + Math.min(timeout, this.limits.waitMs);
    while (true) {
      const task = this.control.view(state =>
        this.taskView(this.ownTask(state, handle, taskId), false),
      );
      const updated = Date.parse(String(task.lastUpdatedAt));
      if (updated > updatedAfter || performance.now() >= until) return task;
      try {
        await delay(Math.min(100, Math.max(1, until - performance.now())), undefined, { signal });
      } catch {
        throw new BassfishError('CANCELLED', 'Task observation was cancelled.');
      }
    }
  }
  status(handle: string, ticketId: string): Record<string, unknown> {
    this.sweep();
    return this.control.update(state => {
      const request = this.ownRequest(state, handle, ticketId);
      this.materializeOffer(state, request);
      return this.statusIn(state, request);
    });
  }
  private claimed(
    state: ControlState,
    handle: string,
    turnId: string,
    fence: string,
  ): ContentTurnRequest {
    requireThat(turnId && fence, 'TURN_REQUIRED', 'Current turn credentials are required.');
    const actor = this.actor(state, handle);
    const request = values(state.requests).find(r => r.turnId === turnId);
    requireThat(
      request &&
        request.projectId === actor.projectId &&
        request.identityId === actor.identityId &&
        request.instanceId === actor.instanceId,
      'NOT_TURN_OWNER',
      'The turn is not bound to this adapter instance.',
    );
    requireThat(
      request.resourceType !== 'files',
      'RESOURCE_TYPE_MISMATCH',
      'File locks use native filesystem tools and releaseTurn.',
    );
    requireThat(
      request.fence === fence && state.resources[request.resourceId]?.fence === fence,
      'STALE_TURN',
      'The fencing token is no longer current.',
    );
    requireThat(
      request.state !== 'EXPIRED' && this.clock.now() < request.expiresAt!,
      'TURN_EXPIRED',
      'The turn deadline has elapsed.',
    );
    requireThat(
      request.state !== 'COMMITTING',
      'COMMIT_IN_PROGRESS',
      'This turn has an accepted write in progress.',
    );
    requireThat(
      request.state === 'CLAIMED',
      'STALE_TURN',
      'The turn has already been released or consumed.',
    );
    this.ready(state, actor.projectId);
    return request;
  }
  async requestResourceTurn(
    handle: string,
    resourceTypeOrId: ResourceType | string,
    maybeResourceId?: string,
    deliveryMode: 'ticket' | 'task' = 'ticket',
  ): Promise<Record<string, unknown>> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(s => this.ready(s, actor.projectId));
      const resourceId = maybeResourceId ?? resourceTypeOrId;
      const requestedType =
        maybeResourceId === undefined ? undefined : (resourceTypeOrId as ResourceType);
      const actualType = await this.content.resourceType(actor.projectId, resourceId);
      requireThat(
        requestedType === undefined || actualType === requestedType,
        'NOT_FOUND',
        'Resource type does not match this identifier.',
      );
      const resourceType = actualType;
      const ticketId = this.control.update(state => {
        this.actor(state, handle);
        this.ready(state, actor.projectId);
        requireThat(
          !pendingFor(state, actor.instanceId).some(request => request.resourceType !== 'files'),
          'TURN_REQUEST_EXISTS',
          'This adapter already has a pending turn request.',
        );
        const resource = state.resources[resourceId] ?? {
          id: resourceId,
          projectId: actor.projectId,
          type: resourceType,
          fence: '0',
          queueSequence: '0',
          present: true,
        };
        requireThat(
          resource.projectId === actor.projectId && resource.present,
          'NOT_FOUND',
          'Resource not found in this project.',
        );
        state.resources[resourceId] = resource;
        resource.queueSequence = increment(resource.queueSequence);
        const now = this.clock.now();
        const request: TurnRequest = {
          id: uid(),
          projectId: actor.projectId,
          resourceId,
          resourceType,
          identityId: actor.identityId,
          instanceId: actor.instanceId,
          sequence: resource.queueSequence,
          state: 'QUEUED',
          createdAt: now,
          updatedAt: now,
          queueUntil: now + this.limits.queueMs,
          deliveryMode,
        };
        state.requests[request.id] = request;
        if (deliveryMode === 'task')
          state.tasks[request.id] = {
            id: request.id,
            projectId: actor.projectId,
            identityId: actor.identityId,
            requestId: request.id,
            status: 'working',
            statusMessage: 'Waiting for the turn.',
            createdAt: now,
            updatedAt: now,
            discardAt: request.queueUntil,
          };
        this.promote(state);
        if (deliveryMode === 'task' && request.state === 'READY') {
          this.materializeOffer(state, request);
          delete state.tasks[request.id];
          request.deliveryMode = 'ticket';
        }
        return request.id;
      });
      return this.status(handle, ticketId);
    });
  }
  async requestProjectTurn(
    handle: string,
    purpose: ContentTurnRequest['purpose'],
    deliveryMode: 'ticket' | 'task' = 'ticket',
  ): Promise<Record<string, unknown>> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      const ticketId = this.control.update(state => {
        this.actor(state, handle);
        this.ready(state, actor.projectId);
        requireThat(
          !pendingFor(state, actor.instanceId).some(request => request.resourceType !== 'files'),
          'TURN_REQUEST_EXISTS',
          'This adapter already has a pending turn request.',
        );
        const resourceId = `project:${actor.projectId}`;
        const resource = state.resources[resourceId] ?? {
          id: resourceId,
          projectId: actor.projectId,
          type: 'project' as const,
          fence: '0',
          queueSequence: '0',
          present: true,
        };
        state.resources[resourceId] = resource;
        resource.queueSequence = increment(resource.queueSequence);
        const now = this.clock.now();
        const request: TurnRequest = {
          id: uid(),
          projectId: actor.projectId,
          resourceId,
          resourceType: 'project',
          purpose,
          identityId: actor.identityId,
          instanceId: actor.instanceId,
          sequence: resource.queueSequence,
          state: 'QUEUED',
          createdAt: now,
          updatedAt: now,
          queueUntil: now + this.limits.queueMs,
          deliveryMode,
        };
        state.requests[request.id] = request;
        if (deliveryMode === 'task')
          state.tasks[request.id] = {
            id: request.id,
            projectId: actor.projectId,
            identityId: actor.identityId,
            requestId: request.id,
            status: 'working',
            statusMessage: 'Waiting for the project turn.',
            createdAt: now,
            updatedAt: now,
            discardAt: request.queueUntil,
          };
        this.promote(state);
        if (deliveryMode === 'task' && request.state === 'READY') {
          this.materializeOffer(state, request);
          delete state.tasks[request.id];
          request.deliveryMode = 'ticket';
        }
        return request.id;
      });
      return this.status(handle, ticketId);
    });
  }
  async claimTurn(
    handle: string,
    offerId: string,
    limit: number,
    bodyCursor?: string,
  ): Promise<unknown> {
    this.sweep();
    const file = this.control.view(state =>
      values(state.requests).find(
        request => request.offerId === offerId && request.resourceType === 'files',
      ),
    );
    if (file) return this.claimFiles(handle, offerId);
    return this.claimContentTurn(handle, offerId, limit, bodyCursor);
  }
  private async claimContentTurn(
    handle: string,
    offerId: string,
    limit: number,
    bodyCursor?: string,
  ): Promise<unknown> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      const offer = () =>
        this.control.view(state => {
          this.actor(state, handle);
          this.ready(state, actor.projectId);
          const request = values(state.requests).find(r => r.offerId === offerId);
          requireThat(
            request &&
              request.instanceId === actor.instanceId &&
              request.projectId === actor.projectId,
            'NOT_TURN_OWNER',
            'The offer is not bound to this instance.',
          );
          requireThat(
            request.state !== 'EXPIRED' && this.clock.now() < request.claimBy!,
            'OFFER_EXPIRED',
            'The offer claim window has elapsed.',
          );
          requireThat(
            request.state === 'OFFERED',
            'OFFER_UNAVAILABLE',
            'This offer is no longer available.',
          );
          return request;
        });
      const request = offer();
      requireThat(
        request.resourceType !== 'files',
        'RESOURCE_TYPE_MISMATCH',
        'A content turn is required.',
      );
      if (request.resourceType === 'project') {
        const commit = await this.content.head(actor.projectId);
        this.sweep();
        offer();
        const turn = this.control.update(state => {
          const current = state.requests[request.id]!;
          requireThat(
            current.resourceType !== 'files',
            'RESOURCE_TYPE_MISMATCH',
            'A content turn is required.',
          );
          const resource = state.resources[current.resourceId]!;
          resource.fence = increment(resource.fence);
          current.state = 'CLAIMED';
          current.turnId = uid();
          current.fence = resource.fence;
          current.baseRevision = '0';
          current.snapshotCommit = commit;
          current.expiresAt = this.clock.now() + this.limits.turnTimeoutMs;
          return current;
        });
        return {
          requestId: turn.id,
          target: { type: 'project', purpose: turn.purpose },
          turn: { id: turn.turnId, fencingToken: turn.fence, expiresAt: iso(turn.expiresAt!) },
          snapshot: { commit },
          serverTime: iso(this.clock.now()),
        };
      }
      const snapshot =
        request.resourceType === 'thread'
          ? await this.content.snapshot(actor.projectId, request.resourceId, limit)
          : await this.content.ticketSnapshot(actor.projectId, request.resourceId, bodyCursor);
      this.sweep();
      offer();
      const turn = this.control.update(state => {
        const current = state.requests[request.id]!;
        requireThat(
          current.resourceType !== 'files',
          'RESOURCE_TYPE_MISMATCH',
          'A content turn is required.',
        );
        const resource = state.resources[current.resourceId]!;
        resource.fence = increment(resource.fence);
        current.state = 'CLAIMED';
        current.turnId = uid();
        current.fence = resource.fence;
        current.baseRevision =
          snapshot.resourceType === 'thread' ? snapshot.thread.revision : snapshot.ticket.revision;
        current.snapshotCommit = snapshot.commit;
        current.expiresAt = this.clock.now() + this.limits.turnTimeoutMs;
        if (snapshot.resourceType === 'thread') this.followIn(state, actor, request.resourceId);
        return current;
      });
      this.control.view(s => this.claimed(s, handle, turn.turnId!, turn.fence!));
      const page =
        snapshot.resourceType === 'thread'
          ? {
              type: 'thread',
              thread: snapshot.thread,
              messages: snapshot.messages,
              truncated: snapshot.truncated,
            }
          : {
              type: 'ticket',
              ticket: describeTicket(
                snapshot.ticket,
                await this.content.listTickets(actor.projectId, snapshot.commit),
              ),
              ...snapshot.page,
            };
      return {
        requestId: turn.id,
        target: { type: snapshot.resourceType, id: request.resourceId },
        turn: { id: turn.turnId, fencingToken: turn.fence, expiresAt: iso(turn.expiresAt!) },
        snapshot: { commit: snapshot.commit, revision: turn.baseRevision },
        page,
        nextCursor:
          snapshot.resourceType === 'thread' ? snapshot.nextBefore : snapshot.page.nextCursor,
        serverTime: iso(this.clock.now()),
      };
    });
  }
  async read(
    handle: string,
    turnId: string,
    fence: string,
    limit: number,
    before?: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType === 'thread',
      'RESOURCE_TYPE_MISMATCH',
      'This operation requires a thread turn.',
    );
    const snapshot = await this.content.snapshot(
      request.projectId,
      request.resourceId,
      limit,
      before,
      request.snapshotCommit,
    );
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    return {
      target: { type: 'thread', id: request.resourceId },
      snapshot: { commit: snapshot.commit, revision: request.baseRevision },
      page: { type: 'thread', messages: snapshot.messages },
      nextCursor: snapshot.nextBefore,
    };
  }
  async readTurn(handle: string, turnId: string, fence: string, cursor?: string): Promise<unknown> {
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    if (request.resourceType === 'thread') return this.read(handle, turnId, fence, 20, cursor);
    if (request.resourceType === 'ticket') {
      const snapshot = await this.content.ticketSnapshot(
        request.projectId,
        request.resourceId,
        cursor,
        request.snapshotCommit,
      );
      this.sweep();
      this.control.view(state => this.claimed(state, handle, turnId, fence));
      return {
        target: { type: 'ticket', id: snapshot.ticket.id },
        snapshot: { commit: snapshot.commit, revision: request.baseRevision },
        page: {
          type: 'ticket',
          ticket: describeTicket(
            snapshot.ticket,
            await this.content.listTickets(request.projectId, snapshot.commit),
          ),
          ...snapshot.page,
        },
        nextCursor: snapshot.page.nextCursor,
      };
    }
    throw new BassfishError(
      'RESOURCE_TYPE_MISMATCH',
      'Project turns have operation-specific readers.',
    );
  }
  async ticketOutline(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType === 'ticket',
      'RESOURCE_TYPE_MISMATCH',
      'This turn does not belong to a Markdown resource.',
    );
    const snapshot = await this.content.ticketSnapshot(
      request.projectId,
      request.resourceId,
      undefined,
      request.snapshotCommit,
    );
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    return {
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      revision: request.baseRevision,
      snapshotCommit: request.snapshotCommit,
      headings: outline(snapshot.ticket.body),
    };
  }
  async findTicket(
    handle: string,
    turnId: string,
    fence: string,
    query: string,
    mode: 'literal' | 'regex',
    limit: number,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType === 'ticket',
      'RESOURCE_TYPE_MISMATCH',
      'This turn does not belong to a Markdown resource.',
    );
    const snapshot = await this.content.ticketSnapshot(
      request.projectId,
      request.resourceId,
      undefined,
      request.snapshotCommit,
    );
    const body = snapshot.ticket.body;
    const ranges: { start: number; end: number }[] = [];
    if (mode === 'literal') {
      let at = 0;
      while (ranges.length < limit && (at = body.indexOf(query, at)) >= 0) {
        ranges.push({ start: at, end: at + query.length });
        at += Math.max(1, query.length);
      }
    } else {
      const regex = new RE2(query, 'gu');
      let match: RegExpExecArray | null;
      while (ranges.length < limit && (match = regex.exec(body) as RegExpExecArray | null)) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
        if (!match[0]) regex.lastIndex++;
      }
    }
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    return {
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      revision: request.baseRevision,
      snapshotCommit: request.snapshotCommit,
      matches: ranges.map(range => ({
        startCharacter: range.start,
        endCharacter: range.end,
        line: body.slice(0, range.start).split('\n').length,
        snippet: body.slice(Math.max(0, range.start - 128), Math.min(body.length, range.end + 384)),
      })),
    };
  }
  releaseTurn(handle: string, turnId: string, fence: string): unknown {
    this.sweep();
    return this.control.update(state => {
      const request = this.claimed(state, handle, turnId, fence);
      this.finish(request, 'RELEASED', state);
      this.promote(state);
      return this.statusIn(state, request);
    });
  }
  cancelTurnRequest(handle: string, ticketId: string): unknown {
    this.sweep();
    return this.control.update(state => {
      const actor = this.actor(state, handle);
      const request = this.ownRequest(state, handle, ticketId);
      requireThat(
        request.instanceId === actor.instanceId,
        'NOT_TURN_OWNER',
        'Rebind this queue request before cancelling it.',
      );
      requireThat(
        request.state !== 'CLAIMED' && request.state !== 'COMMITTING',
        'TURN_ALREADY_CLAIMED',
        'The turn has already been claimed.',
      );
      if (request.state === 'QUEUED' || request.state === 'READY' || request.state === 'OFFERED')
        this.finish(request, 'CANCELLED', state);
      this.promote(state);
      return this.statusIn(state, request);
    });
  }
  async waitForTurn(
    handle: string,
    ticketId: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    requireThat(
      timeout <= this.limits.waitMs,
      'INVALID_ARGUMENT',
      'The wait exceeds the configured maximum.',
    );
    const until = performance.now() + timeout;
    while (true) {
      const status = this.status(handle, ticketId);
      if (status.state !== 'queued' || performance.now() >= until) return status;
      try {
        await delay(Math.min(100, Math.max(1, until - performance.now())), undefined, { signal });
      } catch {
        try {
          this.cancelTurnRequest(handle, ticketId);
        } catch {
          /* Claim may already have won. */
        }
        throw new BassfishError('CANCELLED', 'The wait was cancelled; inspect ticket state.');
      }
    }
  }
  async createThread(handle: string, title: string, description: string): Promise<unknown> {
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(s => {
        this.actor(s, handle);
        this.creationAllowed(s, actor.projectId);
      });
      const startingHead = await this.content.head(actor.projectId);
      const thread: Thread = {
        id: uid(),
        title,
        description,
        state: 'active',
        revision: '1',
        headSequence: '0',
        creator: actor.identityId,
        createdAt: iso(this.clock.now()),
      };
      const operation: WriteOperation = {
        id: uid(),
        actor,
        resourceId: thread.id,
        resourceType: 'thread',
        at: thread.createdAt,
        thread,
        mutation: { kind: 'createThread' },
      };
      this.control.update(state => {
        this.actor(state, handle);
        this.creationAllowed(state, actor.projectId);
        state.pending[operation.id] = {
          id: operation.id,
          projectId: actor.projectId,
          resourceId: thread.id,
          resourceType: 'thread',
          startingHead,
          kind: 'createThread',
          actor,
          followIdentityId: actor.identityId,
        };
      });
      const result = await this.persist(operation);
      return { threadId: thread.id, title, state: thread.state, ...result };
    });
  }
  async listThreadMetadata(handle: string, args: Record<string, unknown>): Promise<unknown> {
    const actor = this.control.view(state => {
      const current = this.actor(state, handle);
      this.ready(state, current.projectId);
      return current;
    });
    const cursor = decodeCursor(args.cursor);
    let threads = sortThreads(await this.content.listThreads(actor.projectId)).filter(
      thread => thread.state === args.state,
    );
    if (args.creatorIdentityId) {
      threads = threads.filter(thread => thread.creator === args.creatorIdentityId);
    }
    if (args.titlePrefix) {
      threads = threads.filter(thread => thread.title.startsWith(args.titlePrefix as string));
    }
    if (args.following !== undefined) {
      threads = threads.filter(
        thread =>
          Boolean(
            this.control.view(
              state => state.follows[followKey(actor.projectId, thread.id, actor.identityId)],
            ),
          ) === args.following,
      );
    }
    if (cursor) {
      threads = threads.filter(
        thread =>
          thread.createdAt > cursor[0] || (thread.createdAt === cursor[0] && thread.id > cursor[1]),
      );
    }
    const limit = args.limit as number;
    const page = threads.slice(0, limit);
    const last = page.at(-1);
    return {
      threads: page.map(thread => ({
        ...thread,
        following: Boolean(
          this.control.view(
            state => state.follows[followKey(actor.projectId, thread.id, actor.identityId)],
          ),
        ),
      })),
      nextCursor: threads.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null,
    };
  }

  async getThreadMetadata(handle: string, threadId: string): Promise<unknown> {
    const actor = this.control.view(state => {
      const current = this.actor(state, handle);
      this.ready(state, current.projectId);
      return current;
    });
    const thread = (await this.content.listThreads(actor.projectId)).find(
      value => value.id === threadId,
    );
    requireThat(thread, 'NOT_FOUND', 'Thread not found in this project.');
    return {
      ...thread,
      following: this.control.view(state =>
        Boolean(state.follows[followKey(actor.projectId, thread.id, actor.identityId)]),
      ),
    };
  }

  async searchThreadMetadata(handle: string, args: Record<string, unknown>): Promise<unknown> {
    const actor = this.control.view(state => {
      const current = this.actor(state, handle);
      this.ready(state, current.projectId);
      return current;
    });
    const query = String(args.query).toLowerCase();
    const threads = sortThreads(await this.content.listThreads(actor.projectId))
      .filter(
        thread =>
          thread.state === args.state &&
          [thread.title, thread.description].some(value => value.toLowerCase().includes(query)),
      )
      .slice(0, args.limit as number);
    return { threads };
  }

  ticketOwner(projectId: string, ownerName: string): { id: string; name: string } {
    return this.control.view(state => {
      const owner = values(state.identities).find(
        identity =>
          identity.projectId === projectId &&
          identity.name.toLowerCase() === ownerName.toLowerCase(),
      );
      requireThat(owner, 'UNKNOWN_AGENT', `No agent named ${ownerName} exists in this repository.`);
      return { id: owner.id, name: owner.name };
    });
  }
  async createTicket(
    handle: string,
    input: {
      title: string;
      description: string;
      owner: string;
      state: Ticket['state'];
      body: string;
      dependsOn: string[];
    },
  ): Promise<unknown> {
    const actor = this.control.view(state => this.actor(state, handle));
    return this.writers.run(actor.projectId, async () => {
      this.control.view(state => {
        this.actor(state, handle);
        this.creationAllowed(state, actor.projectId);
      });
      const owner = this.ticketOwner(actor.projectId, input.owner);
      const tickets = await this.content.listTickets(actor.projectId);
      const at = iso(this.clock.now());
      const ticket: Ticket = {
        id: uid(),
        title: input.title,
        description: input.description,
        owner: owner.id,
        ownerName: owner.name,
        state: input.state,
        body: input.body,
        dependsOn: normalizeDependencies(input.dependsOn),
        revision: '1',
        creator: actor.identityId,
        creatorName: actor.name,
        lastEditor: actor.identityId,
        lastEditorName: actor.name,
        createdAt: at,
        updatedAt: at,
      };
      validateTicketGraph([...tickets, ticket]);
      const startingHead = await this.content.head(actor.projectId);
      const operation: WriteOperation = {
        id: uid(),
        actor,
        resourceId: ticket.id,
        resourceType: 'ticket',
        at,
        ticket,
        mutation: { kind: 'createTicket' },
      };
      const notificationIntents: NotificationIntent[] =
        owner.id === actor.identityId
          ? []
          : [
              {
                identityId: owner.id,
                resourceType: 'ticket',
                resourceId: ticket.id,
                reasons: ['ticket_assigned'],
              },
            ];
      this.control.update(state => {
        this.actor(state, handle);
        this.creationAllowed(state, actor.projectId);
        state.pending[operation.id] = {
          id: operation.id,
          projectId: actor.projectId,
          resourceId: ticket.id,
          resourceType: 'ticket',
          startingHead,
          kind: 'createTicket',
          actor,
          notificationIntents,
          notificationCreatedAt: this.clock.now(),
        };
      });
      const result = await this.persist(operation);
      return {
        ticketId: ticket.id,
        title: ticket.title,
        owner: ticket.ownerName,
        state: ticket.state,
        ...result,
      };
    });
  }
  private signRestore(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.restoreSecret).update(body).digest('base64url')}`;
  }
  private verifyRestore(token: string): Record<string, unknown> {
    const [body, signature, extra] = token.split('.');
    requireThat(
      body && signature && !extra,
      'INVALID_PREVIEW',
      'The restore preview token is invalid.',
    );
    const expected = createHmac('sha256', this.restoreSecret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    requireThat(
      actual.length === expected.length && timingSafeEqual(actual, expected),
      'INVALID_PREVIEW',
      'The restore preview token is invalid.',
    );
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BassfishError('INVALID_PREVIEW', 'The restore preview token is invalid.');
    }
  }
  async resourceHistory(
    handle: string,
    turnId: string,
    fence: string,
    offset: number,
    limit: number,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType !== 'project',
      'RESOURCE_TYPE_MISMATCH',
      'Project turns do not have one resource history.',
    );
    const entries = await this.content.history(
      request.projectId,
      request.resourceType,
      request.resourceId,
    );
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    return {
      target: { type: request.resourceType, id: request.resourceId },
      entries: entries.slice(offset, offset + limit),
      nextOffset: offset + limit < entries.length ? offset + limit : null,
    };
  }
  async resourceAt(
    handle: string,
    turnId: string,
    fence: string,
    revision: string,
    limit: number,
    cursor?: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType !== 'project',
      'RESOURCE_TYPE_MISMATCH',
      'Use a resource turn for historical reads.',
    );
    const commit = await this.content.commitAtRevision(
      request.projectId,
      request.resourceType,
      request.resourceId,
      revision,
    );
    const snapshot =
      request.resourceType === 'thread'
        ? await this.content.snapshot(
            request.projectId,
            request.resourceId,
            limit,
            undefined,
            commit,
          )
        : await this.content.ticketSnapshot(request.projectId, request.resourceId, cursor, commit);
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    return snapshot.resourceType === 'thread'
      ? {
          target: { type: 'thread', id: request.resourceId },
          revision,
          snapshotCommit: commit,
          page: {
            type: 'thread',
            thread: snapshot.thread,
            messages: snapshot.messages,
            truncated: snapshot.truncated,
          },
          nextCursor: snapshot.nextBefore,
        }
      : {
          target: { type: 'ticket', id: request.resourceId },
          revision,
          snapshotCommit: commit,
          page: {
            type: 'ticket',
            ticket: describeTicket(
              snapshot.ticket,
              await this.content.listTickets(request.projectId, commit),
            ),
            ...snapshot.page,
          },
          nextCursor: snapshot.page.nextCursor,
        };
  }
  async diffResource(
    handle: string,
    turnId: string,
    fence: string,
    revision: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType !== 'project',
      'RESOURCE_TYPE_MISMATCH',
      'Use a resource turn for diffs.',
    );
    const targetCommit = await this.content.commitAtRevision(
      request.projectId,
      request.resourceType,
      request.resourceId,
      revision,
    );
    if (request.resourceType === 'ticket') {
      const [target, current, targetTickets, currentTickets] = await Promise.all([
        this.content.ticketSnapshot(request.projectId, request.resourceId, undefined, targetCommit),
        this.content.ticketSnapshot(request.projectId, request.resourceId),
        this.content.listTickets(request.projectId, targetCommit),
        this.content.listTickets(request.projectId),
      ]);
      this.sweep();
      this.control.view(state => this.claimed(state, handle, turnId, fence));
      return {
        target: { type: 'ticket', id: request.resourceId },
        fromRevision: revision,
        toRevision: current.ticket.revision,
        fromCommit: targetCommit,
        toCommit: current.commit,
        metadataChanged:
          JSON.stringify(describeTicket(target.ticket, targetTickets)) !==
          JSON.stringify(describeTicket(current.ticket, currentTickets)),
        before: target.page,
        after: current.page,
      };
    }
    const [target, current] = await Promise.all([
      this.content.snapshot(
        request.projectId,
        request.resourceId,
        1_000_000,
        undefined,
        targetCommit,
      ),
      this.content.snapshot(request.projectId, request.resourceId, 1_000_000),
    ]);
    this.sweep();
    this.control.view(s => this.claimed(s, handle, turnId, fence));
    const targetIds = new Set(
      target.messages.filter(message => !message.retracted).map(message => message.id),
    );
    const currentIds = new Set(
      current.messages.filter(message => !message.retracted).map(message => message.id),
    );
    return {
      target: { type: 'thread', id: request.resourceId },
      fromRevision: revision,
      toRevision: current.thread.revision,
      fromCommit: targetCommit,
      toCommit: current.commit,
      metadataChanged: JSON.stringify(target.thread) !== JSON.stringify(current.thread),
      messagesAdded: [...currentIds].filter(id => !targetIds.has(id)),
      messagesRemoved: [...targetIds].filter(id => !currentIds.has(id)),
    };
  }
  async previewRestore(
    handle: string,
    turnId: string,
    fence: string,
    revision: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
    requireThat(
      request.resourceType !== 'project',
      'RESOURCE_TYPE_MISMATCH',
      'Use a resource turn for this restore preview.',
    );
    const targetCommit = await this.content.commitAtRevision(
      request.projectId,
      request.resourceType,
      request.resourceId,
      revision,
    );
    const preview = await this.diffResource(handle, turnId, fence, revision);
    const token = this.signRestore({
      turnId,
      fence,
      projectId: request.projectId,
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      currentRevision: request.baseRevision,
      targetRevision: revision,
      targetCommit,
      expiresAt: request.expiresAt,
    });
    return { ...(preview as object), previewToken: token, expiresAt: iso(request.expiresAt!) };
  }
  async restoreRevision(
    handle: string,
    turnId: string,
    fence: string,
    token: string,
  ): Promise<MutationResult> {
    this.sweep();
    const payload = this.verifyRestore(token);
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
      requireThat(
        payload.turnId === turnId &&
          payload.fence === fence &&
          payload.projectId === actor.projectId &&
          payload.resourceId === request.resourceId &&
          payload.resourceType === request.resourceType &&
          payload.currentRevision === request.baseRevision &&
          Number(payload.expiresAt) > this.clock.now(),
        'PREVIEW_STALE',
        'The restore preview no longer matches this turn.',
      );
      const at = iso(this.clock.now());
      let operation: WriteOperation;
      if (request.resourceType === 'ticket') {
        const [target, current, currentTickets] = await Promise.all([
          this.content.ticketSnapshot(
            actor.projectId,
            request.resourceId,
            undefined,
            payload.targetCommit as string,
          ),
          this.content.ticketSnapshot(actor.projectId, request.resourceId),
          this.content.listTickets(actor.projectId),
        ]);
        requireThat(
          current.ticket.revision === request.baseRevision,
          'REVISION_CHANGED',
          'The current ticket changed after the turn was claimed.',
        );
        const ticket: Ticket = {
          ...target.ticket,
          revision: increment(current.ticket.revision),
          lastEditor: actor.identityId,
          lastEditorName: actor.name,
          updatedAt: at,
        };
        validateTicketGraph(currentTickets.map(value => (value.id === ticket.id ? ticket : value)));
        operation = {
          id: uid(),
          actor,
          resourceId: request.resourceId,
          resourceType: 'ticket',
          at,
          ticket,
          mutation: { kind: 'replaceTicketBody', body: ticket.body },
        };
      } else {
        const [target, current] = await Promise.all([
          this.content.snapshot(
            actor.projectId,
            request.resourceId,
            1_000_000,
            undefined,
            payload.targetCommit as string,
          ),
          this.content.snapshot(actor.projectId, request.resourceId, 1_000_000),
        ]);
        requireThat(
          current.thread.revision === request.baseRevision,
          'REVISION_CHANGED',
          'The current thread changed after the turn was claimed.',
        );
        const thread: Thread = {
          ...target.thread,
          revision: increment(current.thread.revision),
          headSequence: current.thread.headSequence,
        };
        const targetVisibility = new Map(
          target.messages.map(message => [message.id, !message.retracted]),
        );
        const visibilityChanges = current.messages
          .filter(message => !message.retracted !== (targetVisibility.get(message.id) ?? false))
          .map(message => ({
            messageId: message.id,
            visible: targetVisibility.get(message.id) ?? false,
          }));
        operation = {
          id: uid(),
          actor,
          resourceId: request.resourceId,
          resourceType: 'thread',
          at,
          thread,
          mutation: {
            kind: 'restoreThreadRevision',
            targetRevision: payload.targetRevision as string,
          },
          visibilityChanges,
        };
      }
      this.control.update(state => {
        const current = this.claimed(state, handle, turnId, fence);
        current.state = 'COMMITTING';
        state.pending[operation.id] = {
          id: operation.id,
          projectId: actor.projectId,
          resourceId: request.resourceId,
          resourceType: request.resourceType,
          turnRequestId: request.id,
          startingHead: request.snapshotCommit!,
          kind: 'restoreRevision',
          actor,
        };
      });
      return this.persist(operation);
    });
  }
  private projectTurn(
    state: ControlState,
    handle: string,
    turnId: string,
    fence: string,
    purpose?: ContentTurnRequest['purpose'],
  ): ContentTurnRequest {
    const request = this.claimed(state, handle, turnId, fence);
    requireThat(
      request.resourceType === 'project',
      'RESOURCE_TYPE_MISMATCH',
      'A project turn is required.',
    );
    requireThat(
      !purpose || request.purpose === purpose,
      'PROJECT_PURPOSE_MISMATCH',
      'This project turn was acquired for another purpose.',
    );
    return request;
  }
  async projectSnapshotInfo(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'snapshot'));
    const snapshot = await this.content.projectSnapshot(request.projectId, request.snapshotCommit);
    this.sweep();
    this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'snapshot'));
    return {
      snapshotCommit: snapshot.commit,
      threads: snapshot.threads.map(thread => ({
        id: thread.id,
        title: thread.title,
        description: thread.description,
        state: thread.state,
        revision: thread.revision,
      })),
      tickets: describeTickets(snapshot.tickets),
      messageCount: snapshot.messages.length,
    };
  }
  private cursorOffset(token: string | undefined, expected: Record<string, unknown>): number {
    if (!token) return 0;
    const payload = this.verifyRestore(token);
    for (const [key, value] of Object.entries(expected))
      requireThat(
        payload[key] === value,
        'INVALID_CURSOR',
        'The cursor does not match this snapshot or query.',
      );
    requireThat(
      Number.isSafeInteger(payload.offset) && Number(payload.offset) >= 0,
      'INVALID_CURSOR',
      'The cursor offset is invalid.',
    );
    return Number(payload.offset);
  }
  private nextCursor(offset: number | null, expected: Record<string, unknown>): string | null {
    return offset === null ? null : this.signRestore({ ...expected, offset });
  }
  async projectHistoryList(
    handle: string,
    turnId: string,
    fence: string,
    limit: number,
    cursor?: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'restore'));
    const key = { kind: 'projectHistory', snapshotCommit: request.snapshotCommit };
    const offset = this.cursorOffset(cursor, key);
    const entries = await this.content.projectHistory(request.projectId);
    const page = entries.filter(value => value.doltCommit).slice(offset, offset + limit);
    this.sweep();
    this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'restore'));
    return {
      snapshotCommit: request.snapshotCommit,
      entries: page,
      nextCursor: this.nextCursor(page.length === limit ? offset + limit : null, key),
    };
  }
  async previewProjectRestore(
    handle: string,
    turnId: string,
    fence: string,
    targetCommit: string,
    limit: number,
    cursor?: string,
  ): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'restore'));
    const actor = this.control.view(s => this.actor(s, handle));
    const [current, target] = await Promise.all([
      this.content.projectSnapshot(request.projectId, request.snapshotCommit),
      this.content.projectSnapshot(request.projectId, targetCommit),
    ]);
    const built = await buildProjectRestore(
      this.content,
      this.restoreSecret,
      request.projectId,
      actor,
      current,
      target,
      iso(this.clock.now()),
    );
    const key = {
      kind: 'restoreChanges',
      currentCommit: current.commit,
      targetCommit: target.commit,
      digest: built.digest,
    };
    const offset = this.cursorOffset(cursor, key);
    const page = built.changes.slice(offset, offset + limit);
    const previewToken = this.signRestore({
      kind: 'snapshotRestore',
      turnId,
      fence,
      projectId: request.projectId,
      currentCommit: current.commit,
      targetCommit: target.commit,
      digest: built.digest,
      expiresAt: request.expiresAt,
    });
    this.sweep();
    this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'restore'));
    return {
      currentCommit: current.commit,
      targetCommit: target.commit,
      summary: built.summary,
      changes: page,
      nextCursor: this.nextCursor(page.length === limit ? offset + limit : null, key),
      previewToken,
      expiresAt: iso(request.expiresAt!),
    };
  }
  async restoreProject(
    handle: string,
    turnId: string,
    fence: string,
    token: string,
  ): Promise<ProjectRestoreResult> {
    this.sweep();
    const payload = this.verifyRestore(token);
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      const request = this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'restore'));
      requireThat(
        payload.kind === 'snapshotRestore' &&
          payload.turnId === turnId &&
          payload.fence === fence &&
          payload.projectId === actor.projectId &&
          payload.currentCommit === request.snapshotCommit &&
          Number(payload.expiresAt) > this.clock.now(),
        'PREVIEW_STALE',
        'The restore preview no longer matches this turn.',
      );
      const [current, target] = await Promise.all([
        this.content.projectSnapshot(actor.projectId),
        this.content.projectSnapshot(actor.projectId, String(payload.targetCommit)),
      ]);
      requireThat(
        current.commit === request.snapshotCommit,
        'PREVIEW_STALE',
        'The project changed after the restore preview.',
      );
      const built = await buildProjectRestore(
        this.content,
        this.restoreSecret,
        actor.projectId,
        actor,
        current,
        target,
        iso(this.clock.now()),
      );
      requireThat(
        built.digest === payload.digest,
        'PREVIEW_STALE',
        'The restore change set changed.',
      );
      requireThat(
        built.changes.length > 0,
        'NO_CHANGE',
        'The target snapshot already matches visible project content.',
      );
      const operationId = uid();
      const at = iso(this.clock.now());
      const restoredThreadRevisions = new Map(
        built.changes
          .filter(change => change.resourceType === 'thread' && change.action !== 'delete')
          .map(change => [change.resourceId, change.afterRevision]),
      );
      const restoredSnapshot = {
        ...built.snapshot,
        visibility: built.snapshot.visibility.map(value =>
          restoredThreadRevisions.has(value.threadId)
            ? {
                ...value,
                threadRevision: restoredThreadRevisions.get(value.threadId)!,
                operationId,
                createdAt: at,
              }
            : value,
        ),
      };
      const operation: ProjectRestoreOperation = {
        id: operationId,
        actor,
        resourceId: request.resourceId,
        resourceType: 'project',
        at,
        mutation: { kind: 'restoreSnapshot', targetCommit: target.commit },
        target: restoredSnapshot,
        current,
        changes: built.changes,
      };
      this.control.update(state => {
        const claimed = this.projectTurn(state, handle, turnId, fence, 'restore');
        claimed.state = 'COMMITTING';
        claimed.updatedAt = this.clock.now();
        state.pending[operation.id] = {
          id: operation.id,
          projectId: actor.projectId,
          resourceId: request.resourceId,
          resourceType: 'project',
          turnRequestId: request.id,
          startingHead: current.commit,
          kind: 'restoreSnapshot',
          actor,
        };
      });
      return this.persist(operation);
    });
  }
  async exportProject(handle: string, turnId: string, fence: string): Promise<unknown> {
    this.sweep();
    const request = this.control.view(s => this.projectTurn(s, handle, turnId, fence, 'export'));
    requireThat(this.dataDir, 'EXPORT_UNAVAILABLE', 'Export storage is unavailable.');
    const snapshot = await this.content.projectSnapshot(request.projectId, request.snapshotCommit);
    const result = await writeProjectExport(this.dataDir, request.projectId, snapshot);
    this.sweep();
    this.control.update(s => {
      const current = this.projectTurn(s, handle, turnId, fence, 'export');
      this.finish(current, 'RELEASED', s);
      this.promote(s);
    });
    return result;
  }
  async commitTurn(
    handle: string,
    turnId: string,
    fence: string,
    base: string,
    mutation: Mutation,
  ): Promise<MutationResult> {
    this.sweep();
    const actor = this.control.view(s => this.actor(s, handle));
    return this.writers.run(actor.projectId, async () => {
      this.sweep();
      const request = this.control.view(s => this.claimed(s, handle, turnId, fence));
      const snapshot =
        request.resourceType === 'thread'
          ? await this.content.snapshot(actor.projectId, request.resourceId, 1)
          : await this.content.ticketSnapshot(actor.projectId, request.resourceId);
      const currentRevision =
        snapshot.resourceType === 'thread' ? snapshot.thread.revision : snapshot.ticket.revision;
      requireThat(
        base === request.baseRevision && base === currentRevision,
        'REVISION_CHANGED',
        'The mutation base must match the current claimed revision.',
      );
      if (mutation.kind === 'appendMessage') {
        const append = mutation;
        const normalized = this.control.view(state => {
          this.actor(state, handle);
          const resolveAgent = (name: string) => {
            const identity = values(state.identities).find(
              item =>
                item.projectId === actor.projectId &&
                item.name.toLowerCase() === name.toLowerCase(),
            );
            requireThat(
              identity,
              'UNKNOWN_AGENT',
              `No agent named ${name} exists in this repository.`,
            );
            return identity;
          };
          const agents = [
            ...new Set(
              (append.mentions?.agents ?? []).map((name: string) => resolveAgent(name).name),
            ),
          ];
          requireThat(
            !append.mentions?.global || (agents.length === 0 && !append.mentions.here),
            'INVALID_ARGUMENT',
            '@global cannot be combined with direct mentions or @here.',
          );
          return { agents };
        });
        mutation = {
          ...append,
          mentions: {
            agents: normalized.agents,
            here: append.mentions?.here ?? false,
            global: append.mentions?.global ?? false,
          },
        };
      }
      const at = iso(this.clock.now());
      let operation: WriteOperation;
      let notificationIntents: NotificationIntent[] = [];
      if (snapshot.resourceType === 'thread') {
        requireThat(
          threadMutationKinds.includes(mutation.kind),
          'RESOURCE_TYPE_MISMATCH',
          'This mutation does not apply to a thread.',
        );
        if (mutation.kind === 'retractMessage' || mutation.kind === 'reinstateMessage') {
          const visibilityMutation = mutation;
          const current = await this.content.snapshot(
            actor.projectId,
            request.resourceId,
            1_000_000,
          );
          const message = current.messages.find(value => value.id === visibilityMutation.messageId);
          requireThat(message, 'NOT_FOUND', 'Message not found in this thread.');
          requireThat(
            mutation.kind === 'retractMessage' ? !message.retracted : message.retracted,
            'NO_CHANGE',
            `The message is already ${mutation.kind === 'retractMessage' ? 'retracted' : 'visible'}.`,
          );
        }
        const thread = prepareMutation(snapshot.thread, mutation as ThreadMutation);
        operation = {
          id: uid(),
          actor,
          resourceId: request.resourceId,
          resourceType: 'thread',
          at,
          thread,
          mutation: mutation as ThreadMutation,
        };
      } else {
        requireThat(
          ticketMutationKinds.includes(mutation.kind),
          'RESOURCE_TYPE_MISMATCH',
          'This mutation does not apply to a ticket.',
        );
        let ticketMutation = mutation as TicketMutation;
        let owner = { id: snapshot.ticket.owner, name: snapshot.ticket.ownerName };
        if (ticketMutation.kind === 'updateTicket' && ticketMutation.owner !== undefined) {
          owner = this.ticketOwner(actor.projectId, ticketMutation.owner);
          ticketMutation = { ...ticketMutation, owner: owner.id };
        }
        const beforeTickets = await this.content.listTickets(actor.projectId);
        const ticket = prepareTicket(snapshot.ticket, ticketMutation, actor, at);
        ticket.ownerName = owner.name;
        const afterTickets = beforeTickets.map(value => (value.id === ticket.id ? ticket : value));
        validateTicketGraph(afterTickets);
        const beforeStatuses = ticketStatuses(beforeTickets);
        const afterStatuses = ticketStatuses(afterTickets);
        if (ticket.owner !== snapshot.ticket.owner && ticket.owner !== actor.identityId)
          notificationIntents.push({
            identityId: ticket.owner,
            resourceType: 'ticket',
            resourceId: ticket.id,
            reasons: ['ticket_assigned'],
          });
        for (const candidate of afterTickets) {
          const before = beforeTickets.find(value => value.id === candidate.id)!;
          if (
            !beforeStatuses.get(before.id)!.ready &&
            afterStatuses.get(candidate.id)!.ready &&
            candidate.owner !== actor.identityId
          )
            notificationIntents.push({
              identityId: candidate.owner,
              resourceType: 'ticket',
              resourceId: candidate.id,
              reasons: ['ticket_ready'],
            });
        }
        mutation = ticketMutation;
        operation = {
          id: uid(),
          actor,
          resourceId: request.resourceId,
          resourceType: 'ticket',
          at,
          ticket,
          mutation: ticketMutation,
        };
      }
      this.control.update(state => {
        const current = this.claimed(state, handle, turnId, fence);
        current.state = 'COMMITTING';
        let notificationRecipients: Record<string, NotificationReason[]> | undefined;
        if (mutation.kind === 'appendMessage') {
          const append = mutation;
          notificationRecipients = {};
          const add = (identityId: string, reason: NotificationReason) => {
            if (identityId === actor.identityId) return;
            const reasons = (notificationRecipients![identityId] ??= []);
            if (!reasons.includes(reason)) reasons.push(reason);
          };
          const followers = values(state.follows).filter(
            item => item.projectId === actor.projectId && item.threadId === request.resourceId,
          );
          for (const follow of followers) add(follow.identityId, 'followed_message');
          for (const name of append.mentions?.agents ?? [])
            add(
              values(state.identities).find(
                item =>
                  item.projectId === actor.projectId &&
                  item.name.toLowerCase() === name.toLowerCase(),
              )!.id,
              'direct_mention',
            );
          if (append.mentions?.here)
            for (const follow of followers)
              if (
                values(state.instances).some(
                  instance => instance.identityId === follow.identityId && instance.active,
                )
              )
                add(follow.identityId, 'here');
          if (append.mentions?.global)
            for (const identity of values(state.identities))
              if (identity.projectId === actor.projectId) add(identity.id, 'global');
          for (const identity of values(state.identities))
            if (identity.projectId === actor.projectId)
              if (identity.id !== actor.identityId && !notificationRecipients[identity.id])
                add(identity.id, 'thread_activity');
        }
        state.pending[operation.id] = {
          id: operation.id,
          projectId: actor.projectId,
          resourceId: request.resourceId,
          resourceType: request.resourceType,
          turnRequestId: request.id,
          startingHead: snapshot.commit,
          kind: mutation.kind,
          actor,
          ...(mutation.kind === 'appendMessage'
            ? {
                followIdentityId: actor.identityId,
                notificationRecipients,
                notificationCreatedAt: this.clock.now(),
              }
            : {}),
          ...(notificationIntents.length
            ? { notificationIntents, notificationCreatedAt: this.clock.now() }
            : {}),
        };
      });
      return this.persist(operation);
    });
  }
  private finalize(pending: PendingCommit, result?: StorageResult): void {
    const intents: NotificationIntent[] = [...(pending.notificationIntents ?? [])];
    if (result && pending.notificationRecipients && 'messageId' in result && result.messageId)
      for (const [identityId, reasons] of Object.entries(pending.notificationRecipients))
        intents.push({
          identityId,
          resourceType: 'thread',
          resourceId: pending.resourceId,
          reasons,
        });
    const wakeRecipients = result ? intents.map(intent => intent.identityId) : [];
    this.control.update(state => {
      (state.observationEvents ??= []).push({
        id: `content:${pending.id}`,
        projectId: pending.projectId,
        kind: result
          ? `${pending.resourceType}.${pending.kind}`
          : `${pending.resourceType}.write_failed`,
        at: this.clock.now(),
        actor: pending.actor.name,
        identityId: pending.actor.identityId,
        resourceType: pending.resourceType,
        resourceId: pending.resourceId,
        details: {
          ...pending.observation,
          ...(result
            ? {
                commit: result.doltCommit,
                ...('messageId' in result ? { messageId: result.messageId } : {}),
              }
            : {}),
        },
      });
      if (pending.turnRequestId) {
        const request = state.requests[pending.turnRequestId]!;
        requireThat(
          request.resourceType !== 'files',
          'RESOURCE_TYPE_MISMATCH',
          'A pending commit requires a content turn.',
        );
        this.finish(request, result ? 'COMMITTED' : 'FAILED', state);
        if (result) request.result = result;
      }
      if (result && pending.resourceType !== 'project' && !state.resources[pending.resourceId])
        state.resources[pending.resourceId] = {
          id: pending.resourceId,
          projectId: pending.projectId,
          type: pending.resourceType,
          fence: '0',
          queueSequence: '0',
          present: true,
        };
      if (result && pending.followIdentityId && pending.resourceType === 'thread')
        this.followIn(
          state,
          { ...pending.actor, identityId: pending.followIdentityId },
          pending.resourceId,
        );
      if (result && intents.length) {
        const merged = new Map<string, NotificationIntent>();
        for (const intent of intents) {
          const key = `${intent.identityId}:${intent.resourceType}:${intent.resourceId}`;
          const existing = merged.get(key);
          if (existing) existing.reasons = [...new Set([...existing.reasons, ...intent.reasons])];
          else merged.set(key, structuredClone(intent));
        }
        for (const intent of merged.values()) {
          const messageId =
            intent.resourceType === 'thread' && 'messageId' in result
              ? result.messageId
              : undefined;
          const activityOnly =
            intent.resourceType === 'thread' &&
            intent.reasons.length === 1 &&
            intent.reasons[0] === 'thread_activity';
          const existing = activityOnly
            ? values(state.notifications).find(
                notification =>
                  notification.projectId === pending.projectId &&
                  notification.identityId === intent.identityId &&
                  notification.threadId === intent.resourceId &&
                  notification.reasons.length === 1 &&
                  notification.reasons[0] === 'thread_activity',
              )
            : undefined;
          const notification = {
            id: existing?.id ?? uid(),
            projectId: pending.projectId,
            identityId: intent.identityId,
            resourceType: intent.resourceType,
            resourceId: intent.resourceId,
            eventId: messageId ?? pending.id,
            ...(intent.resourceType === 'thread'
              ? {
                  threadId: intent.resourceId,
                  messageId,
                  sequence: 'sequence' in result ? result.sequence : undefined,
                }
              : { ticketId: intent.resourceId }),
            senderIdentityId: pending.actor.identityId,
            senderName: pending.actor.name,
            createdAt: pending.notificationCreatedAt ?? this.clock.now(),
            reasons: intent.reasons,
          };
          state.notifications[notification.id] = notification;
        }
      }
      if (result && 'changes' in result) {
        for (const change of result.changes) {
          const resource = state.resources[change.resourceId] ?? {
            id: change.resourceId,
            projectId: pending.projectId,
            type: change.resourceType,
            fence: '0',
            queueSequence: '0',
            present: true,
          };
          resource.type = change.resourceType;
          resource.present = change.action !== 'delete';
          state.resources[change.resourceId] = resource;
          if (change.action === 'delete')
            for (const request of values(state.requests).filter(
              value =>
                value.resourceType !== 'files' &&
                value.resourceId === change.resourceId &&
                activeStates.includes(value.state),
            ))
              this.finish(request, 'FAILED', state);
        }
      }
      delete state.pending[pending.id];
      this.promote(state);
    });
    this.signalWake(wakeRecipients);
  }
  private persist(operation: WriteOperation): Promise<MutationResult>;
  private persist(operation: ProjectRestoreOperation): Promise<ProjectRestoreResult>;
  private async persist(
    operation: WriteOperation | ProjectRestoreOperation,
  ): Promise<StorageResult> {
    const pending = this.control.update(s => {
      const pending = s.pending[operation.id]!;
      pending.observation =
        operation.resourceType === 'project'
          ? { targetCommit: operation.mutation.targetCommit }
          : operation.resourceType === 'thread'
            ? { title: operation.thread.title, revision: operation.thread.revision }
            : {
                title: operation.ticket.title,
                revision: operation.ticket.revision,
                state: operation.ticket.state,
                owner: operation.ticket.ownerName,
                dependsOn: operation.ticket.dependsOn,
              };
      return pending;
    });
    try {
      const result = await this.content.write(operation);
      this.finalize(pending, result);
      return result;
    } catch {
      // Never replay a write: inspect its operation marker and committed head instead.
      this.control.update(s => {
        s.projects[pending.projectId]!.recovering = true;
      });
      let resolution;
      try {
        resolution = await this.content.resolve(pending);
      } catch {
        resolution = { state: 'unknown' as const };
      }
      if (resolution.state === 'committed') {
        this.finalize(pending, resolution.result);
        this.control.update(s => {
          s.projects[pending.projectId]!.recovering = false;
          this.promote(s);
        });
        return resolution.result;
      }
      if (resolution.state === 'absent') {
        this.finalize(pending);
        this.control.update(s => {
          s.projects[pending.projectId]!.recovering = false;
          this.promote(s);
        });
        throw new BassfishError(
          'WRITE_FAILED',
          'The write was proven absent. No content mutation was retried.',
        );
      }
      throw new BassfishError(
        'OUTCOME_UNKNOWN',
        'Storage outcome is unresolved. The project remains protected.',
      );
    }
  }
  async recover(projectId: string): Promise<void> {
    for (const pending of this.control.view(s =>
      values(s.pending).filter(p => p.projectId === projectId),
    )) {
      const result = await this.content.resolve(pending);
      if (result.state === 'unknown') return;
      this.finalize(pending, result.state === 'committed' ? result.result : undefined);
    }
    this.control.update(s => {
      s.projects[projectId]!.recovering = false;
      this.promote(s);
    });
  }
  inspect(): unknown {
    this.sweep();
    return this.control.view(s => ({
      epoch: this.epoch,
      projects: values(s.projects),
      turns: values(s.requests).map(r => ({
        ...this.statusIn(s, r),
        projectId: r.projectId,
        turnId: r.turnId,
        owner: s.identities[r.identityId]?.name,
        identityId: r.identityId,
        instanceId: r.instanceId,
      })),
    }));
  }
  hasPendingWork(): boolean {
    return this.control.view(
      s =>
        values(s.requests).some(r => activeStates.includes(r.state)) ||
        values(s.pending).length > 0 ||
        values(s.projects).some(p => p.recovering),
    );
  }
  forceRelease(turnId: string): void {
    this.sweep();
    this.control.update(state => {
      const request = values(state.requests).find(r => r.turnId === turnId);
      requireThat(
        request?.state === 'CLAIMED',
        'NOT_CLAIMED',
        'Only a claimed turn can be force-released; committing writes are protected.',
      );
      this.finish(request, 'RELEASED', state, 'force_released');
      this.promote(state);
    });
  }
  mcpTurnCredential(
    handle: string,
    turnToken: string,
  ): {
    id: string;
    fencingToken: string;
    baseRevision: string;
    resourceType: 'thread' | 'ticket';
    resourceId: string;
  } {
    this.sweep();
    return this.control.view(state => {
      const request = values(state.requests).find(value => value.turnId === turnToken);
      if (request?.resourceType === 'files') {
        this.claimedFiles(state, handle, turnToken);
        throw new BassfishError(
          'RESOURCE_TYPE_MISMATCH',
          'File locks use native filesystem tools and releaseTurn.',
        );
      }
      const current = this.claimed(state, handle, turnToken, request?.fence ?? '');
      requireThat(
        current.resourceType !== 'project',
        'RESOURCE_TYPE_MISMATCH',
        'This operation requires a content turn.',
      );
      return {
        id: turnToken,
        fencingToken: current.fence!,
        baseRevision: current.baseRevision!,
        resourceType: current.resourceType,
        resourceId: current.resourceId,
      };
    });
  }
  private async claimedSnapshot(
    handle: string,
    requestId: string,
    requireActive = true,
  ): Promise<unknown> {
    this.sweep();
    const file = this.control.view(state => this.ownRequest(state, handle, requestId));
    if (file.resourceType === 'files') {
      if (!requireActive && file.state !== 'CLAIMED')
        return this.control.view(state => this.statusIn(state, file));
      return this.control.view(state =>
        this.fileClaim(this.claimedFiles(state, handle, file.turnId ?? '')),
      );
    }
    const request = this.control.view(state => {
      const current = this.ownRequest(state, handle, requestId);
      requireThat(
        current.resourceType !== 'files',
        'RESOURCE_TYPE_MISMATCH',
        'A content turn is required.',
      );
      requireThat(
        current.resourceType !== 'project',
        'RESOURCE_TYPE_MISMATCH',
        'Project turns are not available through MCP.',
      );
      requireThat(
        current.turnId &&
          current.fence &&
          current.baseRevision &&
          current.snapshotCommit &&
          current.expiresAt,
        'TURN_REQUEST_UNAVAILABLE',
        'This request has not acquired a turn.',
      );
      if (requireActive) this.claimed(state, handle, current.turnId, current.fence);
      return structuredClone(current);
    });
    const snapshot =
      request.resourceType === 'thread'
        ? await this.content.snapshot(
            request.projectId,
            request.resourceId,
            20,
            undefined,
            request.snapshotCommit,
          )
        : await this.content.ticketSnapshot(
            request.projectId,
            request.resourceId,
            undefined,
            request.snapshotCommit,
          );
    if (requireActive) {
      this.sweep();
      this.control.view(state => this.claimed(state, handle, request.turnId!, request.fence!));
    }
    const page =
      snapshot.resourceType === 'thread'
        ? {
            type: 'thread',
            thread: snapshot.thread,
            messages: snapshot.messages,
            truncated: snapshot.truncated,
          }
        : {
            type: 'ticket',
            ticket: describeTicket(
              snapshot.ticket,
              await this.content.listTickets(request.projectId, request.snapshotCommit),
            ),
            ...snapshot.page,
          };
    return {
      requestId: request.id,
      target: { type: snapshot.resourceType, id: request.resourceId },
      turn: { id: request.turnId, fencingToken: request.fence, expiresAt: iso(request.expiresAt!) },
      snapshot: { commit: request.snapshotCommit, revision: request.baseRevision },
      page,
      nextCursor:
        snapshot.resourceType === 'thread' ? snapshot.nextBefore : snapshot.page.nextCursor,
      serverTime: iso(this.clock.now()),
    };
  }
  private ensureTurnTask(handle: string, requestId: string): Record<string, unknown> {
    return this.control.update(state => {
      const actor = this.actor(state, handle);
      const request = this.ownRequest(state, handle, requestId);
      requireThat(
        request.instanceId === actor.instanceId,
        'NOT_TURN_OWNER',
        'Rebind this queue request before resuming it.',
      );
      requireThat(
        request.state === 'QUEUED' || request.state === 'READY',
        'TURN_REQUEST_UNAVAILABLE',
        'Only a queued request can become a Task.',
      );
      let task = values(state.tasks).find(value => value.requestId === request.id);
      if (!task) {
        const now = this.clock.now();
        request.deliveryMode = 'task';
        task = {
          id: request.id,
          projectId: actor.projectId,
          identityId: actor.identityId,
          requestId: request.id,
          status: 'working',
          statusMessage:
            request.state === 'READY'
              ? 'Turn ready; poll the task to claim it.'
              : 'Waiting for the turn.',
          createdAt: now,
          updatedAt: now,
          discardAt: request.queueUntil,
        };
        state.tasks[task.id] = task;
      }
      return this.taskView(task, false);
    });
  }
  async acquireMcpTurn(
    handle: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    taskCapable: boolean,
  ): Promise<unknown> {
    let status: Record<string, unknown>;
    if (args.target) {
      const target = args.target as {
        type: 'thread' | 'ticket' | 'files';
        threadId?: string;
        ticketId?: string;
        paths?: FileTarget[];
      };
      status =
        target.type === 'files'
          ? await this.requestFileTurn(handle, target.paths!, taskCapable ? 'task' : 'ticket')
          : await this.requestResourceTurn(
              handle,
              target.type,
              target.type === 'thread' ? target.threadId! : target.ticketId!,
              taskCapable ? 'task' : 'ticket',
            );
    } else {
      const requestToken = args.requestToken as string;
      this.sweep();
      status = this.control.view(state =>
        this.statusIn(state, this.ownRequest(state, handle, requestToken)),
      );
    }
    if (taskCapable && (status.state === 'queued' || status.state === 'ready')) {
      return { task: this.ensureTurnTask(handle, status.requestId as string) };
    }
    if (status.state === 'queued' || status.state === 'ready') {
      status = (await this.waitForTurn(
        handle,
        status.requestId as string,
        args.timeoutMs as number,
        signal,
      )) as Record<string, unknown>;
    }
    if (status.state === 'offered')
      return presentClaim(await this.claimTurn(handle, status.offerId as string, 20));
    if (status.state === 'claimed')
      return presentClaim(await this.claimedSnapshot(handle, status.requestId as string));
    if (status.state === 'queued' || status.state === 'ready') return presentTurnStatus(status);
    throw new BassfishError(
      'TURN_REQUEST_UNAVAILABLE',
      `The turn request is ${String(status.state)}; start a new acquisition.`,
    );
  }
  async callMcp(
    handle: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
    options: { taskCapable?: boolean } = {},
  ): Promise<unknown> {
    requireThat(Object.hasOwn(mcpSchemas, name), 'UNKNOWN_TOOL', 'Unknown Bassfish MCP operation.');
    const parsed = mcpSchemas[name as McpToolName].safeParse(input);
    requireThat(
      parsed.success,
      'INVALID_ARGUMENT',
      'Arguments do not match the MCP operation schema.',
    );
    this.heartbeat(handle);
    return dispatchMcp(
      this,
      handle,
      name,
      parsed.data as Record<string, unknown>,
      signal,
      Boolean(options.taskCapable),
    );
  }

  async call(
    handle: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
    options: { taskCapable?: boolean } = {},
  ): Promise<unknown> {
    requireThat(Object.hasOwn(adminSchemas, name), 'UNKNOWN_TOOL', 'Unknown Bassfish operation.');
    const parsed = adminSchemas[name as AdminToolName].safeParse(input);
    requireThat(parsed.success, 'INVALID_ARGUMENT', 'Arguments do not match the operation schema.');
    this.heartbeat(handle);
    return dispatchAdmin(
      this,
      handle,
      name,
      parsed.data as Record<string, unknown>,
      signal,
      options,
    );
  }
}
