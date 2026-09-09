import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSchemas as schemas } from '../src/admin-api.js';
import { mcpSchemas } from '../src/mcp-api.js';

const tools = [
  'getSession',
  'setAgentName',
  'listAgents',
  'followThread',
  'unfollowThread',
  'listNotifications',
  'waitForWork',
  'ackNotifications',
  'createThread',
  'listThreads',
  'getThread',
  'searchThreads',
  'requestTurn',
  'getTurnRequest',
  'waitForTurn',
  'cancelTurnRequest',
  'claimTurn',
  'readTurn',
  'releaseTurn',
  'commitTurn',
  'listHistory',
  'readRevision',
  'diffRevision',
  'inspectProject',
  'exportProject',
  'listProjectHistory',
];

test('the private command registry remains available to the CLI', () => {
  assert.deepEqual(Object.keys(schemas), tools);
  assert.ok(tools.every(name => !name.includes('_')));
});

test('MCP exposes only the compact collaboration surface', () => {
  assert.deepEqual(Object.keys(mcpSchemas), [
    'bindHostSession',
    'deliverHostNotifications',
    'getContext',
    'setAgentName',
    'notifications',
    'waitForWork',
    'findResources',
    'createResource',
    'acquireTurn',
    'cancelTurn',
    'readTurn',
    'commitTurn',
    'releaseTurn',
  ]);
  assert.deepEqual(mcpSchemas.getContext.parse({}), { includeOfflineAgents: false });
  assert.deepEqual(mcpSchemas.notifications.parse({ action: 'list' }), {
    action: 'list',
    limit: 20,
  });
  assert.deepEqual(mcpSchemas.findResources.parse({ resourceType: 'thread' }), {
    resourceType: 'thread',
    state: 'active',
    limit: 20,
  });
  assert.equal(
    mcpSchemas.acquireTurn.safeParse({ target: { type: 'project', purpose: 'restore' } }).success,
    false,
  );
  assert.deepEqual(mcpSchemas.acquireTurn.parse({ requestToken: 'request' }), {
    requestToken: 'request',
    timeoutMs: 20_000,
  });
  assert.equal(
    mcpSchemas.acquireTurn.safeParse({
      target: { type: 'thread', threadId: 'thread' },
      requestToken: 'request',
    }).success,
    false,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({ turnToken: 't', mutation: { kind: 'deleteThread' } }).success,
    false,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({
      turnToken: 't',
      mutation: { kind: 'appendMessage', body: 'hello' },
    }).success,
    true,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({
      turnToken: 't',
      mutation: {
        kind: 'appendMessage',
        body: '@global project update',
        mentions: { agents: [], here: false, global: true },
      },
    }).success,
    true,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({
      turnToken: 't',
      mutation: {
        kind: 'appendMessage',
        body: '@global project update',
        mentions: { agents: ['Alice'], here: false, global: true },
      },
    }).success,
    false,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({
      turnToken: 't',
      mutation: {
        kind: 'appendMessage',
        body: '!Bob is ordinary text now',
        mentions: { agents: [], here: false, urgentAgent: 'Bob' },
      },
    }).success,
    false,
  );
});

test('v0 rejects superseded flat and snake_case turn contracts', () => {
  assert.equal(
    schemas.requestTurn.safeParse({ resourceType: 'thread', resourceId: 'thread' }).success,
    false,
  );
  assert.equal(
    schemas.requestTurn.safeParse({ target: { type: 'thread', id: 'thread' } }).success,
    true,
  );
  assert.equal(schemas.releaseTurn.safeParse({ turnId: 'turn', fencingToken: '1' }).success, false);
  assert.equal(
    schemas.releaseTurn.safeParse({ turn: { id: 'turn', fencingToken: '1' } }).success,
    true,
  );
  assert.equal(
    schemas.commitTurn.safeParse({
      turn: { id: 'turn', fencingToken: '1' },
      baseRevision: '1',
      mutation: { kind: 'append_thread_message', body: 'legacy' },
    }).success,
    false,
  );
});

test('thread metadata tools and mutations validate their inputs', () => {
  assert.equal(
    schemas.commitTurn.safeParse({
      turn: { id: 'f', fencingToken: '1' },
      baseRevision: '1',
      mutation: { kind: 'setThreadDescription', description: 'topic' },
    }).success,
    true,
  );
  assert.equal(
    schemas.commitTurn.safeParse({
      turn: { id: 'f', fencingToken: '1' },
      baseRevision: '1',
      mutation: { kind: 'setThreadDescription', description: '' },
    }).success,
    true,
  );
  assert.equal(
    schemas.commitTurn.safeParse({
      turn: { id: 'f', fencingToken: '1' },
      baseRevision: '1',
      mutation: { kind: 'setThreadDescription', description: 'x'.repeat(2001) },
    }).success,
    false,
  );
  assert.equal(
    schemas.commitTurn.safeParse({
      turn: { id: 'f', fencingToken: '1' },
      baseRevision: '1',
      mutation: { kind: 'deleteThread' },
    }).success,
    true,
  );
  assert.equal(
    schemas.listThreads.safeParse({
      state: 'deleted',
      limit: 1,
      cursor: 'abc',
      creatorIdentityId: 'i',
      titlePrefix: 'T',
    }).success,
    true,
  );
  assert.deepEqual(schemas.listThreads.parse({}), { state: 'active', limit: 100 });
  assert.equal(schemas.listThreads.safeParse({ foo: 1 }).success, false);
  assert.equal(schemas.getThread.safeParse({ threadId: 't' }).success, true);
  assert.equal(schemas.getThread.safeParse({}).success, false);
  assert.equal(schemas.searchThreads.safeParse({ query: '  ' }).success, false);
  assert.deepEqual(schemas.searchThreads.parse({ query: ' topic ' }), {
    query: 'topic',
    state: 'active',
    limit: 100,
  });
  assert.deepEqual(schemas.listAgents.parse({}), { onlineOnly: true, includeSelf: false });
  const append = schemas.commitTurn.parse({
    turn: { id: 'f', fencingToken: '1' },
    baseRevision: '1',
    mutation: { kind: 'appendMessage', body: '@Alice hello' },
  });
  assert.deepEqual(append.mutation, {
    kind: 'appendMessage',
    body: '@Alice hello',
    mentions: { agents: [], here: false, global: false },
  });
  assert.equal(schemas.setAgentName.safeParse({ name: 'here' }).success, false);
});

test('file targets share acquisition and retired note APIs are rejected', () => {
  assert.equal(
    mcpSchemas.acquireTurn.safeParse({
      target: { type: 'files', paths: [{ path: 'src', kind: 'directory' }] },
    }).success,
    true,
  );
  assert.equal(
    mcpSchemas.acquireTurn.safeParse({ target: { type: 'files', paths: [] } }).success,
    false,
  );
  assert.equal(
    mcpSchemas.acquireTurn.safeParse({ target: { type: 'note', noteId: 'old' } }).success,
    false,
  );
  assert.equal(
    mcpSchemas.createResource.safeParse({ resourceType: 'note', title: 'Old', path: 'old' })
      .success,
    false,
  );
  assert.equal(
    mcpSchemas.commitTurn.safeParse({
      turnToken: 't',
      mutation: { kind: 'replaceNoteBody', body: 'old' },
    }).success,
    false,
  );
});
