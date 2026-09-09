import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TursoControl } from '../../src/storage/coordination.js';
import { archiveData } from '../../src/data-reset.js';
import { exclusiveLock } from '../../src/lock.js';
import { requireFreshStorage } from '../../src/storage/turso.js';
import { loadRuntimeConfig } from '../../src/config.js';

for (const phase of ['before', 'after'])
  test(
    `SIGKILL ${phase} commit preserves one atomic content transaction`,
    { timeout: 15000 },
    async t => {
      const root = await mkdtemp(join(tmpdir(), 'bf-crash-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, 'bassfish.db');
      const child = fork(
        fileURLToPath(new URL('../fixtures/turso-crash.ts', import.meta.url)),
        [path, phase],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let diagnostics = '';
      child.stderr!.on('data', chunk => {
        diagnostics += String(chunk);
      });
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error(diagnostics);
        }),
      ]);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const control = await TursoControl.open(path);
      t.after(() => control.close());
      await control.store.read(async tx => {
        const count = async (table: string) =>
          (await tx.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))!.count;
        assert.equal(await count('messages'), phase === 'after' ? 1 : 0);
        assert.equal(await count('revisions'), phase === 'after' ? 2 : 1);
        assert.equal(await count('notifications'), phase === 'after' ? 1 : 0);
        assert.equal(
          (await tx.get<{ state: string }>('SELECT state FROM turnRequests'))!.state,
          phase === 'after' ? 'COMMITTED' : 'CLAIMED',
        );
        const row = await tx.get<{ revision: string }>('SELECT revision FROM threadContent');
        assert.equal(row!.revision, phase === 'after' ? '2' : '1');
        assert.deepEqual(await tx.all('PRAGMA foreign_key_check'), []);
        if (phase === 'after') {
          const receipt = await tx.get<{ resultJson: string }>(
            "SELECT resultJson FROM revisions WHERE revision='2'",
          );
          assert.equal(JSON.parse(receipt!.resultJson).revision, '2');
        }
      });
    },
  );

test('legacy cutover archives every file, preserves config, and refuses live ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bf-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(join(data, 'projects'), { recursive: true });
  await writeFile(join(data, 'projects', 'sentinel'), 'legacy content');
  await writeFile(join(data, 'control.sqlite'), 'legacy coordination');
  await writeFile(join(data, 'config.json'), JSON.stringify({ turnTimeoutMs: 90000 }));
  await assert.rejects(requireFreshStorage(data), /Legacy/);
  const unlock = exclusiveLock(join(data, 'run', 'daemon-owner.lock'));
  await assert.rejects(archiveData(data), /ownership lock/);
  unlock();
  const backup = await archiveData(data);
  assert.equal(await readFile(join(backup, 'projects', 'sentinel'), 'utf8'), 'legacy content');
  assert.equal(await readFile(join(backup, 'control.sqlite'), 'utf8'), 'legacy coordination');
  assert.equal((await loadRuntimeConfig(data)).turnTimeoutMs, 90000);
  await requireFreshStorage(data);
  const fresh = await TursoControl.open(join(data, 'bassfish.db'));
  try {
    assert.deepEqual(await fresh.view(s => s.all('projects')), []);
  } finally {
    await fresh.close();
  }
});
