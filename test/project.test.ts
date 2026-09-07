import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { errorCode, fixture, hold } from './support.js';
import { NoteSearchIndex } from '../src/storage/search.js';
import { exportProject } from '../src/export.js';

test('a durable project drain waits for holders and blocks new resource claims', async t => {
  const f = await fixture(); t.after(f.close); const held = await hold(f.service,f.a.agentHandle,f.thread);
  const draining = await f.service.call(f.b.agentHandle,'requestFloor',{ target: { type: 'project', purpose: 'snapshot' } }) as { state: string; requestId: string };
  assert.equal(draining.state,'queued');
  await f.service.call(f.a.agentHandle,'releaseFloor',{ floor: { id: held.floor.id, fencingToken: held.floor.fencingToken } });
  const offered = await f.service.call(f.b.agentHandle,'getFloorRequest',{ requestId: draining.requestId }) as { state: string; offerId: string };
  assert.equal(offered.state,'offered');
  const project = await f.service.call(f.b.agentHandle,'claimFloor',{ offerId: offered.offerId }) as { floor: { id: string; fencingToken: string } };
  const resource = await f.service.call(f.a.agentHandle,'requestFloor',{ target: { type: 'thread', id: f.thread } }) as { state: string; requestId: string };
  assert.equal(resource.state,'queued');
  await f.service.call(f.b.agentHandle,'releaseFloor',{ floor: { id: project.floor.id, fencingToken: project.floor.fencingToken } });
  assert.equal((await f.service.call(f.a.agentHandle,'getFloorRequest',{ requestId: resource.requestId }) as { state: string }).state,'offered');
});

test('a queued project floor also blocks floorless resource creation', async t => {
  const f = await fixture(); t.after(f.close); const held = await hold(f.service,f.a.agentHandle,f.thread);
  await f.service.call(f.b.agentHandle,'requestFloor',{ target: { type: 'project', purpose: 'restore' } });
  await assert.rejects(f.service.call(f.a.agentHandle,'createNote',{ path: 'blocked', title: 'Blocked', body: 'x', labels: [], noteKind: null, links: [] }), errorCode('PROJECT_FLOOR_PENDING'));
  await f.service.call(f.a.agentHandle,'releaseFloor',{ floor: { id: held.floor.id, fencingToken: held.floor.fencingToken } });
});

test('the FTS index is rebuilt by Dolt head and returns bounded current snippets', async t => {
  const dir = await mkdtemp(join(tmpdir(),'bf-search-')); t.after(() => rm(dir,{ recursive: true, force: true }));
  const index = new NoteSearchIndex(join(dir,'search.sqlite')); t.after(() => index.close());
  const note = { id: 'n1', path: 'plans/api', title: 'API', body: 'The fencing token protects writes.', labels: ['design'], kind: 'plan', state: 'active' as const,
    revision: '1', creator: 'a', creatorName: 'A', lastEditor: 'a', lastEditorName: 'A', createdAt: 'x', updatedAt: 'x', links: [] };
  index.ensure('p','h1',[note]); assert.equal(index.search('p','fencing',['active'],10,0)[0]!.noteId,'n1');
  index.ensure('p','h2',[{ ...note, body: 'Replacement text.' }]); assert.equal(index.search('p','fencing',['active'],10,0).length,0);
});

test('project exports are byte deterministic', async t => {
  const dir = await mkdtemp(join(tmpdir(),'bf-export-')); t.after(() => rm(dir,{ recursive: true, force: true }));
  const snapshot = { commit: 'abcdef0123456789', threads: [], messages: [], visibility: [], notes: [{ id: 'n1', path: 'plan/api', title: 'API', body: '# API\n', labels: [], kind: null,
    state: 'active' as const, revision: '1', creator: 'a', creatorName: 'A', lastEditor: 'a', lastEditorName: 'A', createdAt: 'x', updatedAt: 'x', links: [] }] };
  const first = await exportProject(dir,'p_test',snapshot); const bytes = await readFile(first.path); const second = await exportProject(dir,'p_test',snapshot);
  assert.equal(first.sha256,second.sha256); assert.deepEqual(bytes,await readFile(second.path));
});

test('whole-project restore recreates target-visible content with fresh monotonic counters', async t => {
  const f = await fixture(); t.after(f.close);
  const projectId = (f.a.session as { projectId: string }).projectId;
  const created = await f.service.call(f.a.agentHandle,'createNote',{ path: 'plans/original', title: 'Original', body: 'first body', labels: [], noteKind: null, links: [] }) as { noteId: string };
  const targetCommit = await f.content.head(projectId);
  const noteFloor = await f.service.call(f.a.agentHandle,'requestFloor',{ target: { type: 'note', id: created.noteId } }) as { offerId: string };
  const claimed = await f.service.call(f.a.agentHandle,'claimFloor',{ offerId: noteFloor.offerId }) as { floor: { id: string; fencingToken: string }; snapshot: { revision: string } };
  await f.service.call(f.a.agentHandle,'commitFloor',{ floor: { id: claimed.floor.id, fencingToken: claimed.floor.fencingToken }, baseRevision: claimed.snapshot.revision, mutation: { kind: 'replaceNoteBody', body: 'later body' } });
  const later = await f.service.call(f.a.agentHandle,'createNote',{ path: 'plans/later', title: 'Later', body: 'remove me', labels: [], noteKind: null, links: [] }) as { noteId: string };
  const threadFloor = await hold(f.service,f.a.agentHandle,f.thread);
  await f.service.call(f.a.agentHandle,'commitFloor',{ floor: { id: threadFloor.floor.id, fencingToken: threadFloor.floor.fencingToken }, baseRevision: threadFloor.snapshot.revision, mutation: { kind: 'appendMessage', body: 'later message' } });
  const request = await f.service.call(f.a.agentHandle,'requestFloor',{ target: { type: 'project', purpose: 'restore' } }) as { offerId: string };
  const floor = await f.service.call(f.a.agentHandle,'claimFloor',{ offerId: request.offerId }) as { floor: { id: string; fencingToken: string } };
  const credential = { id: floor.floor.id, fencingToken: floor.floor.fencingToken };
  const preview = await f.service.call(f.a.agentHandle,'previewSnapshotRestore',{ floor: credential, targetCommit }) as { previewToken: string };
  const restored = await f.service.call(f.a.agentHandle,'restoreSnapshot',{ floor: credential, previewToken: preview.previewToken }) as { changes: unknown[] };
  assert.ok(restored.changes.length >= 2);
  const snapshot = await f.content.projectSnapshot(projectId); assert.equal(snapshot.notes.find(note => note.id === created.noteId)?.body,'first body');
  assert.equal(snapshot.notes.some(note => note.id === later.noteId),false); assert.equal(snapshot.messages.length,0);
  assert.equal(snapshot.threads[0]!.headSequence,'1'); assert.ok(BigInt(snapshot.notes[0]!.revision) > 2n);
});

test('historical note FTS returns prior semantic revisions under a search floor', async t => {
  const f = await fixture(); t.after(f.close);
  const created = await f.service.call(f.a.agentHandle,'createNote',{ path: 'research/history', title: 'History', body: 'fencing narwhal', labels: [], noteKind: null, links: [] }) as { noteId: string };
  const request = await f.service.call(f.a.agentHandle,'requestFloor',{ target: { type: 'note', id: created.noteId } }) as { offerId: string };
  const floor = await f.service.call(f.a.agentHandle,'claimFloor',{ offerId: request.offerId }) as { floor: { id: string; fencingToken: string }; snapshot: { revision: string } };
  await f.service.call(f.a.agentHandle,'commitFloor',{ floor: { id: floor.floor.id, fencingToken: floor.floor.fencingToken }, baseRevision: floor.snapshot.revision, mutation: { kind: 'replaceNoteBody', body: 'new body' } });
  const searchRequest = await f.service.call(f.a.agentHandle,'requestFloor',{ target: { type: 'project', purpose: 'search' } }) as { offerId: string };
  const searchFloor = await f.service.call(f.a.agentHandle,'claimFloor',{ offerId: searchRequest.offerId }) as { floor: { id: string; fencingToken: string } };
  const searchCredential = { id: searchFloor.floor.id, fencingToken: searchFloor.floor.fencingToken };
  const result = await f.service.call(f.a.agentHandle,'searchProjectNoteHistory',{ floor: searchCredential, query: 'narwhal', noteId: created.noteId }) as { matches: { revision: string }[] };
  assert.deepEqual(result.matches.map(value => value.revision),['1']); await f.service.call(f.a.agentHandle,'releaseFloor',{ floor: searchCredential });
});
