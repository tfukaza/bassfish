import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support.js';

type FileTurn = {
  state: 'claimed' | 'queued';
  requestToken: string;
  turnToken?: string;
};

type ThreadPage = {
  resources: Array<{ threadId: string; title: string; createdAt: string }>;
  nextCursor: string | null;
};

type ThreadTurn = {
  turnToken: string;
  messages: Array<{ author: string; retracted?: boolean }>;
  nextCursor: string | null;
};

test('the guarded skill bootstrap reuses one introductions thread and introduces each identity once', async t => {
  const f = await fixture();
  t.after(f.close);

  const call = <T>(handle: string, name: string, args: Record<string, unknown>) =>
    f.service.callMcp(handle, name, args) as Promise<T>;
  const findIntroductions = (handle: string) =>
    call<ThreadPage>(handle, 'findResources', {
      resourceType: 'thread',
      query: 'Introductions',
      state: 'active',
      limit: 50,
    });
  const creationTarget = {
    type: 'files' as const,
    paths: [{ path: '.bassfish/resource-creation.lock', kind: 'file' as const }],
  };

  assert.deepEqual((await findIntroductions(f.a.agentHandle)).resources, []);
  assert.deepEqual((await findIntroductions(f.b.agentHandle)).resources, []);

  const aliceLock = await call<FileTurn>(f.a.agentHandle, 'acquireTurn', {
    target: creationTarget,
    timeoutMs: 0,
  });
  const bobQueue = await call<FileTurn>(f.b.agentHandle, 'acquireTurn', {
    target: creationTarget,
    timeoutMs: 0,
  });
  assert.equal(aliceLock.state, 'claimed');
  assert.equal(bobQueue.state, 'queued');

  assert.deepEqual((await findIntroductions(f.a.agentHandle)).resources, []);
  const created = await call<{ threadId: string }>(f.a.agentHandle, 'createResource', {
    resourceType: 'thread',
    title: 'Introductions',
    description: 'Shared team roster and agent introductions for this repository.',
  });
  await call(f.a.agentHandle, 'releaseTurn', { turnToken: aliceLock.turnToken });

  const bobLock = await call<FileTurn>(f.b.agentHandle, 'acquireTurn', {
    requestToken: bobQueue.requestToken,
    timeoutMs: 0,
  });
  assert.equal(bobLock.state, 'claimed');
  assert.equal((await findIntroductions(f.b.agentHandle)).resources[0]?.threadId, created.threadId);
  await call(f.b.agentHandle, 'releaseTurn', { turnToken: bobLock.turnToken });
  assert.equal((await findIntroductions(f.a.agentHandle)).resources.length, 1);

  const introduce = async (handle: string, agentName: string) => {
    const turn = await call<ThreadTurn>(handle, 'acquireTurn', {
      target: { type: 'thread', threadId: created.threadId },
    });
    const messages = [...turn.messages];
    let cursor = turn.nextCursor;
    while (cursor) {
      const page = await call<Pick<ThreadTurn, 'messages' | 'nextCursor'>>(handle, 'readTurn', {
        view: 'page',
        turnToken: turn.turnToken,
        cursor,
      });
      messages.push(...page.messages);
      cursor = page.nextCursor;
    }
    if (messages.some(message => !message.retracted && message.author === agentName)) {
      await call(handle, 'releaseTurn', { turnToken: turn.turnToken });
      return;
    }
    await call(handle, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: {
        kind: 'appendMessage',
        body: `${messages.length === 0 ? '@global ' : ''}Hi, I'm ${agentName}. Role: collaborating agent. Current scope: available for coordination.`,
        ...(messages.length === 0 ? { mentions: { agents: [], here: false, global: true } } : {}),
      },
    });
  };

  await introduce(f.a.agentHandle, 'Alice');
  await introduce(f.b.agentHandle, 'Bob');
  await introduce(f.a.agentHandle, 'Alice');

  const bobInbox = await call<{
    notifications: Array<{ reasons: string[]; content: { body: string } }>;
  }>(f.b.agentHandle, 'notifications', { action: 'list' });
  assert.ok(bobInbox.notifications[0]!.reasons.includes('global'));
  assert.match(bobInbox.notifications[0]!.content.body, /^@global/);

  const final = await call<ThreadTurn>(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'thread', threadId: created.threadId },
  });
  assert.deepEqual(final.messages.map(message => message.author).sort(), ['Alice', 'Bob']);
  await call(f.a.agentHandle, 'releaseTurn', { turnToken: final.turnToken });
});
