import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, errorCode } from './support.js';

async function holdNote(service: Awaited<ReturnType<typeof fixture>>['service'], handle: string, noteId: string) {
  const ticket = await service.call(handle, 'requestTurn', { target: { type: 'note', id: noteId } }) as { offerId: string };
  return service.call(handle, 'claimTurn', { offerId: ticket.offerId }) as Promise<{
    turn: { id: string; fencingToken: string }; snapshot: { revision: string };
    page: { type: string; note: { body?: string; path: string }; text: string; truncated: boolean }; nextCursor: string | null;
  }>;
}
const credential = (value: { id: string; fencingToken: string }) => ({ id: value.id, fencingToken: value.fencingToken });

test('notes expose metadata freely but serialize bounded body reads and edits', async t => {
  const f = await fixture(); t.after(f.close);
  const created = await f.service.call(f.a.agentHandle, 'createNote', { path: 'architecture/turn-control', title: 'Turn', body: 'one\ntwo', labels: ['plan'], noteKind: 'design', links: [] }) as { noteId: string };
  const listed = await f.service.call(f.b.agentHandle, 'listNotes', {}) as { notes: Record<string, unknown>[] };
  assert.equal(listed.notes.length, 1); assert.equal(listed.notes[0]!.path, 'architecture/turn-control'); assert.equal('body' in listed.notes[0]!, false);
  const turn = await holdNote(f.service, f.a.agentHandle, created.noteId);
  assert.equal(turn.page.type, 'note'); assert.equal(turn.page.text, 'one\ntwo'); assert.equal(turn.page.note.body, undefined);
  const waiting = await f.service.call(f.b.agentHandle, 'requestTurn', { target: { type: 'note', id: created.noteId } }) as { state: string; requestId: string };
  assert.equal(waiting.state, 'queued');
  await f.service.call(f.a.agentHandle, 'commitTurn', { turn: credential(turn.turn), baseRevision: turn.snapshot.revision,
    mutation: { kind: 'appendNoteBody', body: '\nthree' } });
  const offered = await f.service.call(f.b.agentHandle, 'getTurnRequest', { requestId: waiting.requestId }) as { offerId: string };
  const next = await f.service.call(f.b.agentHandle, 'claimTurn', { offerId: offered.offerId }) as Awaited<ReturnType<typeof holdNote>>;
  assert.equal(next.page.text, 'one\ntwo\nthree');
  await f.service.call(f.b.agentHandle, 'releaseTurn', { turn: credential(next.turn) });
});

test('note patch is exact and historical restore creates a new revision', async t => {
  const f = await fixture(); t.after(f.close);
  const created = await f.service.call(f.a.agentHandle, 'createNote', { path: 'handoff/api', title: 'API', body: 'alpha\nbeta', labels: [], noteKind: null, links: [] }) as { noteId: string };
  let turn = await holdNote(f.service, f.a.agentHandle, created.noteId);
  await assert.rejects(f.service.call(f.a.agentHandle, 'commitTurn', { turn: credential(turn.turn), baseRevision: turn.snapshot.revision,
    mutation: { kind: 'patchNoteBody', patch: '@@ -1,1 +1,1 @@\n-wrong\n+right' } }), errorCode('PATCH_REJECTED'));
  await f.service.call(f.a.agentHandle, 'commitTurn', { turn: credential(turn.turn), baseRevision: turn.snapshot.revision,
    mutation: { kind: 'replaceNoteText', find: 'beta', replace: 'gamma', expectedOccurrences: 1 } });
  turn = await holdNote(f.service, f.a.agentHandle, created.noteId);
  const preview = await f.service.call(f.a.agentHandle, 'previewRestore', { turn: credential(turn.turn), revision: '1' }) as { previewToken: string };
  const restored = await f.service.call(f.a.agentHandle, 'restoreRevision', { turn: credential(turn.turn), previewToken: preview.previewToken }) as { revision: string };
  assert.equal(restored.revision, '3');
  turn = await holdNote(f.service, f.a.agentHandle, created.noteId);
  assert.equal(turn.page.text, 'alpha\nbeta');
  const history = await f.service.call(f.a.agentHandle, 'listHistory', { turn: credential(turn.turn) }) as { entries: unknown[] };
  assert.equal(history.entries.length, 3);
});

test('note paths and label sets are canonical and unique', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.service.call(f.a.agentHandle, 'createNote', { path: '../Bad', title: 'Bad', body: '', labels: [], noteKind: null, links: [] }), errorCode('INVALID_ARGUMENT'));
  await assert.rejects(f.service.call(f.a.agentHandle, 'createNote', { path: 'valid/path', title: 'Bad labels', body: '', labels: ['same','same'], noteKind: null, links: [] }), errorCode('INVALID_ARGUMENT'));
});

test('note links must resolve inside the project', async t => {
  const f = await fixture(); t.after(f.close);
  const linked = await f.service.call(f.a.agentHandle,'createNote',{ path: 'links/valid', title: 'Valid', body: '', labels: [], noteKind: null,
    links: [{ targetType: 'thread', targetId: f.thread }] }) as { noteId: string };
  assert.ok(linked.noteId);
  await assert.rejects(f.service.call(f.a.agentHandle,'createNote',{ path: 'links/invalid', title: 'Invalid', body: '', labels: [], noteKind: null,
    links: [{ targetType: 'note', targetId: 'missing' }] }),errorCode('LINK_TARGET_NOT_FOUND'));
});
