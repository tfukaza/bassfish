import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bassfish } from '../src/service.js';
import { SqliteControl } from '../src/storage/control.js';
import { join } from 'node:path';
import { fixture, hold, errorCode } from './support.js';
import type { Floor, Session } from './support.js';

test('offers reveal no content, claims are exclusive, one commit releases to FIFO successor', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, thread } = f;
  const first = await s.requestResourceFloor(a.agentHandle, thread), second = await s.requestResourceFloor(b.agentHandle, thread);
  assert.equal(first.state, 'offered'); assert.equal(second.state, 'queued'); assert.equal(second.position, 1);
  assert.ok(!JSON.stringify(first).includes('protected')); assert.ok(JSON.stringify(await s.call(b.agentHandle, 'listThreads', {})).includes('protected description'));
  await assert.rejects(s.requestResourceFloor(a.agentHandle, thread), errorCode('FLOOR_REQUEST_EXISTS'));
  await assert.rejects(s.claimFloor(b.agentHandle, first.offerId as string, 20), errorCode('NOT_FLOOR_OWNER'));
  await assert.rejects(s.call(b.agentHandle, 'readFloor', {}), errorCode('INVALID_ARGUMENT'));
  const floor = await s.claimFloor(a.agentHandle, first.offerId as string, 20) as Floor;
  assert.equal(floor.page.thread.description, 'protected description');
  await assert.rejects(s.read(b.agentHandle, floor.floor.id, floor.floor.fencingToken, 20), errorCode('NOT_FLOOR_OWNER'));
  await assert.rejects(s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, '0', { kind: 'appendMessage', body: 'wrong' }), errorCode('REVISION_CHANGED'));
  const result = await s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: 'hello' });
  assert.equal(result.sequence, '1'); assert.equal(result.revision, '2'); assert.equal(f.content.writes, 2);
  assert.equal(s.status(b.agentHandle, second.requestId as string).state, 'offered');
  await assert.rejects(s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: 'duplicate' }), errorCode('STALE_FLOOR'));
  const next = await s.claimFloor(b.agentHandle, s.status(b.agentHandle, second.requestId as string).offerId as string, 20) as Floor;
  assert.deepEqual(next.page.messages.map(m => m.body), ['hello']); assert.equal(next.floor.fencingToken, '2');
  await assert.rejects(s.read(a.agentHandle, floor.floor.id, floor.floor.fencingToken, 20), errorCode('STALE_FLOOR'));
});

test('30-second hard deadline, delayed claim, no renewal, expired content reads rejected after I/O', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, thread, clock } = f;
  const offered = await s.requestResourceFloor(a.agentHandle, thread);
  clock.advance(29_000);
  const floor = await s.claimFloor(a.agentHandle, offered.offerId as string, 20) as Floor;
  assert.equal(Date.parse(floor.floor.expiresAt) - clock.now(), 30_000);
  const queued = await s.requestResourceFloor(b.agentHandle, thread);
  clock.advance(29_999); s.heartbeat(a.agentHandle); await s.read(a.agentHandle, floor.floor.id, floor.floor.fencingToken, 1);
  clock.advance(1);
  assert.throws(() => s.releaseFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken), errorCode('FLOOR_EXPIRED'));
  await assert.rejects(s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'archiveThread' }), errorCode('FLOOR_EXPIRED'));
  const next = await s.claimFloor(b.agentHandle, s.status(b.agentHandle, queued.requestId as string).offerId as string, 20) as Floor;
  f.content.afterSnapshot = () => clock.advance(30_000);
  await assert.rejects(s.read(b.agentHandle, next.floor.id, next.floor.fencingToken, 1), errorCode('FLOOR_EXPIRED'));
});

test('unclaimed offers expire, cancellation is explicit, wait timeout preserves ticket', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, thread, clock } = f;
  const first = await s.requestResourceFloor(a.agentHandle, thread), next = await s.requestResourceFloor(b.agentHandle, thread);
  assert.equal((await s.waitForFloor(b.agentHandle, next.requestId as string, 1) as { state: string }).state, 'queued');
  clock.advance(30_000);
  await assert.rejects(s.claimFloor(a.agentHandle, first.offerId as string, 20), errorCode('OFFER_EXPIRED'));
  assert.equal(s.status(b.agentHandle, next.requestId as string).state, 'offered');
  s.cancelFloorRequest(b.agentHandle, next.requestId as string);
  assert.equal(s.status(b.agentHandle, next.requestId as string).state, 'cancelled');
  const held = await hold(s, a.agentHandle, thread);
  const waiter = await s.requestResourceFloor(b.agentHandle, thread); const controller = new AbortController();
  const waiting = s.waitForFloor(b.agentHandle, waiter.requestId as string, 100, controller.signal); controller.abort();
  await assert.rejects(waiting, errorCode('CANCELLED'));
  assert.equal(s.status(b.agentHandle, waiter.requestId as string).state, 'cancelled');
  s.releaseFloor(a.agentHandle, held.floor.id, held.floor.fencingToken);
});

test('simultaneous claims and mutations have exactly one winner', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, thread } = f;
  const offer = await s.requestResourceFloor(a.agentHandle, thread);
  const claims = await Promise.allSettled(Array.from({ length: 8 }, () => s.claimFloor(a.agentHandle, offer.offerId as string, 20)));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  const floor = (claims.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Floor>).value;
  const commits = await Promise.allSettled(Array.from({ length: 8 }, () => s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: 'once' })));
  assert.equal(commits.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.content.writes, 2);
});

test('accepted COMMITTING reservation survives deadline, disconnect, cancellation and force-release', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, thread, clock } = f;
  const floor = await hold(s, a.agentHandle, thread); const queued = await s.requestResourceFloor(b.agentHandle, thread);
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
  f.content.beforeWrite = async () => { started(); await gate; };
  const writing = s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: 'durable' });
  await began; clock.advance(31_000); s.sweep(); s.disconnect(a.agentHandle, false);
  assert.throws(() => s.forceRelease(floor.floor.id), errorCode('NOT_HELD'));
  assert.equal(s.status(b.agentHandle, queued.requestId as string).state, 'queued');
  release(); await writing;
  assert.equal(s.status(b.agentHandle, queued.requestId as string).state, 'offered');
});

test('lost commit reply resolves without replay; absent fails; unknown protects every project write', async t => {
  for (const failure of ['after_commit', 'absent', 'unknown'] as const) await t.test(failure, async t => {
    const f = await fixture(); t.after(f.close); const { service: s, a, b, thread } = f;
    const floor = await hold(s, a.agentHandle, thread); const queued = await s.requestResourceFloor(b.agentHandle, thread); f.content.fail = failure;
    const writing = s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: 'one write' });
    if (failure === 'after_commit') assert.equal((await writing).sequence, '1');
    else await assert.rejects(writing, errorCode(failure === 'unknown' ? 'OUTCOME_UNKNOWN' : 'WRITE_FAILED'));
    assert.equal(f.content.writes, 2);
    assert.equal(s.status(b.agentHandle, queued.requestId as string).state, failure === 'unknown' ? 'queued' : 'offered');
    if (failure === 'unknown') {
      await assert.rejects(s.createThread(b.agentHandle, 'Blocked', ''), errorCode('PROJECT_RECOVERING'));
      assert.throws(() => s.forceRelease(floor.floor.id), errorCode('NOT_HELD'));
      assert.equal(f.control.view(s => Object.values(s.pending).length), 1);
    }
  });
});

test('restart persists identities and FIFO; stale instances and floors never regain ownership', async t => {
  const f = await fixture(); t.after(async () => { reopened.close(); await f.close(); });
  const { service: s, a, b, thread } = f;
  const floor = await hold(s, a.agentHandle, thread); const queued = await s.requestResourceFloor(b.agentHandle, thread);
  const original = a.session as Session; const bob = b.session as Session;
  const reopened = new SqliteControl(join(f.dir, 'control.sqlite'));
  const restarted = new Bassfish(reopened, f.content, f.clock);
  await restarted.initialize();
  await assert.rejects(restarted.read(a.agentHandle, floor.floor.id, floor.floor.fencingToken, 20), errorCode('SESSION_EXPIRED'));
  const a2 = await restarted.open('/repo/.git', 'Alice');
  assert.equal((a2.session as Session).identityId, original.identityId);
  assert.notEqual((a2.session as Session).adapterInstanceId, original.adapterInstanceId);
  const b2 = await restarted.open('/repo/.git', 'bob');
  assert.equal((b2.session as Session).identityId, bob.identityId);
  assert.equal(restarted.status(b2.agentHandle, queued.requestId as string).state, 'offered');
  await assert.rejects(restarted.open('/repo/.git', 'Bob'), errorCode('NAME_IN_USE'));
  await assert.rejects(restarted.read(a2.agentHandle, floor.floor.id, floor.floor.fencingToken, 20), errorCode('NOT_FLOOR_OWNER'));
  const otherRepo = await restarted.open('/clone/.git', 'Alice'); assert.notEqual((otherRepo.session as Session).identityId, original.identityId);
  await assert.rejects(restarted.requestResourceFloor(otherRepo.agentHandle, thread), errorCode('NOT_FOUND'));
});

test('reconnect grace retains order; clean disconnect cancels; clock discontinuity revokes held floors', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, thread, clock } = f;
  const floor = await hold(s, a.agentHandle, thread); const queued = await s.requestResourceFloor(b.agentHandle, thread);
  s.disconnect(b.agentHandle, false); s.releaseFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken);
  const c = await s.open('/repo/.git', 'Carol'); const third = await s.requestResourceFloor(c.agentHandle, thread);
  assert.equal(s.status(c.agentHandle, third.requestId as string).state, 'queued');
  const b2 = await s.open('/repo/.git', 'Bob'); assert.equal(s.status(b2.agentHandle, queued.requestId as string).state, 'offered');
  s.disconnect(b2.agentHandle); assert.equal(s.status(c.agentHandle, third.requestId as string).state, 'offered');
  const next = await s.claimFloor(c.agentHandle, s.status(c.agentHandle, third.requestId as string).offerId as string, 20) as Floor;
  clock.jumped = true; await assert.rejects(s.read(c.agentHandle, next.floor.id, next.floor.fencingToken, 20), errorCode('FLOOR_EXPIRED'));
});

test('the persisted wall-clock high-water mark rejects offers created after a backward jump', async t => {
  const f = await fixture(); t.after(f.close); f.service.sweep();
  f.clock.time -= 10_000;
  const offered = await f.service.requestResourceFloor(f.a.agentHandle,f.thread);
  assert.equal(offered.state,'expired');
  assert.equal(f.service.status(f.a.agentHandle,offered.requestId as string).state,'expired');
});

test('archive and restore serialize with appends; pagination stays within the claimed snapshot', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, thread } = f;
  for (let n = 1; n <= 4; n++) {
    const floor = await hold(s, a.agentHandle, thread);
    await s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'appendMessage', body: `Message ${n}` });
  }
  const offer = await s.requestResourceFloor(a.agentHandle, thread); const floor = await s.claimFloor(a.agentHandle, offer.offerId as string, 2) as Floor;
  assert.deepEqual(floor.page.messages.map(m => m.sequence), ['3', '4']); assert.equal(floor.nextCursor, '3');
  const earlier = await s.read(a.agentHandle, floor.floor.id, floor.floor.fencingToken, 2, '3') as { page: { messages: { sequence: string }[] } };
  assert.deepEqual(earlier.page.messages.map(m => m.sequence), ['1', '2']);
  await s.commitFloor(a.agentHandle, floor.floor.id, floor.floor.fencingToken, floor.snapshot.revision, { kind: 'archiveThread' });
  const archived = await hold(s, a.agentHandle, thread);
  await assert.rejects(s.commitFloor(a.agentHandle, archived.floor.id, archived.floor.fencingToken, archived.snapshot.revision, { kind: 'appendMessage', body: 'blocked' }), errorCode('RESOURCE_ARCHIVED'));
  await s.commitFloor(a.agentHandle, archived.floor.id, archived.floor.fencingToken, archived.snapshot.revision, { kind: 'activateThread' });
  assert.equal((await s.call(a.agentHandle, 'listThreads', {}) as { threads: unknown[] }).threads.length, 1);
});

test('message retraction and reinstatement are revisioned floor mutations', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, thread } = f;
  let floor = await hold(s,a.agentHandle,thread);
  const appended = await s.commitFloor(a.agentHandle,floor.floor.id,floor.floor.fencingToken,floor.snapshot.revision,{ kind: 'appendMessage', body: 'retain me' });
  floor = await hold(s,a.agentHandle,thread);
  await s.commitFloor(a.agentHandle,floor.floor.id,floor.floor.fencingToken,floor.snapshot.revision,{ kind: 'retractMessage', messageId: appended.messageId! });
  floor = await hold(s,a.agentHandle,thread);
  assert.equal(floor.page.messages[0]!.retracted,true); assert.equal(floor.page.messages[0]!.body,'');
  await s.commitFloor(a.agentHandle,floor.floor.id,floor.floor.fencingToken,floor.snapshot.revision,{ kind: 'reinstateMessage', messageId: appended.messageId! });
  floor = await hold(s,a.agentHandle,thread);
  assert.equal(floor.page.messages[0]!.retracted,false); assert.equal(floor.page.messages[0]!.body,'retain me');
});
