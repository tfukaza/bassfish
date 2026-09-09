import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support.js';
import { presentTask } from '../src/mcp-presenters.js';
const privateKeys = new Set([
  'projectId',
  'identityId',
  'adapterInstanceId',
  'instanceId',
  'requestId',
  'offerId',
  'turnId',
  'fencingToken',
  'baseRevision',
  'snapshotCommit',
  'doltCommit',
  'commit',
]);
function assertPublic(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      assert.equal(privateKeys.has(key), false, `private MCP key leaked: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}
test('the MCP boundary presents compact public data and acquires turns in one operation', async t => {
  const f = await fixture();
  t.after(f.close);
  const call = async <T = Record<string, unknown>>(
    handle: string,
    name: string,
    args: unknown = {},
  ): Promise<T> => {
    const value = (await f.service.callMcp(handle, name, args)) as T;
    assertPublic(value);
    return value;
  };
  const context = await call<{
    agentName: string;
    agents: {
      name: string;
    }[];
    pendingTurns: unknown[];
  }>(f.a.agentHandle, 'getContext');
  assert.equal(context.agentName, 'Alice');
  assert.deepEqual(
    context.agents.map(agent => agent.name),
    ['Bob'],
  );
  assert.deepEqual(context.pendingTurns, []);
  const created = await call<{
    threadId: string;
    revision: string;
  }>(f.a.agentHandle, 'createResource', {
    resourceType: 'thread',
    title: 'Public boundary',
    description: 'metadata preview',
  });
  const found = await call<{
    resource: {
      threadId: string;
      descriptionPreview: string;
    };
  }>(f.a.agentHandle, 'findResources', {
    resourceType: 'thread',
    threadId: created.threadId,
  });
  assert.equal(found.resource.descriptionPreview, 'metadata preview');
  const claimed = await call<{
    state: string;
    requestToken: string;
    turnToken: string;
    resource: {
      following: boolean;
    };
    messages: unknown[];
  }>(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'thread', threadId: created.threadId },
  });
  assert.equal(claimed.state, 'claimed');
  assert.ok(claimed.requestToken);
  assert.ok(claimed.turnToken);
  assert.equal(claimed.resource.following, true);
  assert.deepEqual(claimed.messages, []);
  const page = await call<{
    messages: unknown[];
  }>(f.a.agentHandle, 'readTurn', {
    view: 'page',
    turnToken: claimed.turnToken,
  });
  assert.deepEqual(page.messages, []);
  const committed = await call<{
    threadId: string;
    revision: string;
    messageId: string;
  }>(f.a.agentHandle, 'commitTurn', {
    turnToken: claimed.turnToken,
    mutation: {
      kind: 'appendMessage',
      body: '@Bob hello',
      mentions: { agents: ['Bob'], here: false },
    },
  });
  assert.equal(committed.threadId, created.threadId);
  assert.ok(committed.messageId);
  const inbox = await call<{
    notifications: {
      notificationId: string;
      sender: string;
      content: {
        kind: string;
        body: string;
      };
    }[];
  }>(f.b.agentHandle, 'notifications', { action: 'list' });
  assert.equal(inbox.notifications[0]!.sender, 'Alice');
  assert.deepEqual(inbox.notifications[0]!.content, {
    kind: 'thread_message',
    threadTitle: 'Public boundary',
    body: '@Bob hello',
    retracted: false,
  });
  await call(f.b.agentHandle, 'notifications', {
    action: 'acknowledge',
    notificationIds: [inbox.notifications[0]!.notificationId],
  });
  const ticket = await call<{
    ticketId: string;
  }>(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'Public ticket',
    description: 'Work',
    owner: 'Alice',
    body: '# One\nsecret body',
  });
  const ticketTurn = await call<{
    turnToken: string;
    text: string;
  }>(f.a.agentHandle, 'acquireTurn', { target: { type: 'ticket', ticketId: ticket.ticketId } });
  assert.equal(ticketTurn.text, '# One\nsecret body');
  const outline = await call<{
    headings: {
      heading: string;
    }[];
  }>(f.a.agentHandle, 'readTurn', {
    view: 'outline',
    turnToken: ticketTurn.turnToken,
  });
  assert.equal(outline.headings[0]!.heading, 'One');
  const matches = await call<{
    matches: unknown[];
  }>(f.a.agentHandle, 'readTurn', {
    view: 'find',
    turnToken: ticketTurn.turnToken,
    query: 'secret',
  });
  assert.equal(matches.matches.length, 1);
  await call(f.a.agentHandle, 'releaseTurn', { turnToken: ticketTurn.turnToken });
  const holder = await call<{
    turnToken: string;
  }>(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
  });
  const queued = await call<{
    state: string;
    requestToken: string;
  }>(f.b.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
    timeoutMs: 0,
  });
  assert.equal(queued.state, 'queued');
  await call(f.a.agentHandle, 'releaseTurn', { turnToken: holder.turnToken });
  const resumed = await call<{
    state: string;
    requestToken: string;
    turnToken: string;
    text: string;
  }>(f.b.agentHandle, 'acquireTurn', { requestToken: queued.requestToken });
  const replayed = await call<{
    requestToken: string;
    turnToken: string;
    text: string;
  }>(f.b.agentHandle, 'acquireTurn', { requestToken: queued.requestToken });
  assert.equal(resumed.state, 'claimed');
  assert.equal(replayed.turnToken, resumed.turnToken);
  assert.equal(replayed.text, resumed.text);
  await call(f.b.agentHandle, 'releaseTurn', { turnToken: resumed.turnToken });
  const cancelHolder = await call<{
    turnToken: string;
  }>(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
  });
  const abandoned = await call<{
    requestToken: string;
  }>(f.b.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
    timeoutMs: 0,
  });
  const cancelled = await call<{
    state: string;
  }>(f.b.agentHandle, 'cancelTurn', {
    requestToken: abandoned.requestToken,
  });
  assert.equal(cancelled.state, 'cancelled');
  await call(f.a.agentHandle, 'releaseTurn', { turnToken: cancelHolder.turnToken });
  assertPublic(await call(f.a.agentHandle, 'notifications', { action: 'list' }));
});
test('a queued MCP Task claims only when polled and persists only a claim reference', async t => {
  const f = await fixture();
  t.after(f.close);
  const holder = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'thread', threadId: f.thread },
  })) as {
    turnToken: string;
  };
  const created = (await f.service.callMcp(
    f.b.agentHandle,
    'acquireTurn',
    { target: { type: 'thread', threadId: f.thread } },
    undefined,
    { taskCapable: true },
  )) as {
    task: {
      taskId: string;
    };
  };
  const taskId = created.task.taskId;
  await f.service.callMcp(f.a.agentHandle, 'releaseTurn', { turnToken: holder.turnToken });
  const ready = await f.service.getTask(f.b.agentHandle, taskId, false);
  assert.equal(ready.status, 'working');
  assert.equal(
    await f.control.view(async state => (await state.get('requests', taskId))!.state),
    'READY',
  );
  const completed = presentTask(await f.service.getTask(f.b.agentHandle, taskId)) as {
    status: string;
    result: {
      state: string;
      requestToken: string;
      turnToken: string;
      messages: unknown[];
    };
  };
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.state, 'claimed');
  assert.equal(completed.result.requestToken, taskId);
  assert.ok(completed.result.turnToken);
  assert.deepEqual(completed.result.messages, []);
  assertPublic(completed);
  assert.deepEqual(
    await f.control.view(async state => (await state.get('tasks', taskId))!.result),
    { requestId: taskId },
  );
  await f.service.callMcp(f.b.agentHandle, 'releaseTurn', {
    turnToken: completed.result.turnToken,
  });
});
