import { ensureDaemon, connectDaemon } from '../../src/daemon.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test(
  'runtime worker records an unfinished storage operation during a blocked main loop',
  { timeout: 20000 },
  async t => {
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-runtime-stall-'),
    );
    const child = spawn(process.execPath, ['test/fixtures/runtime-diagnostics.mjs', 'stall', dir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 16000;
    while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null)
      await delay(50);
    assert.match(stdout, /ready/, stderr);
    child.stdin.write('block\n');
    let records: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline && !records.some(r => r.event === 'runtime.stall_started')) {
      records = (await readFile(join(dir, 'run', 'runtime.log'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      await delay(50);
    }
    assert.ok(
      records.some(r => r.event === 'runtime.stall_started'),
      stderr,
    );
    assert.doesNotMatch(stdout, /resumed/);
    const pending = records.find(r => r.event === 'operation.pending')!;
    assert.equal(pending.phase, 'statement');
    assert.equal(pending.method, 'fixture');
    const stall = records.find(r => r.event === 'runtime.stall_started')!;
    assert.ok(Number(stall.mainHeartbeatAgeMs) > 2000);
    assert.ok(stall.host);
    assert.ok(Number(stall.mainSampleAgeMs) >= 2000);
    assert.equal(stall.truncated, undefined);
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const final = (await readFile(join(dir, 'run', 'runtime.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.ok(final.some(r => r.event === 'runtime.stall_recovered'));
    assert.match(stdout, /resumed/);
  },
);

test(
  'isolated daemon exposes diagnostic paths, versions, and fresh runtime health',
  { timeout: 15000 },
  async t => {
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-runtime-health-'),
    );
    await ensureDaemon(dir);
    const client = await connectDaemon(dir);
    t.after(async () => {
      try {
        await client.call('stopDaemon');
      } finally {
        client.socket.destroy();
        await delay(1500);
        await rm(dir, { recursive: true, force: true });
      }
    });
    type Health = {
      diagnostics: {
        runtimeLogPath: string;
        clientLogPath: string;
        runtime: { status: string; summaryAgeMs: number };
      };
    };
    let health = await client.call<Health>('probeHealth');
    const deadline = Date.now() + 5000;
    while (health.diagnostics.runtime.status === 'starting' && Date.now() < deadline) {
      await delay(100);
      health = await client.call<Health>('probeHealth');
    }
    assert.equal(health.diagnostics.runtime.status, 'responsive');
    assert.ok(health.diagnostics.runtime.summaryAgeMs < 2000);
    assert.equal(health.diagnostics.runtimeLogPath, join(dir, 'run', 'runtime.log'));
    assert.equal(health.diagnostics.clientLogPath, join(dir, 'run', 'clients.log'));
    const records = (await readFile(health.diagnostics.runtimeLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const started = records.find(r => r.event === 'runtime.started')!;
    assert.equal(started.nodeVersion, process.versions.node);
    assert.ok(started.bassfishVersion);
    assert.equal(started.config.instanceMs, 20000);
  },
);
