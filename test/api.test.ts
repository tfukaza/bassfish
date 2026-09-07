import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '../src/api.js';

const tools = [
  'getSession','setAgentName','listAgents','createThread','listThreads','createNote','listNotes','searchNotes',
  'requestFloor','getFloorRequest','waitForFloor','cancelFloorRequest','claimFloor','readFloor','releaseFloor','commitFloor',
  'listHistory','readRevision','diffRevision','previewRestore','restoreRevision','getNoteOutline','findInNote',
  'inspectSnapshot','searchProjectNotes','searchProjectNoteHistory','exportSnapshot',
  'listSnapshotHistory','previewSnapshotRestore','restoreSnapshot',
];

test('v0 exposes one clean camelCase tool surface', () => {
  assert.deepEqual(Object.keys(schemas),tools);
  assert.ok(tools.every(name => !name.includes('_')));
});

test('v0 rejects superseded flat and snake_case floor contracts', () => {
  assert.equal(schemas.requestFloor.safeParse({ resourceType: 'thread', resourceId: 'thread' }).success,false);
  assert.equal(schemas.requestFloor.safeParse({ target: { type: 'thread', id: 'thread' } }).success,true);
  assert.equal(schemas.releaseFloor.safeParse({ floorId: 'floor', fencingToken: '1' }).success,false);
  assert.equal(schemas.releaseFloor.safeParse({ floor: { id: 'floor', fencingToken: '1' } }).success,true);
  assert.equal(schemas.commitFloor.safeParse({ floor: { id: 'floor', fencingToken: '1' }, baseRevision: '1',
    mutation: { kind: 'append_thread_message', body: 'legacy' } }).success,false);
});
