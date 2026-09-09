import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Bassfish, defaultLimits } from '../src/service.js';
import { SqliteControl } from '../src/storage/control.js';
import { BassfishError, bodyPage } from '../src/domain.js';
import type {
  Clock,
  ContentResourceType,
  ContentStore,
  HistoryEntry,
  Message,
  MutationResult,
  PendingCommit,
  ProjectHistoryEntry,
  ProjectRestoreOperation,
  ProjectRestoreResult,
  ProjectSnapshot,
  Resolution,
  Snapshot,
  StorageResult,
  Thread,
  Ticket as ProjectTicket,
  TicketSnapshot,
  WriteOperation,
} from '../src/domain.js';

export class FakeClock implements Clock {
  time = Date.UTC(2026, 8, 6);
  jumped = false;
  now(): number {
    return this.time;
  }
  wallNow(): number {
    return this.time;
  }
  discontinuity(): boolean {
    const jumped = this.jumped;
    this.jumped = false;
    return jumped;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}
/** Test fixture only. Production always uses the real SQLite and Dolt adapters. */
export class FakeContent implements ContentStore {
  private projects = new Map<
    string,
    { head: string; threads: Thread[]; messages: Message[]; tickets: ProjectTicket[] }
  >();
  private snapshotHistory = new Map<
    string,
    { head: string; threads: Thread[]; messages: Message[]; tickets: ProjectTicket[] }
  >();
  results = new Map<string, StorageResult>();
  operations: HistoryEntry[] = [];
  writes = 0;
  fail: 'none' | 'absent' | 'unknown' | 'after_commit' = 'none';
  beforeWrite?: () => Promise<void>;
  afterSnapshot?: () => void;
  async ensureProject(id: string): Promise<void> {
    if (!this.projects.has(id)) {
      const data = { head: randomUUID(), threads: [], messages: [], tickets: [] };
      this.projects.set(id, data);
      this.snapshotHistory.set(data.head, structuredClone(data));
    }
  }
  async head(id: string): Promise<string> {
    return this.projects.get(id)!.head;
  }
  async listThreads(id: string): Promise<Thread[]> {
    return structuredClone(this.projects.get(id)!.threads);
  }
  async listTickets(id: string, at?: string): Promise<ProjectTicket[]> {
    return structuredClone((at ? this.snapshotHistory.get(at)! : this.projects.get(id)!).tickets);
  }
  async resourceType(id: string, resource: string): Promise<ContentResourceType> {
    const data = this.projects.get(id)!;
    if (data.threads.some(item => item.id === resource)) return 'thread';
    if (data.tickets.some(item => item.id === resource)) return 'ticket';
    throw new BassfishError('NOT_FOUND', 'No resource.');
  }
  async snapshot(
    id: string,
    resource: string,
    limit: number,
    before?: string,
    at?: string,
  ): Promise<Snapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    const thread = data.threads.find(t => t.id === resource);
    if (!thread) throw new BassfishError('NOT_FOUND', 'No thread.');
    const rows = data.messages.filter(
      m => m.threadId === resource && (before === undefined || BigInt(m.sequence) < BigInt(before)),
    );
    const messages = rows.slice(-limit);
    this.afterSnapshot?.();
    const visible = structuredClone(messages);
    for (const message of visible) if (message.retracted) message.body = '';
    return structuredClone({
      resourceType: 'thread' as const,
      thread,
      commit: data.head,
      messages: visible,
      truncated: rows.length > limit,
      nextBefore: rows.length > limit ? visible[0]!.sequence : null,
    });
  }
  async ticketSnapshot(
    id: string,
    resource: string,
    cursor?: string,
    at?: string,
  ): Promise<TicketSnapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    const ticket = data.tickets.find(item => item.id === resource);
    if (!ticket) throw new BassfishError('NOT_FOUND', 'No ticket.');
    this.afterSnapshot?.();
    return structuredClone({
      resourceType: 'ticket' as const,
      ticket,
      commit: data.head,
      page: bodyPage(ticket.body, cursor),
    });
  }
  async write(op: WriteOperation | ProjectRestoreOperation): Promise<StorageResult> {
    this.writes++;
    await this.beforeWrite?.();
    if (this.fail === 'absent' || this.fail === 'unknown')
      throw new Error('Injected write failure');
    const data = this.projects.get(op.actor.projectId)!;
    if (op.resourceType === 'project') {
      data.threads = structuredClone(op.target.threads);
      data.messages = structuredClone(op.target.messages);
      data.tickets = structuredClone(op.target.tickets);
      const result: ProjectRestoreResult = {
        operationId: op.id,
        targetCommit: op.target.commit,
        previousCommit: op.current.commit,
        doltCommit: randomUUID(),
        changes: structuredClone(op.changes),
      };
      data.head = result.doltCommit;
      this.snapshotHistory.set(data.head, structuredClone(data));
      this.results.set(op.id, result);
      if (this.fail === 'after_commit') throw new Error('Injected lost commit reply');
      return result;
    }
    let prior: number;
    let revision: string;
    if (op.resourceType === 'thread') {
      prior = data.threads.findIndex(t => t.id === op.resourceId);
      revision = op.thread.revision;
      if (prior < 0) data.threads.push(structuredClone(op.thread));
      else data.threads[prior] = structuredClone(op.thread);
    } else {
      prior = data.tickets.findIndex(ticket => ticket.id === op.resourceId);
      revision = op.ticket.revision;
      if (prior < 0) data.tickets.push(structuredClone(op.ticket));
      else data.tickets[prior] = structuredClone(op.ticket);
    }
    const result: MutationResult = {
      resourceId: op.resourceId,
      previousRevision: prior < 0 ? '0' : String(BigInt(revision) - 1n),
      revision,
      doltCommit: randomUUID(),
    };
    if (op.resourceType === 'thread' && op.mutation.kind === 'appendMessage') {
      data.messages.push({
        id: op.id,
        threadId: op.resourceId,
        sequence: op.thread.headSequence,
        identityId: op.actor.identityId,
        name: op.actor.name,
        instanceId: op.actor.instanceId,
        createdAt: op.at,
        body: op.mutation.body,
        mentions: {
          agents: op.mutation.mentions?.agents ?? [],
          here: op.mutation.mentions?.here ?? false,
          global: op.mutation.mentions?.global ?? false,
        },
      });
      result.messageId = op.id;
      result.sequence = op.thread.headSequence;
    }
    if (
      op.resourceType === 'thread' &&
      (op.mutation.kind === 'retractMessage' || op.mutation.kind === 'reinstateMessage')
    ) {
      const mutation = op.mutation;
      const message = data.messages.find(value => value.id === mutation.messageId)!;
      message.retracted = op.mutation.kind === 'retractMessage';
    }
    data.head = result.doltCommit;
    this.snapshotHistory.set(data.head, structuredClone(data));
    this.results.set(op.id, result);
    this.operations.unshift({
      operationId: op.id,
      kind: op.mutation.kind,
      actorIdentityId: op.actor.identityId,
      actorName: op.actor.name,
      instanceId: op.actor.instanceId,
      createdAt: op.at,
      reason: null,
      beforeRevision: result.previousRevision,
      afterRevision: result.revision,
      doltCommit: result.doltCommit,
    });
    if (this.fail === 'after_commit') throw new Error('Injected lost commit reply');
    return result;
  }
  async history(
    _id: string,
    _type: ContentResourceType,
    resource: string,
  ): Promise<HistoryEntry[]> {
    return this.operations.filter(
      item =>
        item.operationId &&
        'resourceId' in this.results.get(item.operationId)! &&
        (this.results.get(item.operationId) as MutationResult).resourceId === resource,
    );
  }
  async commitAtRevision(
    _id: string,
    _type: ContentResourceType,
    resource: string,
    revision: string,
  ): Promise<string> {
    const entry = this.operations.find(item => {
      const result = this.results.get(item.operationId);
      return (
        result &&
        'resourceId' in result &&
        result.resourceId === resource &&
        item.afterRevision === revision
      );
    });
    if (!entry) throw new BassfishError('REVISION_NOT_FOUND', 'No revision.');
    return entry.doltCommit;
  }
  async projectSnapshot(id: string, at?: string): Promise<ProjectSnapshot> {
    const data = at ? this.snapshotHistory.get(at)! : this.projects.get(id)!;
    return structuredClone({
      commit: data.head,
      threads: data.threads,
      messages: data.messages,
      tickets: data.tickets,
      visibility: [],
    });
  }
  async projectHistory(_id: string): Promise<ProjectHistoryEntry[]> {
    return this.operations.map(item => ({
      operationId: item.operationId,
      kind: item.kind,
      actorIdentityId: item.actorIdentityId,
      actorName: item.actorName,
      instanceId: item.instanceId,
      createdAt: item.createdAt,
      doltCommit: item.doltCommit,
    }));
  }
  async maxRevision(_id: string, _type: ContentResourceType, resource: string): Promise<string> {
    const matches = this.operations
      .filter(item => {
        const result = this.results.get(item.operationId);
        return result && 'resourceId' in result && result.resourceId === resource;
      })
      .map(item => BigInt(item.afterRevision));
    return matches.length ? String(matches.reduce((a, b) => (a > b ? a : b))) : '0';
  }
  async maxSequence(_id: string, threadId: string): Promise<string> {
    let maximum = 0n;
    for (const snapshot of this.snapshotHistory.values())
      for (const thread of snapshot.threads)
        if (thread.id === threadId && BigInt(thread.headSequence) > maximum)
          maximum = BigInt(thread.headSequence);
    return String(maximum);
  }
  async resolve(pending: PendingCommit): Promise<Resolution> {
    const result = this.results.get(pending.id);
    if (result) return { state: 'committed', result };
    return this.fail === 'unknown' ? { state: 'unknown' } : { state: 'absent' };
  }
  async close(): Promise<void> {}
}
export interface Session {
  projectId: string;
  identityId: string;
  adapterInstanceId: string;
  name: string;
  pendingRequests: Ticket[];
}
export interface Ticket {
  state: string;
  requestId: string;
  offerId: string;
  position?: number;
  result?: MutationResult;
}
export interface Turn {
  requestId: string;
  target: {
    type: 'thread' | 'ticket' | 'project';
    id?: string;
    purpose?: 'snapshot' | 'export' | 'restore';
  };
  turn: { id: string; fencingToken: string; expiresAt: string };
  snapshot: { commit: string; revision: string };
  page: { type: 'thread'; thread: Thread; messages: Message[]; truncated: boolean };
  nextCursor: string | null;
  serverTime: string;
}
export async function fixture(
  options: { selectAgentName?: (usedNames: Iterable<string>) => string | undefined } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'bf-unit-'));
  const control = new SqliteControl(join(dir, 'control.sqlite'));
  const content = new FakeContent(),
    clock = new FakeClock();
  // Most domain tests isolate turn expiry from adapter liveness; separate tests exercise both.
  const service = new Bassfish(
    control,
    content,
    clock,
    { instanceMs: defaultLimits.queueMs },
    dir,
    options.selectAgentName,
  );
  await service.initialize();
  const a = await service.open('/repo/.git', 'Alice', undefined, dir),
    b = await service.open('/repo/.git', 'Bob', undefined, dir);
  const create = (await service.call(a.agentHandle, 'createThread', {
    title: 'Thread',
    description: 'protected description',
  })) as { threadId: string };
  return {
    dir,
    control,
    content,
    clock,
    service,
    a,
    b,
    thread: create.threadId,
    close: async () => {
      control.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function hold(service: Bassfish, handle: string, thread: string): Promise<Turn> {
  const ticket = await service.requestResourceTurn(handle, thread);
  return (await service.claimTurn(handle, ticket.offerId as string, 20)) as Turn;
}
export const errorCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof BassfishError && error.code === code;
