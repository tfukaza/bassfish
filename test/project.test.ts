import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { fixture, hold } from './support.js';
import { adminSchemas } from '../src/admin-api.js';

test('project inspection, export, and audit history do not require a project turn', async t => {
  const f = await fixture();
  t.after(f.close);
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  const before = await f.control.view(async s => (await s.all('requests')).length);
  const inspect = (await f.service.call(f.b.agentHandle, 'inspectProject', {})) as {
    threads: { id: string }[];
  };
  assert.equal(inspect.threads[0]!.id, f.thread);
  const history = (await f.service.call(f.b.agentHandle, 'listProjectHistory', {})) as {
    entries: { operationId: string; kind: string }[];
  };
  assert.equal(history.entries[0]!.kind, 'createThread');
  assert.ok(history.entries[0]!.operationId);
  const exported = (await f.service.call(f.b.agentHandle, 'exportProject', {})) as {
    path: string;
    exportedAt: string;
  };
  const zip = unzipSync(await readFile(exported.path));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']!));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.exportedAt, exported.exportedAt);
  assert.deepEqual(manifest.revisions, [{ id: f.thread, revision: '1' }]);
  assert.equal('snapshotCommit' in manifest, false);
  assert.equal(await f.control.view(async s => (await s.all('requests')).length), before);
  await f.service.releaseTurn(f.a.agentHandle, turn.turn.id, turn.turn.fencingToken);
});

test('read-only thread history survives metadata changes and message retraction', async t => {
  const f = await fixture();
  t.after(f.close);
  let turn = await hold(f.service, f.a.agentHandle, f.thread);
  const appended = await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'original body' },
  );
  turn = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'retractMessage', messageId: appended.messageId! },
  );
  await hold(f.service, f.a.agentHandle, f.thread);
  const old = (await f.service.call(f.b.agentHandle, 'readRevision', {
    resourceId: f.thread,
    revision: '2',
  })) as { page: { messages: { body: string }[] } };
  assert.equal(old.page.messages[0]!.body, 'original body');
  const current = (await f.service.call(f.b.agentHandle, 'readRevision', {
    resourceId: f.thread,
    revision: '3',
  })) as { page: { messages: { body: string; retracted: boolean }[] } };
  assert.equal(current.page.messages[0]!.body, '');
  assert.equal(current.page.messages[0]!.retracted, true);
  const diff = (await f.service.call(f.b.agentHandle, 'diffRevision', {
    resourceId: f.thread,
    revision: '2',
  })) as { messagesRemoved: string[] };
  assert.deepEqual(diff.messagesRemoved, [appended.messageId]);
  const history = (await f.service.call(f.b.agentHandle, 'listHistory', {
    resourceId: f.thread,
  })) as { entries: { afterRevision: string }[] };
  assert.deepEqual(
    history.entries.map(e => e.afterRevision),
    ['3', '2', '1'],
  );
});

test('project snapshot and restore operations are absent from the public admin interface', () => {
  for (const name of [
    'inspectSnapshot',
    'exportSnapshot',
    'listSnapshotHistory',
    'previewSnapshotRestore',
    'restoreSnapshot',
    'previewRestore',
    'restoreRevision',
  ])
    assert.equal(name in adminSchemas, false);
  assert.equal(
    adminSchemas.requestTurn.safeParse({ target: { type: 'project', purpose: 'snapshot' } })
      .success,
    false,
  );
});
