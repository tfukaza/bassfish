import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, errorCode } from './support.js';

type Claimed = {
  state: 'claimed';
  turnToken: string;
  resource: { ticketId: string; ready: boolean; blockedBy: string[]; blocks: string[] };
  text: string;
};

test('tickets expose a validated DAG and notify owners when assigned and newly ready', async t => {
  const f = await fixture();
  t.after(f.close);
  const create = (input: Record<string, unknown>) =>
    f.service.callMcp(f.a.agentHandle, 'createResource', {
      resourceType: 'ticket',
      description: 'work',
      owner: 'Bob',
      ...input,
    }) as Promise<{ ticketId: string }>;
  const dependency = await create({ title: 'Dependency', state: 'in_progress' });
  const downstream = await create({
    title: 'Downstream',
    dependsOn: [dependency.ticketId],
    body: '# Work\nqueued',
  });

  const assigned = await f.service
    .callMcp(f.b.agentHandle, 'waitForWork', {})
    .catch(error => error);
  assert.equal((assigned as { code?: string }).code, 'TASKS_REQUIRED');
  const inbox = (await f.service.listNotifications(f.b.agentHandle, 20)) as {
    notifications: { notificationId: string; ticketId: string; reasons: string[] }[];
  };
  assert.equal(
    inbox.notifications.filter(item => item.reasons.includes('ticket_assigned')).length,
    2,
  );
  f.service.ackNotifications(
    f.b.agentHandle,
    inbox.notifications.map(item => item.notificationId),
  );

  const claimed = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: downstream.ticketId },
    timeoutMs: 0,
  })) as Claimed;
  assert.equal(claimed.resource.ready, false);
  assert.deepEqual(claimed.resource.blockedBy, [dependency.ticketId]);
  assert.equal(claimed.text, '# Work\nqueued');
  await f.service.callMcp(f.a.agentHandle, 'releaseTurn', { turnToken: claimed.turnToken });

  const depTurn = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: dependency.ticketId },
    timeoutMs: 0,
  })) as Claimed;
  assert.deepEqual(depTurn.resource.blocks, [downstream.ticketId]);
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'commitTurn', {
      turnToken: depTurn.turnToken,
      mutation: { kind: 'updateTicket', dependsOn: [downstream.ticketId] },
    }),
    errorCode('DEPENDENCY_CYCLE'),
  );
  await f.service.callMcp(f.a.agentHandle, 'releaseTurn', { turnToken: depTurn.turnToken });

  const finish = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: dependency.ticketId },
    timeoutMs: 0,
  })) as Claimed;
  await f.service.callMcp(f.a.agentHandle, 'commitTurn', {
    turnToken: finish.turnToken,
    mutation: { kind: 'updateTicket', state: 'done' },
  });
  const ready = (await f.service.waitForWork(f.b.agentHandle, 0)) as {
    notifications: { ticketId: string; reasons: string[] }[];
  };
  assert.equal(ready.notifications.length, 1);
  assert.equal(ready.notifications[0]!.ticketId, downstream.ticketId);
  assert.deepEqual(ready.notifications[0]!.reasons, ['ticket_ready']);
});

test('ticket discovery defaults to unfinished metadata and body edits stay turn-protected', async t => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'createResource', {
      resourceType: 'ticket',
      title: 'Bad',
      description: 'x',
      owner: 'Nobody',
    }),
    errorCode('UNKNOWN_AGENT'),
  );
  const created = (await f.service.callMcp(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'Ship API',
    description: 'Implement endpoint',
    owner: 'Alice',
  })) as { ticketId: string };
  const turn = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: created.ticketId },
    timeoutMs: 0,
  })) as Claimed;
  await f.service.callMcp(f.a.agentHandle, 'commitTurn', {
    turnToken: turn.turnToken,
    mutation: { kind: 'appendTicketBody', body: '# Notes\nfirst' },
  });
  const found = (await f.service.callMcp(f.a.agentHandle, 'findResources', {
    resourceType: 'ticket',
    query: 'endpoint',
  })) as { resources: { ticketId: string; ready: boolean }[] };
  assert.deepEqual(
    found.resources.map(item => item.ticketId),
    [created.ticketId],
  );
  assert.equal(found.resources[0]!.ready, true);
  const doneTurn = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: created.ticketId },
    timeoutMs: 0,
  })) as Claimed;
  await f.service.callMcp(f.a.agentHandle, 'commitTurn', {
    turnToken: doneTurn.turnToken,
    mutation: { kind: 'updateTicket', state: 'done' },
  });
  const defaultList = (await f.service.callMcp(f.a.agentHandle, 'findResources', {
    resourceType: 'ticket',
  })) as { resources: unknown[] };
  assert.equal(defaultList.resources.length, 0);
  const done = (await f.service.callMcp(f.a.agentHandle, 'findResources', {
    resourceType: 'ticket',
    states: ['done'],
  })) as { resources: { ticketId: string }[] };
  assert.equal(done.resources[0]!.ticketId, created.ticketId);
});
