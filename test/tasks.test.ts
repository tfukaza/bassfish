import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold } from './support.js';

test('task-capable queued turns wait in READY until an active poll creates the offer', async t => {
  const f = await fixture(); t.after(f.close); const claimed = await hold(f.service,f.a.agentHandle,f.thread);
  const created = await f.service.call(f.b.agentHandle,'requestTurn',{ target: { type: 'thread', id: f.thread } },undefined,{ taskCapable: true }) as { task: { taskId: string; status: string } };
  assert.equal(created.task.status,'working'); const taskId = created.task.taskId;
  await f.service.call(f.a.agentHandle,'releaseTurn',{ turn: { id: claimed.turn.id, fencingToken: claimed.turn.fencingToken } });
  const ready = f.service.getTask(f.b.agentHandle,taskId,false); assert.equal(ready.status,'working'); assert.match(String(ready.statusMessage),/ready/i);
  f.clock.advance(45_000); const completed = f.service.getTask(f.b.agentHandle,taskId);
  assert.equal(completed.status,'completed'); assert.equal((completed.result as { state: string }).state,'offered');
  const ticket = await f.service.call(f.b.agentHandle,'getTurnRequest',{ requestId: taskId }) as { offerId: string };
  const turn = await f.service.call(f.b.agentHandle,'claimTurn',{ offerId: ticket.offerId }) as { turn: { id: string; fencingToken: string } };
  await f.service.call(f.b.agentHandle,'releaseTurn',{ turn: { id: turn.turn.id, fencingToken: turn.turn.fencingToken } });
});

test('task cancellation cancels queued work but never consumes another turn', async t => {
  const f = await fixture(); t.after(f.close); const claimed = await hold(f.service,f.a.agentHandle,f.thread);
  const created = await f.service.call(f.b.agentHandle,'requestTurn',{ target: { type: 'thread', id: f.thread } },undefined,{ taskCapable: true }) as { task: { taskId: string } };
  const cancelled = f.service.cancelTask(f.b.agentHandle,created.task.taskId); assert.equal(cancelled.status,'cancelled');
  assert.equal((await f.service.call(f.a.agentHandle,'getTurnRequest',{ requestId: claimed.requestId }) as { state: string }).state,'claimed');
});
