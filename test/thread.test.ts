import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold, errorCode } from './support.js';
import type { Floor, Session } from './support.js';
import type { Thread } from '../src/domain.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Listed = { threads: Thread[]; nextCursor: string | null };
const credential = (floor: { floor: { id: string; fencingToken: string } }) => ({ id: floor.floor.id, fencingToken: floor.floor.fencingToken });
async function commit(f: Fixture, handle: string, threadId: string, mutation: Record<string, unknown>): Promise<{ revision: string }> {
  const floor = await hold(f.service, handle, threadId);
  return f.service.call(handle, 'commitFloor', { floor: credential(floor), baseRevision: floor.snapshot.revision, mutation }) as Promise<{ revision: string }>;
}
async function rejects(f: Fixture, handle: string, threadId: string, mutation: Record<string, unknown>, code: string): Promise<void> {
  const floor = await hold(f.service, handle, threadId);
  await assert.rejects(f.service.call(handle, 'commitFloor', { floor: credential(floor), baseRevision: floor.snapshot.revision, mutation }), errorCode(code));
  await f.service.call(handle, 'releaseFloor', { floor: credential(floor) }).catch(() => {});
}

test('thread metadata is visible, filterable, paginated, and searchable without a floor', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b, clock } = f;
  const bobId = (b.session as Session).identityId;
  const titles: string[] = [];
  for (const [handle, title] of [[a.agentHandle, 'Alpha'], [a.agentHandle, 'Beta'], [b.agentHandle, 'Gamma']] as const) {
    clock.advance(1000); await s.call(handle, 'createThread', { title, description: `${title} topic` }); titles.push(title);
  }
  const first = await s.call(b.agentHandle, 'listThreads', { limit: 2 }) as Listed;
  assert.deepEqual(first.threads.map(thread => thread.title), ['Thread', 'Alpha']); assert.ok(first.nextCursor);
  assert.equal(first.threads[0]!.description, 'protected description');
  const second = await s.call(b.agentHandle, 'listThreads', { limit: 2, cursor: first.nextCursor }) as Listed;
  assert.deepEqual(second.threads.map(thread => thread.title), ['Beta', 'Gamma']); assert.equal(second.nextCursor, null);
  assert.ok(second.threads.every(thread => typeof thread.description === 'string'));
  assert.deepEqual((await s.call(a.agentHandle, 'listThreads', { titlePrefix: 'B' }) as Listed).threads.map(thread => thread.title), ['Beta']);
  assert.deepEqual((await s.call(a.agentHandle, 'listThreads', { creatorIdentityId: bobId }) as Listed).threads.map(thread => thread.title), ['Gamma']);
  await assert.rejects(s.call(a.agentHandle, 'listThreads', { cursor: '!!' }), errorCode('INVALID_CURSOR'));
  await assert.rejects(s.call(a.agentHandle, 'listNotes', { cursor: '!!' }), errorCode('INVALID_CURSOR'));
  const fetched = await s.call(b.agentHandle, 'getThread', { threadId: f.thread }) as Thread;
  assert.equal(fetched.title, 'Thread'); assert.equal(fetched.description, 'protected description'); assert.equal(fetched.state, 'active');
  const note = await s.call(a.agentHandle, 'createNote', { path: 'plans/x', title: 'X', body: '', labels: [], noteKind: null, links: [] }) as { noteId: string };
  await assert.rejects(s.call(a.agentHandle, 'getThread', { threadId: note.noteId }), errorCode('NOT_FOUND'));
  await assert.rejects(s.call(a.agentHandle, 'getThread', { threadId: 'missing' }), errorCode('NOT_FOUND'));
  const byDescription = await s.call(a.agentHandle, 'searchThreads', { query: 'PROTECTED' }) as Listed;
  assert.deepEqual(byDescription.threads.map(thread => thread.id), [f.thread]);
  assert.deepEqual((await s.call(a.agentHandle, 'searchThreads', { query: 'alp' }) as Listed).threads.map(thread => thread.title), ['Alpha']);
  assert.deepEqual((await s.call(a.agentHandle, 'searchThreads', { query: 'topic', limit: 2 }) as Listed).threads.map(thread => thread.title), ['Alpha', 'Beta']);
  assert.deepEqual((await s.call(a.agentHandle, 'searchThreads', { query: 'protected', state: 'archived' }) as Listed).threads, []);
});

test('thread descriptions are edited under the floor, revisioned, and restorable', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a } = f;
  const changed = await commit(f, a.agentHandle, f.thread, { kind: 'setThreadDescription', description: 'new topic' });
  assert.equal(changed.revision, '2');
  assert.equal((await s.call(a.agentHandle, 'getThread', { threadId: f.thread }) as Thread).description, 'new topic');
  assert.equal((await s.call(a.agentHandle, 'searchThreads', { query: 'new topic' }) as Listed).threads.length, 1);
  await rejects(f, a.agentHandle, f.thread, { kind: 'setThreadDescription', description: 'new topic' }, 'NO_CHANGE');
  await commit(f, a.agentHandle, f.thread, { kind: 'setThreadDescription', description: '' });
  assert.equal((await s.call(a.agentHandle, 'getThread', { threadId: f.thread }) as Thread).description, '');
  const floor = await hold(s, a.agentHandle, f.thread);
  const history = await s.call(a.agentHandle, 'listHistory', { floor: credential(floor) }) as { entries: { kind: string }[] };
  assert.deepEqual(history.entries.map(entry => entry.kind).filter(kind => kind === 'setThreadDescription').length, 2);
  const preview = await s.call(a.agentHandle, 'previewRestore', { floor: credential(floor), revision: '1' }) as { previewToken: string };
  await s.call(a.agentHandle, 'restoreRevision', { floor: credential(floor), previewToken: preview.previewToken });
  assert.equal((await s.call(a.agentHandle, 'getThread', { threadId: f.thread }) as Thread).description, 'protected description');
  const note = await s.call(a.agentHandle, 'createNote', { path: 'plans/y', title: 'Y', body: '', labels: [], noteKind: null, links: [] }) as { noteId: string };
  const ticket = await s.call(a.agentHandle, 'requestFloor', { target: { type: 'note', id: note.noteId } }) as { offerId: string };
  const noteFloor = await s.call(a.agentHandle, 'claimFloor', { offerId: ticket.offerId }) as { floor: { id: string; fencingToken: string }; snapshot: { revision: string } };
  await assert.rejects(s.call(a.agentHandle, 'commitFloor', { floor: credential(noteFloor), baseRevision: noteFloor.snapshot.revision, mutation: { kind: 'setThreadDescription', description: 'x' } }), errorCode('RESOURCE_TYPE_MISMATCH'));
  await assert.rejects(s.call(a.agentHandle, 'commitFloor', { floor: credential(noteFloor), baseRevision: noteFloor.snapshot.revision, mutation: { kind: 'deleteThread' } }), errorCode('RESOURCE_TYPE_MISMATCH'));
  await s.call(a.agentHandle, 'releaseFloor', { floor: credential(noteFloor) });
});

test('deleted threads are a lifecycle state that mirrors deleted notes', async t => {
  const f = await fixture(); t.after(f.close); const { service: s, a, b } = f;
  await commit(f, a.agentHandle, f.thread, { kind: 'deleteThread' });
  assert.deepEqual((await s.call(b.agentHandle, 'listThreads', {}) as Listed).threads, []);
  assert.deepEqual((await s.call(b.agentHandle, 'listThreads', { state: 'deleted' }) as Listed).threads.map(thread => thread.id), [f.thread]);
  assert.equal((await s.call(b.agentHandle, 'getThread', { threadId: f.thread }) as Thread).state, 'deleted');
  await rejects(f, b.agentHandle, f.thread, { kind: 'appendMessage', body: 'nope' }, 'RESOURCE_ARCHIVED');
  await rejects(f, a.agentHandle, f.thread, { kind: 'deleteThread' }, 'NO_CHANGE');
  await rejects(f, a.agentHandle, f.thread, { kind: 'archiveThread' }, 'NO_CHANGE');
  await commit(f, a.agentHandle, f.thread, { kind: 'activateThread' });
  assert.equal((await s.call(b.agentHandle, 'getThread', { threadId: f.thread }) as Thread).state, 'active');
  await commit(f, a.agentHandle, f.thread, { kind: 'archiveThread' });
  await commit(f, a.agentHandle, f.thread, { kind: 'deleteThread' });
  const restored = await hold(s, a.agentHandle, f.thread) as Floor;
  assert.equal(restored.page.thread.state, 'deleted');
  await s.call(a.agentHandle, 'releaseFloor', { floor: credential(restored) });
  await s.call(a.agentHandle, 'createNote', { path: 'plans/link', title: 'Link', body: '', labels: [], noteKind: null, links: [{ targetType: 'thread', targetId: f.thread }] });
  const request = await s.call(a.agentHandle, 'requestFloor', { target: { type: 'project', purpose: 'snapshot' } }) as { offerId: string };
  const project = await s.call(a.agentHandle, 'claimFloor', { offerId: request.offerId }) as { floor: { id: string; fencingToken: string } };
  const info = await s.call(a.agentHandle, 'inspectSnapshot', { floor: credential(project) }) as { threads: { id: string; state: string; description: string }[] };
  assert.deepEqual(info.threads.map(thread => [thread.id, thread.state, thread.description]), [[f.thread, 'deleted', 'protected description']]);
  await s.call(a.agentHandle, 'releaseFloor', { floor: credential(project) });
});
