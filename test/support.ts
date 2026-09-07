import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Bassfish, defaultLimits } from '../src/service.js';
import { SqliteControl } from '../src/storage/control.js';
import { NoteSearchIndex } from '../src/storage/search.js';
import { BassfishError, notePage } from '../src/domain.js';
import type { Clock, ContentResourceType, ContentStore, HistoricalNote, HistoryEntry, Message, MutationResult, Note, NoteSnapshot, PendingCommit, ProjectHistoryEntry, ProjectRestoreOperation, ProjectRestoreResult, ProjectSnapshot, Resolution, Snapshot, StorageResult, Thread, WriteOperation } from '../src/domain.js';

export class FakeClock implements Clock {
  time = Date.UTC(2026, 8, 6); jumped = false;
  now(): number { return this.time; }
  wallNow(): number { return this.time; }
  discontinuity(): boolean { const jumped = this.jumped; this.jumped = false; return jumped; }
  advance(ms: number): void { this.time += ms; }
}
/** Test fixture only. Production always uses the real SQLite and Dolt adapters. */
export class FakeContent implements ContentStore {
  private projects = new Map<string, { head: string; threads: Thread[]; messages: Message[]; notes: Note[] }>();
  private snapshotHistory = new Map<string, { head: string; threads: Thread[]; messages: Message[]; notes: Note[] }>();
  results = new Map<string, StorageResult>();
  operations: HistoryEntry[] = [];
  writes = 0;
  fail: 'none' | 'absent' | 'unknown' | 'after_commit' = 'none';
  beforeWrite?: () => Promise<void>;
  afterSnapshot?: () => void;
  async ensureProject(id: string): Promise<void> {
    if (!this.projects.has(id)) { const data = { head: randomUUID(), threads: [], messages: [], notes: [] }; this.projects.set(id, data); this.snapshotHistory.set(data.head, structuredClone(data)); }
  }
  async head(id: string): Promise<string> { return this.projects.get(id)!.head; }
  async listThreads(id: string): Promise<Thread[]> { return structuredClone(this.projects.get(id)!.threads); }
  async listNotes(id: string): Promise<Note[]> { return structuredClone(this.projects.get(id)!.notes); }
  async resourceType(id: string, resource: string): Promise<ContentResourceType> {
    const data = this.projects.get(id)!;
    if (data.threads.some(item => item.id === resource)) return 'thread';
    if (data.notes.some(item => item.id === resource)) return 'note';
    throw new BassfishError('NOT_FOUND', 'No resource.');
  }
  async snapshot(id: string, resource: string, limit: number, before?: string, at?: string): Promise<Snapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    const thread = data.threads.find(t => t.id === resource);
    if (!thread) throw new BassfishError('NOT_FOUND', 'No thread.');
    const rows = data.messages.filter(m => m.threadId === resource && (before === undefined || BigInt(m.sequence) < BigInt(before)));
    const messages = rows.slice(-limit);
    this.afterSnapshot?.();
    const visible = structuredClone(messages);
    for (const message of visible) if (message.retracted) message.body = '';
    return structuredClone({ resourceType: 'thread' as const, thread, commit: data.head, messages: visible, truncated: rows.length > limit, nextBefore: rows.length > limit ? visible[0]!.sequence : null });
  }
  async noteSnapshot(id: string, resource: string, cursor?: string, at?: string): Promise<NoteSnapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    const note = data.notes.find(item => item.id === resource);
    if (!note) throw new BassfishError('NOT_FOUND', 'No note.');
    this.afterSnapshot?.();
    return structuredClone({ resourceType: 'note' as const, note, commit: data.head, page: notePage(note.body, cursor) });
  }
  async write(op: WriteOperation | ProjectRestoreOperation): Promise<StorageResult> {
    this.writes++; await this.beforeWrite?.();
    if (this.fail === 'absent' || this.fail === 'unknown') throw new Error('Injected write failure');
    const data = this.projects.get(op.actor.projectId)!;
    if (op.resourceType === 'project') {
      data.threads = structuredClone(op.target.threads); data.messages = structuredClone(op.target.messages); data.notes = structuredClone(op.target.notes);
      const result: ProjectRestoreResult = { operationId: op.id, targetCommit: op.target.commit, previousCommit: op.current.commit, doltCommit: randomUUID(), changes: structuredClone(op.changes) };
      data.head = result.doltCommit; this.snapshotHistory.set(data.head, structuredClone(data)); this.results.set(op.id,result);
      if (this.fail === 'after_commit') throw new Error('Injected lost commit reply');
      return result;
    }
    let prior: number; let revision: string;
    if (op.resourceType === 'thread') {
      prior = data.threads.findIndex(t => t.id === op.resourceId); revision = op.thread.revision;
      if (prior < 0) data.threads.push(structuredClone(op.thread)); else data.threads[prior] = structuredClone(op.thread);
    } else {
      prior = data.notes.findIndex(n => n.id === op.resourceId); revision = op.note.revision;
      if (prior < 0) data.notes.push(structuredClone(op.note)); else data.notes[prior] = structuredClone(op.note);
    }
    const result: MutationResult = { resourceId: op.resourceId, previousRevision: prior < 0 ? '0' : String(BigInt(revision) - 1n), revision, doltCommit: randomUUID() };
    if (op.resourceType === 'thread' && op.mutation.kind === 'appendMessage') {
      data.messages.push({ id: op.id, threadId: op.resourceId, sequence: op.thread.headSequence, identityId: op.actor.identityId, name: op.actor.name, instanceId: op.actor.instanceId, createdAt: op.at, body: op.mutation.body });
      result.messageId = op.id; result.sequence = op.thread.headSequence;
    }
    if (op.resourceType === 'thread' && (op.mutation.kind === 'retractMessage' || op.mutation.kind === 'reinstateMessage')) {
      const mutation = op.mutation;
      const message = data.messages.find(value => value.id === mutation.messageId)!;
      message.retracted = op.mutation.kind === 'retractMessage';
    }
    data.head = result.doltCommit; this.snapshotHistory.set(data.head, structuredClone(data)); this.results.set(op.id, result);
    this.operations.unshift({ operationId: op.id, kind: op.mutation.kind, actorIdentityId: op.actor.identityId, actorName: op.actor.name, instanceId: op.actor.instanceId,
      createdAt: op.at, reason: null, beforeRevision: result.previousRevision, afterRevision: result.revision, doltCommit: result.doltCommit });
    if (this.fail === 'after_commit') throw new Error('Injected lost commit reply');
    return result;
  }
  async history(_id: string, _type: ContentResourceType, resource: string): Promise<HistoryEntry[]> { return this.operations.filter(item => item.operationId && 'resourceId' in this.results.get(item.operationId)! && (this.results.get(item.operationId) as MutationResult).resourceId === resource); }
  async commitAtRevision(_id: string, _type: ContentResourceType, resource: string, revision: string): Promise<string> {
    const entry = this.operations.find(item => { const result = this.results.get(item.operationId); return result && 'resourceId' in result && result.resourceId === resource && item.afterRevision === revision; });
    if (!entry) throw new BassfishError('REVISION_NOT_FOUND', 'No revision.'); return entry.doltCommit;
  }
  async projectSnapshot(id: string, at?: string): Promise<ProjectSnapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    return structuredClone({ commit: data.head, threads: data.threads, messages: data.messages, notes: data.notes, visibility: [] });
  }
  async projectHistory(_id: string): Promise<ProjectHistoryEntry[]> { return this.operations.map(item => ({ operationId: item.operationId, kind: item.kind, actorIdentityId: item.actorIdentityId, actorName: item.actorName, instanceId: item.instanceId, createdAt: item.createdAt, doltCommit: item.doltCommit })); }
  async maxRevision(_id: string, type: ContentResourceType, resource: string): Promise<string> {
    const matches = this.operations.filter(item => { const result = this.results.get(item.operationId); return result && 'resourceId' in result && result.resourceId === resource; }).map(item => BigInt(item.afterRevision));
    return matches.length ? String(matches.reduce((a,b) => a > b ? a : b)) : '0';
  }
  async maxSequence(_id: string, threadId: string): Promise<string> {
    let maximum = 0n; for (const snapshot of this.snapshotHistory.values()) for (const thread of snapshot.threads) if (thread.id === threadId && BigInt(thread.headSequence) > maximum) maximum = BigInt(thread.headSequence);
    return String(maximum);
  }
  async historicalNotes(id: string, at: string): Promise<HistoricalNote[]> {
    const entries: HistoricalNote[] = [];
    for (const operation of [...this.operations].reverse()) {
      const result = this.results.get(operation.operationId); if (!result || !('resourceId' in result)) continue;
      const snapshot = this.snapshotHistory.get(operation.doltCommit); const note = snapshot?.notes.find(value => value.id === result.resourceId);
      if (note) entries.push({ note: structuredClone(note), doltCommit: operation.doltCommit, changedAt: operation.createdAt });
      if (operation.doltCommit === at) break;
    }
    return entries;
  }
  async resolve(pending: PendingCommit): Promise<Resolution> {
    const result = this.results.get(pending.id);
    if (result) return { state: 'committed', result };
    return this.fail === 'unknown' ? { state: 'unknown' } : { state: 'absent' };
  }
  async close(): Promise<void> {}
}
export interface Session { projectId: string; identityId: string; adapterInstanceId: string; name: string; pendingRequests: Ticket[] }
export interface Ticket { state: string; requestId: string; offerId: string; position?: number; result?: MutationResult }
export interface Floor {
  requestId: string;
  target: { type: 'thread' | 'note' | 'project'; id?: string; purpose?: 'snapshot' | 'export' | 'search' | 'restore' };
  floor: { id: string; fencingToken: string; expiresAt: string };
  snapshot: { commit: string; revision: string };
  page: { type: 'thread'; thread: Thread; messages: Message[]; truncated: boolean };
  nextCursor: string | null;
  serverTime: string;
}
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bf-unit-'));
  const control = new SqliteControl(join(dir, 'control.sqlite'));
  const content = new FakeContent(), clock = new FakeClock(), search = new NoteSearchIndex(join(dir,'search.sqlite'));
  // Most domain tests isolate floor expiry from adapter liveness; separate tests exercise both.
  const service = new Bassfish(control, content, clock, { instanceMs: defaultLimits.queueMs },search,dir);
  await service.initialize();
  const a = await service.open('/repo/.git', 'Alice'), b = await service.open('/repo/.git', 'Bob');
  const create = await service.call(a.agentHandle, 'createThread', { title: 'Thread', description: 'protected description' }) as { threadId: string };
  return { dir, control, content, clock, service, a, b, thread: create.threadId,
    close: async () => { search.close(); control.close(); await rm(dir, { recursive: true, force: true }); } };
}
export async function hold(service: Bassfish, handle: string, thread: string): Promise<Floor> {
  const ticket = await service.requestResourceFloor(handle, thread);
  return await service.claimFloor(handle, ticket.offerId as string, 20) as Floor;
}
export const errorCode = (code: string) => (error: unknown): boolean => error instanceof BassfishError && error.code === code;
