import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold } from './support.js';
test('task-capable queued turns wait in READY until an active poll claims and reads the turn', async t => {
  const f = await fixture();
  t.after(f.close);
  const claimed = await hold(f.service, f.a.agentHandle, f.thread);
  const created = (await f.service.call(
    f.b.agentHandle,
    'requestTurn',
    { target: { type: 'thread', id: f.thread } },
    undefined,
    { taskCapable: true },
  )) as {
    task: {
      taskId: string;
      status: string;
    };
  };
  assert.equal(created.task.status, 'working');
  const taskId = created.task.taskId;
  await f.service.call(f.a.agentHandle, 'releaseTurn', {
    turn: { id: claimed.turn.id, fencingToken: claimed.turn.fencingToken },
  });
  const ready = await f.service.getTask(f.b.agentHandle, taskId, false);
  assert.equal(ready.status, 'working');
  assert.match(String(ready.statusMessage), /ready/i);
  f.clock.advance(45000);
  const [completed, repeated] = await Promise.all([
    f.service.getTask(f.b.agentHandle, taskId),
    f.service.getTask(f.b.agentHandle, taskId),
  ]);
  assert.equal(completed.status, 'completed');
  const turn = completed.result as {
    requestId: string;
    turn: {
      id: string;
      fencingToken: string;
    };
    page: unknown;
  };
  assert.equal((repeated.result as typeof turn).turn.id, turn.turn.id);
  assert.equal(turn.requestId, taskId);
  assert.ok(turn.page);
  const ticket = (await f.service.call(f.b.agentHandle, 'getTurnRequest', {
    requestId: taskId,
  })) as {
    state: string;
  };
  assert.equal(ticket.state, 'claimed');
  await f.service.call(f.b.agentHandle, 'releaseTurn', {
    turn: { id: turn.turn.id, fencingToken: turn.turn.fencingToken },
  });
  const replayed = (await f.service.getTask(f.b.agentHandle, taskId)) as {
    result: typeof turn;
  };
  assert.equal(replayed.result.turn.id, turn.turn.id);
  assert.deepEqual(replayed.result.page, turn.page);
});
test('task cancellation cancels queued work but never consumes another turn', async t => {
  const f = await fixture();
  t.after(f.close);
  const claimed = await hold(f.service, f.a.agentHandle, f.thread);
  const created = (await f.service.call(
    f.b.agentHandle,
    'requestTurn',
    { target: { type: 'thread', id: f.thread } },
    undefined,
    { taskCapable: true },
  )) as {
    task: {
      taskId: string;
    };
  };
  const cancelled = await f.service.cancelTask(f.b.agentHandle, created.task.taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    (
      (await f.service.call(f.a.agentHandle, 'getTurnRequest', {
        requestId: claimed.requestId,
      })) as {
        state: string;
      }
    ).state,
    'claimed',
  );
});
