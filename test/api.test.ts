import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '../src/api.js';

const tools = [
  'getSession','setAgentName','listAgents','createThread','listThreads','getThread','searchThreads','createNote','listNotes','searchNotes',
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

test('thread metadata tools and mutations validate their inputs', () => {
  assert.equal(schemas.commitFloor.safeParse({ floor: { id: 'f', fencingToken: '1' }, baseRevision: '1', mutation: { kind: 'setThreadDescription', description: 'topic' } }).success, true);
  assert.equal(schemas.commitFloor.safeParse({ floor: { id: 'f', fencingToken: '1' }, baseRevision: '1', mutation: { kind: 'setThreadDescription', description: '' } }).success, true);
  assert.equal(schemas.commitFloor.safeParse({ floor: { id: 'f', fencingToken: '1' }, baseRevision: '1', mutation: { kind: 'setThreadDescription', description: 'x'.repeat(2001) } }).success, false);
  assert.equal(schemas.commitFloor.safeParse({ floor: { id: 'f', fencingToken: '1' }, baseRevision: '1', mutation: { kind: 'deleteThread' } }).success, true);
  assert.equal(schemas.listThreads.safeParse({ state: 'deleted', limit: 1, cursor: 'abc', creatorIdentityId: 'i', titlePrefix: 'T' }).success, true);
  assert.deepEqual(schemas.listThreads.parse({}), { state: 'active', limit: 100 });
  assert.equal(schemas.listThreads.safeParse({ foo: 1 }).success, false);
  assert.equal(schemas.getThread.safeParse({ threadId: 't' }).success, true);
  assert.equal(schemas.getThread.safeParse({}).success, false);
  assert.equal(schemas.searchThreads.safeParse({ query: '  ' }).success, false);
  assert.deepEqual(schemas.searchThreads.parse({ query: ' topic ' }), { query: 'topic', state: 'active', limit: 100 });
});
