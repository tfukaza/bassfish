import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TursoStore } from '../../src/storage/turso.js';

test(
  'maintenance fatal drains valid leased writes after replacement and publication fail closed',
  { timeout: 15_000 },
  async t => {
    const dir = await mkdtemp(join(tmpdir(), 'bf-daemon-recycle-'));
    const data = join(dir, 'data');
    const child = fork(
      fileURLToPath(new URL('../fixtures/daemon-recycling-failure.ts', import.meta.url)),
      [data],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    });
    assert.equal((await once(child, 'message'))[0].ready, true);
    const held = once(child, 'message');
    child.send({ action: 'hold' });
    assert.equal((await held)[0].held, true);
    const committed = once(child, 'message');
    child.send({ action: 'fail' });
    assert.equal((await committed)[0].result, 'committed');
    let lifecycle;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      lifecycle = JSON.parse(await readFile(join(data, 'run', 'daemon-state.json'), 'utf8'));
      if (lifecycle.event === 'failed') break;
      await delay(25);
    }
    assert.equal(lifecycle.event, 'failed');
    assert.equal(lifecycle.code, 'STORAGE_UNAVAILABLE');
    assert.equal(child.exitCode, null, 'fatal must await the active transaction');
    const exited = once(child, 'exit');
    child.send({ action: 'finish' });
    assert.equal((await exited)[0], 1);
    const reopened = await TursoStore.open(join(data, 'bassfish.db'));
    try {
      assert.deepEqual(
        await reopened.read(tx => tx.all('SELECT id,n FROM drain_test ORDER BY id')),
        [
          { id: 1, n: 1 },
          { id: 2, n: 9 },
        ],
      );
    } finally {
      await reopened.close();
    }
  },
);
