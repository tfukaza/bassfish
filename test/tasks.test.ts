import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold } from './support.js';

test('task-capable queued floors wait in READY until an active poll creates the offer', async t => {
  const f = await fixture(); t.after(f.close); const held = await hold(f.service,f.a.agentHandle,f.thread);
  const created = await f.service.call(f.b.agentHandle,'requestFloor',{ target: { type: 'thread', id: f.thread } },undefined,{ taskCapable: true }) as { task: { taskId: string; status: string } };
  assert.equal(created.task.status,'working'); const taskId = created.task.taskId;
  await f.service.call(f.a.agentHandle,'releaseFloor',{ floor: { id: held.floor.id, fencingToken: held.floor.fencingToken } });
  const ready = f.service.getTask(f.b.agentHandle,taskId,false); assert.equal(ready.status,'working'); assert.match(String(ready.statusMessage),/ready/i);
  f.clock.advance(45_000); const completed = f.service.getTask(f.b.agentHandle,taskId);
  assert.equal(completed.status,'completed'); assert.equal((completed.result as { state: string }).state,'offered');
  const ticket = await f.service.call(f.b.agentHandle,'getFloorRequest',{ requestId: taskId }) as { offerId: string };
  const floor = await f.service.call(f.b.agentHandle,'claimFloor',{ offerId: ticket.offerId }) as { floor: { id: string; fencingToken: string } };
  await f.service.call(f.b.agentHandle,'releaseFloor',{ floor: { id: floor.floor.id, fencingToken: floor.floor.fencingToken } });
});

test('task cancellation cancels queued work but never consumes another floor', async t => {
  const f = await fixture(); t.after(f.close); const held = await hold(f.service,f.a.agentHandle,f.thread);
  const created = await f.service.call(f.b.agentHandle,'requestFloor',{ target: { type: 'thread', id: f.thread } },undefined,{ taskCapable: true }) as { task: { taskId: string } };
  const cancelled = f.service.cancelTask(f.b.agentHandle,created.task.taskId); assert.equal(cancelled.status,'cancelled');
  assert.equal((await f.service.call(f.a.agentHandle,'getFloorRequest',{ requestId: held.requestId }) as { state: string }).state,'held');
});
