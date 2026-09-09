import { FakeContent } from './support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bassfish } from '../src/service.js';
import { TursoControl } from '../src/storage/coordination.js';
import { join } from 'node:path';
import { fixture, hold, errorCode } from './support.js';
import type { Turn, Session } from './support.js';
test('offers reveal no content, claims are exclusive, one commit releases to FIFO successor', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, thread } = f;
  const first = await s.requestResourceTurn(a.agentHandle, thread),
    second = await s.requestResourceTurn(b.agentHandle, thread);
  assert.equal(first.state, 'offered');
  assert.equal(second.state, 'queued');
  assert.equal(second.position, 1);
  assert.ok(!JSON.stringify(first).includes('protected'));
  assert.ok(
    JSON.stringify(await s.call(b.agentHandle, 'listThreads', {})).includes(
      'protected description',
    ),
  );
  await assert.rejects(
    s.requestResourceTurn(a.agentHandle, thread),
    errorCode('TURN_REQUEST_EXISTS'),
  );
  await assert.rejects(
    s.claimTurn(b.agentHandle, first.offerId as string, 20),
    errorCode('NOT_TURN_OWNER'),
  );
  await assert.rejects(s.call(b.agentHandle, 'readTurn', {}), errorCode('INVALID_ARGUMENT'));
  const turn = (await s.claimTurn(a.agentHandle, first.offerId as string, 20)) as Turn;
  assert.equal(turn.page.thread.description, 'protected description');
  await assert.rejects(
    s.read(b.agentHandle, turn.turn.id, turn.turn.fencingToken, 20),
    errorCode('NOT_TURN_OWNER'),
  );
  await assert.rejects(
    s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, '0', {
      kind: 'appendMessage',
      body: 'wrong',
    }),
    errorCode('REVISION_CHANGED'),
  );
  const result = await s.commitTurn(
    a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'hello' },
  );
  assert.equal(result.sequence, '1');
  assert.equal(result.revision, '2');
  assert.equal(f.content.writes, 2);
  assert.equal((await s.status(b.agentHandle, second.requestId as string)).state, 'offered');
  await assert.rejects(
    s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
      kind: 'appendMessage',
      body: 'duplicate',
    }),
    errorCode('STALE_TURN'),
  );
  const next = (await s.claimTurn(
    b.agentHandle,
    (await s.status(b.agentHandle, second.requestId as string)).offerId as string,
    20,
  )) as Turn;
  assert.deepEqual(
    next.page.messages.map(m => m.body),
    ['hello'],
  );
  assert.equal(next.turn.fencingToken, '2');
  await assert.rejects(
    s.read(a.agentHandle, turn.turn.id, turn.turn.fencingToken, 20),
    errorCode('STALE_TURN'),
  );
});
test('60-second hard deadline, delayed claim, no renewal, expired content reads rejected after I/O', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, thread, clock } = f;
  const offered = await s.requestResourceTurn(a.agentHandle, thread);
  clock.advance(29000);
  const turn = (await s.claimTurn(a.agentHandle, offered.offerId as string, 20)) as Turn;
  assert.equal(Date.parse(turn.turn.expiresAt) - clock.now(), 60000);
  const queued = await s.requestResourceTurn(b.agentHandle, thread);
  clock.advance(59999);
  await s.heartbeat(a.agentHandle);
  await s.read(a.agentHandle, turn.turn.id, turn.turn.fencingToken, 1);
  clock.advance(1);
  await assert.rejects(
    async () => await s.releaseTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken),
    errorCode('TURN_EXPIRED'),
  );
  await assert.rejects(
    s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
      kind: 'archiveThread',
    }),
    errorCode('TURN_EXPIRED'),
  );
  const next = (await s.claimTurn(
    b.agentHandle,
    (await s.status(b.agentHandle, queued.requestId as string)).offerId as string,
    20,
  )) as Turn;
  f.content.afterSnapshot = () => clock.advance(60000);
  await assert.rejects(
    s.read(b.agentHandle, next.turn.id, next.turn.fencingToken, 1),
    errorCode('TURN_EXPIRED'),
  );
});
test('unclaimed offers expire, cancellation is explicit, wait timeout preserves ticket', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, thread, clock } = f;
  const first = await s.requestResourceTurn(a.agentHandle, thread),
    next = await s.requestResourceTurn(b.agentHandle, thread);
  assert.equal(
    (
      (await s.waitForTurn(b.agentHandle, next.requestId as string, 1)) as {
        state: string;
      }
    ).state,
    'queued',
  );
  clock.advance(30000);
  await assert.rejects(
    s.claimTurn(a.agentHandle, first.offerId as string, 20),
    errorCode('OFFER_EXPIRED'),
  );
  assert.equal((await s.status(b.agentHandle, next.requestId as string)).state, 'offered');
  await s.cancelTurnRequest(b.agentHandle, next.requestId as string);
  assert.equal((await s.status(b.agentHandle, next.requestId as string)).state, 'cancelled');
  const claimed = await hold(s, a.agentHandle, thread);
  const waiter = await s.requestResourceTurn(b.agentHandle, thread);
  const controller = new AbortController();
  const waiting = s.waitForTurn(b.agentHandle, waiter.requestId as string, 100, controller.signal);
  controller.abort();
  await assert.rejects(waiting, errorCode('CANCELLED'));
  assert.equal((await s.status(b.agentHandle, waiter.requestId as string)).state, 'cancelled');
  await s.releaseTurn(a.agentHandle, claimed.turn.id, claimed.turn.fencingToken);
});
test('simultaneous claims and mutations have exactly one winner', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, thread } = f;
  const offer = await s.requestResourceTurn(a.agentHandle, thread);
  const claims = await Promise.allSettled(
    Array.from({ length: 8 }, () => s.claimTurn(a.agentHandle, offer.offerId as string, 20)),
  );
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  const turn = (claims.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Turn>).value;
  const commits = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
        kind: 'appendMessage',
        body: 'once',
      }),
    ),
  );
  assert.equal(commits.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.content.writes, 2);
});
test('accepted COMMITTING reservation survives deadline, disconnect, cancellation and force-release', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, thread, clock } = f;
  const turn = await hold(s, a.agentHandle, thread);
  const queued = await s.requestResourceTurn(b.agentHandle, thread);
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(r => {
    started = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  f.content.beforeWrite = async () => {
    started();
    await gate;
  };
  const writing = s.commitTurn(
    a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'durable' },
  );
  await began;
  clock.advance(31000);
  await s.sweep();
  await s.disconnect(a.agentHandle, false);
  await assert.rejects(async () => await s.forceRelease(turn.turn.id), errorCode('NOT_CLAIMED'));
  assert.equal((await s.status(b.agentHandle, queued.requestId as string)).state, 'queued');
  release();
  await writing;
  assert.equal((await s.status(b.agentHandle, queued.requestId as string)).state, 'offered');
});
test('restart persists identities and FIFO; stale instances and turns never regain ownership', async t => {
  const f = await fixture();
  t.after(async () => {
    await reopened.close();
    await f.close();
  });
  const { service: s, a, b, thread } = f;
  const turn = await hold(s, a.agentHandle, thread);
  const queued = await s.requestResourceTurn(b.agentHandle, thread);
  const original = a.session as Session;
  const bob = b.session as Session;
  const reopened = await TursoControl.open(join(f.dir, 'bassfish.db'));
  const restarted = new Bassfish(reopened, new FakeContent(reopened.store), f.clock);
  await restarted.initialize();
  await assert.rejects(
    restarted.read(a.agentHandle, turn.turn.id, turn.turn.fencingToken, 20),
    errorCode('SESSION_EXPIRED'),
  );
  const a2 = await restarted.open('/repo/.git', 'Alice');
  assert.equal((a2.session as Session).identityId, original.identityId);
  assert.notEqual((a2.session as Session).adapterInstanceId, original.adapterInstanceId);
  const b2 = await restarted.open('/repo/.git', 'bob');
  assert.equal((b2.session as Session).identityId, bob.identityId);
  assert.equal(
    (await restarted.status(b2.agentHandle, queued.requestId as string)).state,
    'offered',
  );
  await assert.rejects(restarted.open('/repo/.git', 'Bob'), errorCode('NAME_IN_USE'));
  await assert.rejects(
    restarted.read(a2.agentHandle, turn.turn.id, turn.turn.fencingToken, 20),
    errorCode('NOT_TURN_OWNER'),
  );
  const otherRepo = await restarted.open('/clone/.git', 'Alice');
  assert.notEqual((otherRepo.session as Session).identityId, original.identityId);
  await assert.rejects(
    restarted.requestResourceTurn(otherRepo.agentHandle, thread),
    errorCode('NOT_FOUND'),
  );
});
test('reconnect grace retains order; clean disconnect cancels; clock discontinuity revokes claimed turns', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, thread, clock } = f;
  const turn = await hold(s, a.agentHandle, thread);
  const queued = await s.requestResourceTurn(b.agentHandle, thread);
  await s.disconnect(b.agentHandle, false);
  await s.releaseTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken);
  const c = await s.open('/repo/.git', 'Carol');
  const third = await s.requestResourceTurn(c.agentHandle, thread);
  assert.equal((await s.status(c.agentHandle, third.requestId as string)).state, 'queued');
  const b2 = await s.open('/repo/.git', 'Bob');
  assert.equal((await s.status(b2.agentHandle, queued.requestId as string)).state, 'offered');
  await s.disconnect(b2.agentHandle);
  assert.equal((await s.status(c.agentHandle, third.requestId as string)).state, 'offered');
  const next = (await s.claimTurn(
    c.agentHandle,
    (await s.status(c.agentHandle, third.requestId as string)).offerId as string,
    20,
  )) as Turn;
  clock.jumped = true;
  await assert.rejects(
    s.read(c.agentHandle, next.turn.id, next.turn.fencingToken, 20),
    errorCode('TURN_EXPIRED'),
  );
});
test('the persisted wall-clock high-water mark rejects offers created after a backward jump', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.service.sweep();
  f.clock.time -= 10000;
  const offered = await f.service.requestResourceTurn(f.a.agentHandle, f.thread);
  assert.equal(offered.state, 'expired');
  assert.equal(
    (await f.service.status(f.a.agentHandle, offered.requestId as string)).state,
    'expired',
  );
});
test('archive and restore serialize with appends; pagination stays within the claimed snapshot', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, thread } = f;
  for (let n = 1; n <= 4; n++) {
    const turn = await hold(s, a.agentHandle, thread);
    await s.commitTurn(
      a.agentHandle,
      turn.turn.id,
      turn.turn.fencingToken,
      turn.snapshot.revision,
      { kind: 'appendMessage', body: `Message ${n}` },
    );
  }
  const offer = await s.requestResourceTurn(a.agentHandle, thread);
  const turn = (await s.claimTurn(a.agentHandle, offer.offerId as string, 2)) as Turn;
  assert.deepEqual(
    turn.page.messages.map(m => m.sequence),
    ['3', '4'],
  );
  assert.equal(turn.nextCursor, '3');
  const earlier = (await s.read(a.agentHandle, turn.turn.id, turn.turn.fencingToken, 2, '3')) as {
    page: {
      messages: {
        sequence: string;
      }[];
    };
  };
  assert.deepEqual(
    earlier.page.messages.map(m => m.sequence),
    ['1', '2'],
  );
  await s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
    kind: 'archiveThread',
  });
  const archived = await hold(s, a.agentHandle, thread);
  await assert.rejects(
    s.commitTurn(
      a.agentHandle,
      archived.turn.id,
      archived.turn.fencingToken,
      archived.snapshot.revision,
      { kind: 'appendMessage', body: 'blocked' },
    ),
    errorCode('RESOURCE_ARCHIVED'),
  );
  await s.commitTurn(
    a.agentHandle,
    archived.turn.id,
    archived.turn.fencingToken,
    archived.snapshot.revision,
    { kind: 'activateThread' },
  );
  assert.equal(
    (
      (await s.call(a.agentHandle, 'listThreads', {})) as {
        threads: unknown[];
      }
    ).threads.length,
    1,
  );
});
test('message retraction and reinstatement are revisioned turn mutations', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, thread } = f;
  let turn = await hold(s, a.agentHandle, thread);
  const appended = await s.commitTurn(
    a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'retain me' },
  );
  turn = await hold(s, a.agentHandle, thread);
  await s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
    kind: 'retractMessage',
    messageId: appended.messageId!,
  });
  turn = await hold(s, a.agentHandle, thread);
  assert.equal(turn.page.messages[0]!.retracted, true);
  assert.equal(turn.page.messages[0]!.body, '');
  await s.commitTurn(a.agentHandle, turn.turn.id, turn.turn.fencingToken, turn.snapshot.revision, {
    kind: 'reinstateMessage',
    messageId: appended.messageId!,
  });
  turn = await hold(s, a.agentHandle, thread);
  assert.equal(turn.page.messages[0]!.retracted, false);
  assert.equal(turn.page.messages[0]!.body, 'retain me');
});

test('a failure after writing content rolls back revisions, notifications, and turn consumption', async t => {
  const f = await fixture();
  t.after(f.close);
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  const cursor = await f.control.activity.head();
  f.content.fail = 'after_write';
  await assert.rejects(
    f.service.commitTurn(
      f.a.agentHandle,
      turn.turn.id,
      turn.turn.fencingToken,
      turn.snapshot.revision,
      { kind: 'appendMessage', body: 'must roll back', mentions: { agents: ['Bob'], here: false } },
    ),
    errorCode('WRITE_FAILED'),
  );
  const projectId = (f.a.session as Session).projectId;
  assert.equal((await f.content.snapshot(projectId, f.thread, 20)).thread.revision, '1');
  assert.equal((await f.content.history(projectId, 'thread', f.thread)).length, 1);
  assert.equal(await f.control.view(async s => (await s.all('notifications')).length), 0);
  assert.equal((await f.service.status(f.a.agentHandle, turn.requestId)).state, 'claimed');
  assert.equal(await f.control.activity.head(), cursor);
  f.content.fail = 'none';
  await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'commits once' },
  );
  assert.equal((await f.content.snapshot(projectId, f.thread, 20)).messages.length, 1);
});

test('independent content commits reach storage concurrently', { timeout: 5000 }, async t => {
  const f = await fixture();
  t.after(f.close);
  const second = (await f.service.call(f.b.agentHandle, 'createThread', {
    title: 'Independent',
    description: '',
  })) as { threadId: string };
  const turns = [
    await hold(f.service, f.a.agentHandle, f.thread),
    await hold(f.service, f.b.agentHandle, second.threadId),
  ];
  let arrived = 0,
    release!: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  f.content.beforeWrite = async () => {
    if (++arrived >= 2) release();
    await barrier;
  };
  const results = await Promise.all(
    turns.map((turn, index) =>
      f.service.call(index ? f.b.agentHandle : f.a.agentHandle, 'commitTurn', {
        turn: { id: turn.turn.id, fencingToken: turn.turn.fencingToken },
        baseRevision: turn.snapshot.revision,
        mutation: { kind: 'appendMessage', body: `independent-${index}` },
      }),
    ),
  );
  assert.equal(results.length, 2);
  assert.ok(arrived >= 2);
});
