import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, errorCode } from './support.js';
import type { Session } from './support.js';
import type { Thread } from '../src/domain.js';

type Listed = { threads: Thread[]; nextCursor: string | null };
test('thread metadata is visible, filterable, paginated, and searchable without a turn', async t => {
  const f = await fixture();
  t.after(f.close);
  const { service: s, a, b, clock } = f;
  const bobId = (b.session as Session).identityId;
  const titles: string[] = [];
  for (const [handle, title] of [
    [a.agentHandle, 'Alpha'],
    [a.agentHandle, 'Beta'],
    [b.agentHandle, 'Gamma'],
  ] as const) {
    clock.advance(1000);
    await s.call(handle, 'createThread', { title, description: `${title} topic` });
    titles.push(title);
  }
  const first = (await s.call(b.agentHandle, 'listThreads', { limit: 2 })) as Listed;
  assert.deepEqual(
    first.threads.map(thread => thread.title),
    ['Thread', 'Alpha'],
  );
  assert.ok(first.nextCursor);
  assert.equal(first.threads[0]!.description, 'protected description');
  const second = (await s.call(b.agentHandle, 'listThreads', {
    limit: 2,
    cursor: first.nextCursor,
  })) as Listed;
  assert.deepEqual(
    second.threads.map(thread => thread.title),
    ['Beta', 'Gamma'],
  );
  assert.equal(second.nextCursor, null);
  assert.ok(second.threads.every(thread => typeof thread.description === 'string'));
  assert.deepEqual(
    ((await s.call(a.agentHandle, 'listThreads', { titlePrefix: 'B' })) as Listed).threads.map(
      thread => thread.title,
    ),
    ['Beta'],
  );
  assert.deepEqual(
    (
      (await s.call(a.agentHandle, 'listThreads', { creatorIdentityId: bobId })) as Listed
    ).threads.map(thread => thread.title),
    ['Gamma'],
  );
  await assert.rejects(
    s.call(a.agentHandle, 'listThreads', { cursor: '!!' }),
    errorCode('INVALID_CURSOR'),
  );
  const fetched = (await s.call(b.agentHandle, 'getThread', { threadId: f.thread })) as Thread;
  assert.equal(fetched.title, 'Thread');
  assert.equal(fetched.description, 'protected description');
  assert.equal(fetched.state, 'active');
  const resource = (await s.createTicket(a.agentHandle, {
    title: 'Work',
    description: 'Task',
    owner: 'Alice',
    body: '',
    state: 'todo',
    dependsOn: [],
  })) as { ticketId: string };
  await assert.rejects(
    s.call(a.agentHandle, 'getThread', { threadId: resource.ticketId }),
    errorCode('NOT_FOUND'),
  );
  await assert.rejects(
    s.call(a.agentHandle, 'getThread', { threadId: 'missing' }),
    errorCode('NOT_FOUND'),
  );
  const byDescription = (await s.call(a.agentHandle, 'searchThreads', {
    query: 'PROTECTED',
  })) as Listed;
  assert.deepEqual(
    byDescription.threads.map(thread => thread.id),
    [f.thread],
  );
  assert.deepEqual(
    ((await s.call(a.agentHandle, 'searchThreads', { query: 'alp' })) as Listed).threads.map(
      thread => thread.title,
    ),
    ['Alpha'],
  );
  assert.deepEqual(
    (
      (await s.call(a.agentHandle, 'searchThreads', { query: 'topic', limit: 2 })) as Listed
    ).threads.map(thread => thread.title),
    ['Alpha', 'Beta'],
  );
  assert.deepEqual(
    (
      (await s.call(a.agentHandle, 'searchThreads', {
        query: 'protected',
        state: 'archived',
      })) as Listed
    ).threads,
    [],
  );
});
