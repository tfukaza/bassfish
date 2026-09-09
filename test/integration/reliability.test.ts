import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDaemon, connectDaemon } from '../../src/daemon.js';
import { exclusiveLock } from '../../src/lock.js';
const exec = promisify(execFile);
test(
  'six simultaneous starts wait asynchronously through a long ownership lock',
  { timeout: 30000 },
  async t => {
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-start-test-'),
    );
    const data = join(root, 'data');
    t.after(async () => {
      try {
        const c = await connectDaemon(data);
        await c.call('stopDaemon');
        c.socket.destroy();
        await delay(1000);
      } catch {}
      await rm(root, { recursive: true, force: true });
    });
    const release = exclusiveLock(`${data}.lifecycle.lock`);
    let released = false;
    t.after(() => {
      if (!released) release();
    });
    const starts = Array.from({ length: 6 }, () => ensureDaemon(data));
    await delay(11000);
    release();
    released = true;
    await Promise.all(starts);
    const c = await connectDaemon(data);
    try {
      assert.equal((await c.call<{ state: string }>('probeHealth')).state, 'ready');
    } finally {
      c.socket.destroy();
    }
  },
);
test('startup lock wait aborts promptly without removing another owner lock', async t => {
  const root = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-abort-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const release = exclusiveLock(`${data}.lifecycle.lock`);
  try {
    const controller = new AbortController();
    const pending = ensureDaemon(data, {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const start = performance.now();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(performance.now() - start < 1000);
    assert.throws(() => exclusiveLock(`${data}.lifecycle.lock`), { code: 'ALREADY_RUNNING' });
  } finally {
    release();
  }
});
test(
  'Sonar defaults to bounded production rendering in a fresh process',
  { timeout: 190000 },
  async () => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    const { stdout } = await exec(
      process.execPath,
      ['--expose-gc', '--max-old-space-size=384', 'test/fixtures/sonar-memory.mjs'],
      { env, timeout: 180000 },
    );
    assert.match(stdout, /"frames":1000/);
    assert.match(stdout, /"mode":"production"/);
  },
);

test(
  'native monitor retries transient failures, recovers, and aborts a stalled poll',
  { timeout: 30000 },
  async t => {
    const { listenRpc } = await import('../../src/ipc.js');
    const { BassfishError } = await import('../../src/domain.js');
    const { socketPath } = await import('../../src/config.js');
    const { mkdir } = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-watch-test-'),
    );
    const data = join(root, 'data');
    await mkdir(join(data, 'run'), { recursive: true });
    const codes = [
      'ALREADY_RUNNING',
      'STORAGE_BUSY',
      'STORAGE_UNAVAILABLE',
      'OUTCOME_UNKNOWN',
      'CONNECTION_CLOSED',
      'DAEMON_STOPPING',
    ];
    let polls = 0;
    const server = await listenRpc(
      socketPath(data),
      async (method, _params, signal) => {
        if (method === 'probeHealth') return { apiVersion: 14 };
        assert.equal(method, 'waitNativeDelivery');
        const index = polls++;
        if (index < codes.length) throw new BassfishError(codes[index]!, 'temporary failure');
        if (index === codes.length) return { count: 0 };
        await delay(60000, undefined, { signal });
        return { count: 0 };
      },
      async () => {},
    );
    const child = spawn(
      process.execPath,
      [
        'dist/cli.js',
        'notifications',
        'watch',
        '--native-claude',
        '--workspace',
        root,
        '--plugin-data',
        join(root, 'plugin'),
      ],
      { env: { ...process.env, BASSFISH_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await server.close();
      await rm(root, { recursive: true, force: true });
    });
    const deadline = Date.now() + 23000;
    while (!stderr.includes('delivery recovered') && Date.now() < deadline) {
      assert.equal(child.exitCode, null, stderr);
      await delay(25);
    }
    assert.match(stderr, /delivery recovered/);
    assert.equal(stdout, '');
    assert.equal((stderr.match(/delivery deferred/g) ?? []).length, 1);
    const started = performance.now();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    assert.ok(performance.now() - started < 1000);
  },
);

test(
  'native monitor exits on incompatible daemon API with an actionable error',
  { timeout: 10000 },
  async t => {
    const { listenRpc } = await import('../../src/ipc.js');
    const { socketPath } = await import('../../src/config.js');
    const { mkdir } = await import('node:fs/promises');
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-watch-api-'),
    );
    const data = join(root, 'data');
    await mkdir(join(data, 'run'), { recursive: true });
    const server = await listenRpc(
      socketPath(data),
      async () => ({ apiVersion: 999 }),
      async () => {},
    );
    t.after(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(
      exec(
        process.execPath,
        [
          'dist/cli.js',
          'notifications',
          'watch',
          '--native-claude',
          '--workspace',
          root,
          '--plugin-data',
          join(root, 'plugin'),
        ],
        { env: { ...process.env, BASSFISH_DATA_DIR: data }, timeout: 5000 },
      ),
      error => {
        assert.match((error as { stderr: string }).stderr, /API_VERSION/);
        return true;
      },
    );
  },
);

test(
  'startup errors persist a failure record and stopped status points to it',
  { timeout: 10000 },
  async t => {
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const { daemonDiagnostics } = await import('../../src/daemon-diagnostics.js');
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-start-failure-'),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = join(root, 'data');
    await mkdir(data);
    await writeFile(join(data, 'config.json'), 'invalid json');
    await assert.rejects(ensureDaemon(data), { code: 'INVALID_CONFIG' });
    const diagnostics = daemonDiagnostics(data);
    assert.equal(diagnostics.lastLifecycle?.event, 'failed');
    assert.equal(diagnostics.lastLifecycle?.code, 'INVALID_CONFIG');
    assert.match(await readFile(diagnostics.logPath, 'utf8'), /failed/);
    const { stdout } = await exec(process.execPath, ['dist/cli.js', 'daemon', 'status', '--json'], {
      env: { ...process.env, BASSFISH_DATA_DIR: data },
    });
    const status = JSON.parse(stdout);
    assert.equal(status.state, 'stopped');
    assert.equal(status.diagnostics.lastLifecycle.event, 'failed');
  },
);

test('explicit Sonar development and test environments are preserved', async () => {
  for (const mode of ['development', 'test']) {
    const { stdout } = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const {loadSonarUi}=await import('./dist/sonar/ui-runtime.js');await loadSonarUi();console.log(process.env.NODE_ENV)",
      ],
      { env: { ...process.env, NODE_ENV: mode } },
    );
    assert.equal(stdout.trim(), mode);
  }
});

test('an unresponsive readiness probe aborts without starting another daemon', async t => {
  const { listenRpc } = await import('../../src/ipc.js');
  const { socketPath } = await import('../../src/config.js');
  const { mkdir, access } = await import('node:fs/promises');
  const root = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-probe-abort-'),
  );
  const data = join(root, 'data');
  await mkdir(join(data, 'run'), { recursive: true });
  const server = await listenRpc(
    socketPath(data),
    async (_method, _params, signal) => {
      await delay(10000, undefined, { signal });
      return { apiVersion: 14 };
    },
    async () => {},
  );
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const start = performance.now();
  await assert.rejects(ensureDaemon(data, {}, controller.signal), { name: 'AbortError' });
  assert.ok(performance.now() - start < 1000);
  await assert.rejects(access(`${data}.lifecycle.lock`), { code: 'ENOENT' });
});
