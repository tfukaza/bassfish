import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exclusiveLock } from '../src/lock.js';
import {
  daemonDiagnostics,
  openDaemonLog,
  recordDaemonLifecycle,
  rotateDaemonLog,
} from '../src/daemon-diagnostics.js';
import { startMaintenance } from '../src/maintenance.js';

test('ownership locks distinguish contention from a corrupt lock database', async t => {
  const root = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-lock-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'lock');
  const unlock = exclusiveLock(path);
  try {
    assert.throws(() => exclusiveLock(path), { code: 'ALREADY_RUNNING' });
  } finally {
    unlock();
  }
  await writeFile(path, 'not a sqlite database');
  assert.throws(
    () => exclusiveLock(path),
    error => (error as { errcode?: number }).errcode === 26,
  );
});
test('daemon diagnostics survive exit and rotation preserves inherited append descriptors', async t => {
  const root = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-log-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  recordDaemonLifecycle(root, 'ready', { epoch: 'test' });
  const fd = openDaemonLog(root);
  t.after(() => closeSync(fd));
  for (let i = 0; i < 4; i++) {
    writeSync(fd, 'x'.repeat(1024 * 1024));
    rotateDaemonLog(root);
    writeSync(fd, `after rotation ${i}\n`);
  }
  recordDaemonLifecycle(root, 'failed', { code: 'STORAGE_UNAVAILABLE' });
  const diagnostics = daemonDiagnostics(root);
  assert.equal(diagnostics.lastLifecycle?.event, 'failed');
  assert.match(await readFile(diagnostics.logPath, 'utf8'), /after rotation 3/);
  assert.ok((await stat(diagnostics.logPath)).size < 1024 * 1024);
  assert.equal((await stat(diagnostics.logPath)).mode & 0o777, 0o600);
  assert.ok((await stat(`${diagnostics.logPath}.2`)).size >= 1024 * 1024);
});
test('maintenance serializes slow work, retries busy failures, and stops on permanent errors', async () => {
  let active = 0,
    maxActive = 0,
    calls = 0;
  const reports: boolean[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => (resolveDone = resolve));
  const permanent = new Error('corrupt');
  const stop = startMaintenance(
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls++;
      try {
        await delay(300);
        if (calls === 1) throw Object.assign(new Error('busy'), { code: 'STORAGE_BUSY' });
        if (calls === 3) throw permanent;
      } finally {
        active--;
      }
    },
    error => {
      assert.equal(error, permanent);
      resolveDone();
    },
    recovered => reports.push(recovered),
  );
  try {
    await Promise.race([
      done,
      delay(5000).then(() => {
        throw Error('maintenance did not finish');
      }),
    ]);
    assert.equal(maxActive, 1);
    assert.deepEqual(reports, [false, true]);
    await delay(500);
    assert.equal(calls, 3);
  } finally {
    stop();
  }
});
