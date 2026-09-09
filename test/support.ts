import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bassfish, defaultLimits } from '../src/service.js';
import { TursoControl } from '../src/storage/coordination.js';
import { TursoContent } from '../src/storage/content.js';
import { BassfishError } from '../src/domain.js';
import type {
  Clock,
  Thread,
  Message,
  MutationResult,
  WriteOperation,
  StorageResult,
  Snapshot,
} from '../src/domain.js';

export class FakeClock implements Clock {
  time = Date.now();
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
/** Fault injection around the production adapter; all fixture data is real Turso data. */
export class FakeContent extends TursoContent {
  writes = 0;
  fail: 'none' | 'before_write' | 'after_write' = 'none';
  beforeWrite?: () => Promise<void>;
  afterSnapshot?: () => void;
  override async write(operation: WriteOperation): Promise<StorageResult> {
    this.writes++;
    await this.beforeWrite?.();
    if (this.fail === 'before_write')
      throw new BassfishError('WRITE_FAILED', 'Injected write failure.');
    const result = await super.write(operation);
    if (this.fail === 'after_write')
      throw new BassfishError('WRITE_FAILED', 'Injected failure after content.');
    return result;
  }
  override async snapshot(
    projectId: string,
    resourceId: string,
    limit: number,
    before?: string,
    revision?: string,
  ): Promise<Snapshot> {
    const snapshot = await super.snapshot(projectId, resourceId, limit, before, revision);
    this.afterSnapshot?.();
    return snapshot;
  }
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
    type: 'thread' | 'ticket';
    id?: string;
  };
  turn: {
    id: string;
    fencingToken: string;
    expiresAt: string;
  };
  snapshot: {
    revision: string;
  };
  page: {
    type: 'thread';
    thread: Thread;
    messages: Message[];
    truncated: boolean;
  };
  nextCursor: string | null;
  serverTime: string;
}
export async function fixture(
  options: {
    selectAgentName?: (usedNames: Iterable<string>) => string | undefined;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'bf-unit-'));
  const control = await TursoControl.open(join(dir, 'bassfish.db'));
  const content = new FakeContent(control.store),
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
  })) as {
    threadId: string;
  };
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
      await control.close();
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
