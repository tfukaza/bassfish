import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold, errorCode } from './support.js';
import { generatedAgentNames } from '../src/agent-names.js';

test('anonymous sessions receive distinct pool names that are never auto-reclaimed', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service } = f;
  const first = await service.open('/repo/.git');
  const firstName = (first.session as { name: string }).name;
  assert.ok(generatedAgentNames.includes(firstName));
  service.disconnect(first.agentHandle);
  const second = await service.open('/repo/.git');
  const secondName = (second.session as { name: string }).name;
  assert.ok(generatedAgentNames.includes(secondName));
  assert.notEqual(secondName, firstName);
  service.disconnect(second.agentHandle);
});

test('anonymous registration fails cleanly when the generated-name pool is exhausted', async t => {
  const f = await fixture({ selectAgentName: () => undefined });
  t.after(f.close);
  await assert.rejects(f.service.open('/repo/.git'), errorCode('NAME_POOL_EXHAUSTED'));
});

test('structured mentions, @here, follows, offline delivery, and acknowledgement are deterministic', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  const charlie = await service.open('/repo/.git', 'Charlie');
  service.disconnect(charlie.agentHandle);

  // Claiming follows automatically; Alice already follows because she created the thread.
  const bobRead = await hold(service, b.agentHandle, thread);
  service.releaseTurn(b.agentHandle, bobRead.turn.id, bobRead.turn.fencingToken);
  const turn = await hold(service, a.agentHandle, thread);
  await service.commitTurn(
    a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    {
      kind: 'appendMessage',
      body: '@Bob and @Charlie, please look. @here',
      mentions: { agents: ['bob', 'Charlie'], here: true },
    },
  );

  const bobInbox = (await service.call(b.agentHandle, 'listNotifications', {})) as {
    notifications: { notificationId: string; reasons: string[] }[];
  };
  assert.deepEqual(bobInbox.notifications[0]!.reasons, [
    'followed_message',
    'direct_mention',
    'here',
  ]);
  const offline = f.control.view(state =>
    Object.values(state.notifications).find(
      item => item.identityId === (charlie.session as { identityId: string }).identityId,
    ),
  );
  assert.deepEqual(offline?.reasons, ['direct_mention']);
  assert.equal(
    ((await service.call(a.agentHandle, 'getSession', {})) as { unreadNotificationCount: number })
      .unreadNotificationCount,
    0,
  );

  await service.call(b.agentHandle, 'ackNotifications', {
    notificationIds: [bobInbox.notifications[0]!.notificationId],
  });
  assert.deepEqual(
    ((await service.call(b.agentHandle, 'listNotifications', {})) as { notifications: unknown[] })
      .notifications,
    [],
  );

  const next = await hold(service, a.agentHandle, thread);
  await assert.rejects(
    service.commitTurn(
      a.agentHandle,
      next.turn.id,
      next.turn.fencingToken,
      next.snapshot.revision,
      {
        kind: 'appendMessage',
        body: 'invalid target',
        mentions: { agents: ['Nobody'], here: false },
      },
    ),
    errorCode('UNKNOWN_AGENT'),
  );
  service.releaseTurn(a.agentHandle, next.turn.id, next.turn.fencingToken);
});

test('agent discovery defaults to other online identities and thread filtering exposes follow state', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  const agents = (await service.call(a.agentHandle, 'listAgents', {})) as {
    agents: { name: string; online: boolean; self: boolean }[];
  };
  assert.deepEqual(
    agents.agents.map(item => item.name),
    ['Bob'],
  );
  assert.equal(agents.agents[0]!.online, true);
  assert.equal(agents.agents[0]!.self, false);
  assert.equal(
    (
      (await service.call(a.agentHandle, 'listThreads', { following: true })) as {
        threads: { id: string; following: boolean }[];
      }
    ).threads[0]!.id,
    thread,
  );
  await service.call(a.agentHandle, 'unfollowThread', { threadId: thread });
  assert.deepEqual(
    (
      (await service.call(a.agentHandle, 'listThreads', { following: true })) as {
        threads: unknown[];
      }
    ).threads,
    [],
  );
  await service.call(a.agentHandle, 'followThread', { threadId: thread });
  const all = (await service.call(b.agentHandle, 'listAgents', {
    onlineOnly: false,
    includeSelf: true,
  })) as { agents: { name: string; self: boolean }[] };
  assert.equal(all.agents.find(item => item.name === 'Bob')?.self, true);
});

test('mention waiting ignores followed-only updates and wakes immediately for a direct mention', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  const subscribed = await hold(service, b.agentHandle, thread);
  service.releaseTurn(b.agentHandle, subscribed.turn.id, subscribed.turn.fencingToken);
  const followed = await hold(service, a.agentHandle, thread);
  await service.commitTurn(
    a.agentHandle,
    followed.turn.id,
    followed.turn.fencingToken,
    followed.snapshot.revision,
    { kind: 'appendMessage', body: 'ordinary followed update' },
  );
  assert.deepEqual(await service.waitForWork(b.agentHandle, 0), {
    notifications: [],
    moreAvailable: false,
  });

  const waiting = service.waitForWork(b.agentHandle, 10_000) as Promise<{
    notifications: { notificationId: string; reasons: string[] }[];
    moreAvailable: boolean;
  }>;
  await new Promise(resolve => setImmediate(resolve));
  const mentioned = await hold(service, a.agentHandle, thread);
  await service.commitTurn(
    a.agentHandle,
    mentioned.turn.id,
    mentioned.turn.fencingToken,
    mentioned.snapshot.revision,
    {
      kind: 'appendMessage',
      body: '@Bob please respond',
      mentions: { agents: ['Bob'], here: false },
    },
  );
  const batch = await Promise.race([
    waiting,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('mention wait was not immediate')), 250),
    ),
  ]);
  assert.equal(batch.notifications.length, 1);
  assert.ok(batch.notifications[0]!.reasons.includes('direct_mention'));
  assert.equal(batch.moreAvailable, false);
  await service.call(b.agentHandle, 'ackNotifications', {
    notificationIds: [batch.notifications[0]!.notificationId],
  });
  assert.deepEqual(await service.waitForWork(b.agentHandle, 0), {
    notifications: [],
    moreAvailable: false,
  });
  assert.equal(
    ((await service.call(b.agentHandle, 'listNotifications', {})) as { notifications: unknown[] })
      .notifications.length,
    1,
  );

  const hereWaiting = service.waitForWork(b.agentHandle, 10_000) as Promise<{
    notifications: { notificationId: string; reasons: string[] }[];
  }>;
  await new Promise(resolve => setImmediate(resolve));
  const hereTurn = await hold(service, a.agentHandle, thread);
  await service.commitTurn(
    a.agentHandle,
    hereTurn.turn.id,
    hereTurn.turn.fencingToken,
    hereTurn.snapshot.revision,
    { kind: 'appendMessage', body: '@here status check', mentions: { agents: [], here: true } },
  );
  const hereBatch = await hereWaiting;
  assert.equal(hereBatch.notifications.length, 1);
  assert.ok(hereBatch.notifications[0]!.reasons.includes('here'));
});

test('project identities see coalesced thread activity without following it', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;

  const firstTurn = await hold(service, a.agentHandle, thread);
  const first = await service.commitTurn(
    a.agentHandle,
    firstTurn.turn.id,
    firstTurn.turn.fencingToken,
    firstTurn.snapshot.revision,
    { kind: 'appendMessage', body: 'first project-wide update' },
  );
  let inbox = (await service.call(b.agentHandle, 'listNotifications', {})) as {
    notifications: {
      notificationId: string;
      messageId: string;
      sequence: string;
      reasons: string[];
    }[];
  };
  assert.equal(inbox.notifications.length, 1);
  assert.deepEqual(inbox.notifications[0]!.reasons, ['thread_activity']);
  assert.equal(inbox.notifications[0]!.messageId, first.messageId);
  const activityId = inbox.notifications[0]!.notificationId;
  assert.deepEqual(await service.waitForWork(b.agentHandle, 0), {
    notifications: [],
    moreAvailable: false,
  });

  const secondTurn = await hold(service, a.agentHandle, thread);
  const second = await service.commitTurn(
    a.agentHandle,
    secondTurn.turn.id,
    secondTurn.turn.fencingToken,
    secondTurn.snapshot.revision,
    { kind: 'appendMessage', body: 'second project-wide update' },
  );
  inbox = (await service.call(b.agentHandle, 'listNotifications', {})) as typeof inbox;
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0]!.notificationId, activityId);
  assert.equal(inbox.notifications[0]!.messageId, second.messageId);
  assert.equal(inbox.notifications[0]!.sequence, '2');

  service.disconnect(b.agentHandle);
  const thirdTurn = await hold(service, a.agentHandle, thread);
  const third = await service.commitTurn(
    a.agentHandle,
    thirdTurn.turn.id,
    thirdTurn.turn.fencingToken,
    thirdTurn.snapshot.revision,
    { kind: 'appendMessage', body: 'offline agents retain coalesced project activity' },
  );
  const bobIdentity = (b.session as { identityId: string }).identityId;
  assert.equal(
    f.control.view(state =>
      Object.values(state.notifications).filter(item => item.identityId === bobIdentity),
    )[0]!.messageId,
    third.messageId,
  );
});

test('@global notifies every existing project identity, including offline non-followers', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  const charlie = await service.open('/repo/.git', 'Charlie');
  service.disconnect(charlie.agentHandle);
  const otherProject = await service.open('/other/.git', 'Elsewhere');
  service.disconnect(otherProject.agentHandle);

  const globalTurn = await hold(service, a.agentHandle, thread);
  await service.commitTurn(
    a.agentHandle,
    globalTurn.turn.id,
    globalTurn.turn.fencingToken,
    globalTurn.snapshot.revision,
    {
      kind: 'appendMessage',
      body: '@global Please introduce yourselves here.',
      mentions: { agents: [], here: false, global: true },
    },
  );
  const inbox = (await service.call(b.agentHandle, 'listNotifications', {})) as {
    notifications: { notificationId: string; reasons: string[]; content: { body: string } }[];
  };
  assert.ok(inbox.notifications[0]!.reasons.includes('global'));
  assert.equal(inbox.notifications[0]!.content.body, '@global Please introduce yourselves here.');
  const work = (await service.waitForWork(b.agentHandle, 0)) as {
    notifications: { notificationId: string; reasons: string[] }[];
    moreAvailable: boolean;
  };
  assert.equal(work.notifications[0]!.notificationId, inbox.notifications[0]!.notificationId);
  const charlieNotification = f.control.view(state =>
    Object.values(state.notifications).find(
      item => item.identityId === (charlie.session as { identityId: string }).identityId,
    ),
  );
  assert.ok(charlieNotification?.reasons.includes('global'));
  assert.equal(
    f.control.view(state =>
      Object.values(state.notifications).some(
        item => item.identityId === (otherProject.session as { identityId: string }).identityId,
      ),
    ),
    false,
  );
});

test('mention waiting bounds a batch and reports remaining work', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, control, b, thread, clock } = f;
  const session = b.session as { projectId: string; identityId: string };
  control.update(state => {
    for (let index = 0; index < 101; index++)
      state.notifications[`mention-${index}`] = {
        id: `mention-${index}`,
        projectId: session.projectId,
        identityId: session.identityId,
        resourceType: 'thread',
        resourceId: thread,
        eventId: `message-${index}`,
        threadId: thread,
        messageId: `message-${index}`,
        sequence: String(index + 1),
        senderIdentityId: 'sender',
        senderName: 'Alice',
        createdAt: clock.now() + index,
        reasons: ['direct_mention'],
      };
  });
  const batch = (await service.waitForWork(b.agentHandle, 0)) as {
    notifications: unknown[];
    moreAvailable: boolean;
  };
  assert.equal(batch.notifications.length, 100);
  assert.equal(batch.moreAvailable, true);
});

test('native delivery includes content, prioritizes actionable work, and has no wake cap', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  service.disconnect(a.agentHandle);
  const receiver = await service.open(
    '/repo/.git',
    'Alice',
    { host: 'opencode' },
    '/repo/.git',
    'opencode-session',
  );
  const ordinary = await hold(service, b.agentHandle, thread);
  await service.commitTurn(
    b.agentHandle,
    ordinary.turn.id,
    ordinary.turn.fencingToken,
    ordinary.snapshot.revision,
    { kind: 'appendMessage', body: 'ordinary project update' },
  );
  assert.equal(
    (
      (await service.waitForDeliveryHandle(receiver.agentHandle, 0, 'actionable')) as {
        count: number;
      }
    ).count,
    0,
  );
  const activity = (await service.waitForDeliveryHandle(receiver.agentHandle, 0, 'all')) as {
    kind: string;
    count: number;
    notifications: { content: { body: string } }[];
  };
  assert.equal(activity.kind, 'activity');
  assert.equal(activity.notifications[0]!.content.body, 'ordinary project update');

  const direct = await hold(service, b.agentHandle, thread);
  await service.commitTurn(
    b.agentHandle,
    direct.turn.id,
    direct.turn.fencingToken,
    direct.snapshot.revision,
    {
      kind: 'appendMessage',
      body: '@Alice Please review this now.',
      mentions: { agents: ['Alice'], here: false },
    },
  );
  const actionable = (await service.waitForDeliveryHandle(
    receiver.agentHandle,
    0,
    'actionable',
  )) as { kind: string; reasons: string[]; notifications: { content: { body: string } }[] };
  assert.equal(actionable.kind, 'actionable');
  assert.ok(actionable.reasons.includes('direct_mention'));
  assert.equal(actionable.notifications[0]!.content.body, '@Alice Please review this now.');
  service.disconnect(receiver.agentHandle);
});

test('one live host-session cohort receives one delivery and a resumed cohort can catch up', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  service.disconnect(a.agentHandle);
  const native = { host: 'opencode' as const };
  const first = await service.open('/repo/.git', 'Alice', native, '/repo/.git', 'shared-session');
  const duplicate = await service.open(
    '/repo/.git',
    undefined,
    native,
    '/repo/.git',
    'shared-session',
  );
  assert.equal(
    (first.session as { identityId: string }).identityId,
    (duplicate.session as { identityId: string }).identityId,
  );
  const turn = await hold(service, b.agentHandle, thread);
  await service.commitTurn(
    b.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'one delivery per live cohort' },
  );
  assert.equal(
    ((await service.waitForDeliveryHandle(first.agentHandle, 0)) as { count: number }).count,
    1,
  );
  assert.equal(
    ((await service.waitForDeliveryHandle(duplicate.agentHandle, 0)) as { count: number }).count,
    0,
  );

  service.disconnect(first.agentHandle);
  service.disconnect(duplicate.agentHandle);
  const resumed = await service.open(
    '/repo/.git',
    undefined,
    native,
    '/repo/.git',
    'shared-session',
  );
  assert.equal(
    (resumed.session as { identityId: string }).identityId,
    (first.session as { identityId: string }).identityId,
  );
  assert.equal(
    ((await service.waitForDeliveryHandle(resumed.agentHandle, 0)) as { count: number }).count,
    1,
  );
});

test('a committed notification reaches an already-waiting native adapter', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service, a, b, thread } = f;
  service.disconnect(a.agentHandle);
  const receiver = await service.open(
    '/repo/.git',
    'Alice',
    { host: 'opencode' },
    '/repo/.git',
    'opencode-waiting',
  );
  const waiting = service.waitForDeliveryHandle(receiver.agentHandle, 10_000) as Promise<{
    count: number;
  }>;
  await new Promise(resolve => setImmediate(resolve));
  const turn = await hold(service, b.agentHandle, thread);
  await service.commitTurn(
    b.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'wake now' },
  );
  const result = await Promise.race([
    waiting,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('delivery was not immediate')), 250),
    ),
  ]);
  assert.equal(result.count, 1);
  service.disconnect(receiver.agentHandle);
});
