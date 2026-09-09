import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TursoControl } from '../src/storage/coordination.js';
import { TursoStore } from '../src/storage/turso.js';
import { fixture, hold, errorCode, type Session } from './support.js';

test('duplicate resource ownership rolls back all coordination changes', async t => {
  const f = await fixture();
  t.after(f.close);
  await hold(f.service, f.a.agentHandle, f.thread);
  await assert.rejects(
    f.control.update(async state => {
      const first = (await state.all('requests'))[0]!;
      await state.set('requests', 'duplicate', {
        ...first,
        id: 'duplicate',
        offerId: undefined,
        turnId: 'another-turn',
        instanceId: (f.b.session as Session).adapterInstanceId,
      });
      (await state.get('identities', first.identityId))!.name = 'RolledBack';
    }),
    /UNIQUE constraint failed/,
  );
  assert.equal(await f.control.view(async state => (await state.all('requests')).length), 1);
  assert.equal(
    await f.control.view(async state =>
      (await state.all('identities')).some(i => i.name === 'RolledBack'),
    ),
    false,
  );
});

test('an incompatible Turso schema is refused without changing its version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bassfish.db');
  const original = await TursoStore.open(path, 'PRAGMA user_version=999;');
  await original.close();
  await assert.rejects(TursoControl.open(path), errorCode('SCHEMA_MISMATCH'));
  const inspect = await TursoStore.open(path);
  try {
    assert.deepEqual(await inspect.read(tx => tx.get('PRAGMA user_version')), {
      user_version: 999,
    });
  } finally {
    await inspect.close();
  }
});
