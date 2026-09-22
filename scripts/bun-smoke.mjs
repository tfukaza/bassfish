// Bun regression guard. `npm run ci` runs entirely under Node and therefore cannot catch a
// Node-only builtin leaking into the OpenCode plugin entry, which OpenCode imports in-process
// under its embedded Bun. Run this with `npm run test:bun`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bun = process.env.BASSFISH_BUN ?? 'bun';

if (!process.versions.bun) {
  const probe = spawnSync(bun, ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    process.stdout.write('bun-smoke: skipped, bun is not installed\n');
    process.exit(0);
  }
  assert.equal(probe.status, 0, 'bun --version failed');
  const relaunch = spawnSync(bun, [fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(relaunch.status ?? 1);
}

const runtime = `bun ${process.versions.bun}`;
const checks = [];
const check = (name, run) => checks.push([name, run]);

// 1. The reported bug: the package entry OpenCode imports must load under Bun.
check('opencode plugin entry imports', async () => {
  const plugin = await import(join(root, 'dist/opencode-plugin.js'));
  assert.ok(typeof plugin.createBassfishPlugin === 'function');
});

// 2. Process-ownership locking must keep identical semantics on either SQLite driver.
check('exclusive lock enforces single ownership', async () => {
  const { exclusiveLock, bestEffortLock, sqliteResultCode } = await import(
    join(root, 'dist/lock.js')
  );
  const dir = mkdtempSync(join(tmpdir(), 'bassfish-bun-'));
  try {
    const path = join(dir, 'run', 'owner.lock');
    const unlock = exclusiveLock(path);
    assert.throws(() => exclusiveLock(path), { code: 'ALREADY_RUNNING' });
    unlock();
    exclusiveLock(path)();
    const corrupt = join(dir, 'run', 'corrupt.lock');
    writeFileSync(corrupt, 'not a sqlite database');
    assert.throws(
      () => exclusiveLock(corrupt),
      error => sqliteResultCode(error) === 26,
      'corrupt lock file must surface SQLITE_NOTADB on either driver',
    );
    assert.equal(typeof bestEffortLock(join(dir, 'run', 'shared.lock')), 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 3. The patched Turso N-API addon must load and run under Bun's napi implementation.
check('patched turso binding loads', async () => {
  const { connect, nativeIdentity } = await import(join(root, 'dist/storage/native.js'));
  assert.equal(nativeIdentity(), '0.7.2-bassfish.1');
  const dir = mkdtempSync(join(tmpdir(), 'bassfish-bun-db-'));
  try {
    const db = await connect(join(dir, 'probe.db'));
    assert.equal(typeof db.registryStats().prepareCount, 'number');
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 4. The CLI and daemon must run end to end with bun as process.execPath.
check('cli drives a daemon lifecycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bassfish-bun-cli-'));
  const env = { ...process.env, BASSFISH_DATA_DIR: dir };
  const cli = (...args) =>
    spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      encoding: 'utf8',
      env,
      timeout: 180_000,
    });
  try {
    const version = cli('--version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stderr, '', 'the CLI must not leak warnings to stderr under bun');
    const setup = cli('setup');
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(JSON.parse(setup.stdout).state, 'ready');
    // The runtime worker publishes its first sample on a one second cadence.
    let report;
    const deadline = Date.now() + 10_000;
    do {
      const doctor = cli('doctor', '--json');
      assert.equal(doctor.status, 0, doctor.stderr);
      report = JSON.parse(doctor.stdout);
    } while (
      report.daemon.diagnostics.runtime?.main?.sampledAt === undefined &&
      Date.now() < deadline
    );
    assert.equal(report.storage.state, 'ready');
    assert.equal(report.storage.bindingIdentity, '0.7.2-bassfish.1');
    assert.equal(report.daemon.state, 'ready');
    // Bun reports neither gc entries nor a real eventLoopUtilization; the daemon must say so
    // rather than publish zeros that would look like a healthy, idle loop.
    const main = report.daemon.diagnostics.runtime?.main ?? {};
    assert.deepEqual(main.unavailableMetrics, ['gc', 'eventLoopUtilization']);
    assert.ok(!('eventLoopUtilization' in main), 'stubbed eventLoopUtilization must be omitted');
  } finally {
    const stop = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'daemon', 'stop'], {
      encoding: 'utf8',
      env,
    });
    if (stop.status !== 0) process.stderr.write(`daemon stop: ${stop.stderr}\n`);
    rmSync(dir, { recursive: true, force: true });
  }
});

let failures = 0;
for (const [name, run] of checks) {
  try {
    await run();
    process.stdout.write(`ok   [${runtime}] ${name}\n`);
  } catch (error) {
    failures++;
    process.stdout.write(`FAIL [${runtime}] ${name}\n     ${error.message}\n`);
  }
}
process.stdout.write(`\n${checks.length - failures}/${checks.length} passed under ${runtime}\n`);
process.exit(failures ? 1 : 0);
