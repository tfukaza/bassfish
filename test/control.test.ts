import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteControl } from '../src/storage/control.js';
import { fixture, errorCode, hold } from './support.js';

test('SQLite transactions reject duplicate ownership and roll back all changes', async t => {
  const f = await fixture(); t.after(f.close);
  await hold(f.service, f.a.agentHandle, f.thread);
  assert.throws(() => f.control.update(state => {
    const first = Object.values(state.requests)[0]!;
    state.requests.duplicate = { ...first, id: 'duplicate', instanceId: 'different-instance' };
    state.projects[first.projectId]!.recovering = true;
  }), /UNIQUE constraint failed/);
  assert.equal(f.control.view(s => Object.values(s.requests).length), 1);
  assert.equal(f.control.view(s => Object.values(s.projects)[0]!.recovering), false);
});

test('a future SQLite schema is rejected without changing its version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-schema-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite'), existing = new DatabaseSync(path);
  existing.exec('PRAGMA user_version=999'); existing.close();
  assert.throws(() => new SqliteControl(path), errorCode('SCHEMA_MISMATCH'));
  const inspect = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 999); } finally { inspect.close(); }
});
