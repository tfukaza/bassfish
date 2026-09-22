import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { spawn, fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Writable, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDaemon, connectDaemon } from '../dist/daemon.js';
import { readOrCreateClaudeClientId } from '../dist/agents/claude-native.js';
import { SonarClient } from '../dist/sonar/client.js';
import { loadSonarUi } from '../dist/sonar/ui-runtime.js';
import { processMemory, measureMemoryWindow, verifyMemoryWindow } from './memory-evidence.mjs';
const exec = promisify(execFile);
const nativeMemory = process.argv.includes('--native-memory');
const nativeSamples = [];
let finalStorage;
let nativeDaemon, nativeExited;
const daemonMessage = () =>
  new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      nativeDaemon.off('message', onMessage);
      nativeDaemon.off('error', onError);
      error ? reject(error) : resolve(message);
    };
    const onMessage = message => finish(undefined, message);
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error('native daemon checkpoint timed out')), 10_000);
    nativeDaemon.once('message', onMessage);
    nativeDaemon.once('error', onError);
  });
const durationMs = Number(
  process.argv.find(a => a.startsWith('--duration-ms='))?.split('=')[1] ?? 45 * 60_000,
);
assert.ok(Number.isInteger(durationMs) && durationMs >= 10_000);
// verifyMemoryWindow needs at least four samples in the final third, so a short qualification
// run has to sample proportionally faster than the 60s cadence a full-length soak uses.
const sampleIntervalMs = Math.min(60_000, Math.max(2_000, Math.round(durationMs / 30)));
const root = await mkdtemp(
  join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-reliability-'),
);
const data = join(root, 'data'),
  repo = join(root, 'repo');
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const monitors = [],
  agents = [],
  identities = [];
let sonar,
  app,
  running,
  expectedPid,
  threadId,
  operations = 0,
  restarts = 0,
  notifications = 0;
const started = Date.now();
const connectAgents = async () => {
  for (const identity of identities) {
    const client = await connectDaemon(data);
    agents.push(client);
    await client.call('openSession', {
      workspace: repo,
      native: { host: 'claude', clientId: identity.clientId, processAncestors: [process.pid] },
      hostSessionId: identity.sessionId,
    });
  }
  const probe = await connectDaemon(data);
  try {
    expectedPid = (await probe.call('probeHealth')).pid;
  } finally {
    probe.socket.destroy();
  }
};
const call = (client, name, args = {}) => client.call('callMcpTool', { name, args });
try {
  await exec('git', ['init', repo]);
  if (nativeMemory) {
    nativeDaemon = fork(fileURLToPath(new URL('native-soak-daemon.mjs', import.meta.url)), [data], {
      execArgv: ['--expose-gc'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    nativeExited = new Promise(resolve =>
      nativeDaemon.once('exit', (code, signal) => resolve({ code, signal })),
    );
    assert.equal((await daemonMessage()).ready, true);
  }
  for (let i = 0; i < 6; i++) {
    const pluginData = join(root, 'plugin-' + i);
    identities.push({
      clientId: await readOrCreateClaudeClientId(pluginData),
      sessionId: randomUUID(),
    });
    const child = spawn(
      process.execPath,
      [
        cli,
        'notifications',
        'watch',
        '--native-claude',
        '--workspace',
        repo,
        '--plugin-data',
        pluginData,
      ],
      { env: { ...process.env, BASSFISH_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) {
          const notification = JSON.parse(line);
          assert.equal(notification.type, 'bassfish_notifications');
          notifications++;
        }
      }
    });
    child.stderr.on('data', chunk => process.stderr.write(`monitor ${i}: ${chunk}`));
    monitors.push(child);
  }
  await ensureDaemon(data);
  await connectAgents();
  threadId = (
    await call(agents[0], 'createResource', {
      resourceType: 'thread',
      title: 'Reliability soak',
      description: 'Isolated synthetic workload',
    })
  ).threadId;
  const { render, createElement, SonarApp } = await loadSonarUi();
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  sink.isTTY = true;
  sink.columns = 160;
  sink.rows = 50;
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = input.ref = input.unref = () => input;
  sonar = new SonarClient(data, repo);
  app = render(createElement(SonarApp, { client: sonar, dimensions: { columns: 160, rows: 50 } }), {
    stdout: sink,
    stderr: sink,
    stdin: input,
    interactive: true,
    alternateScreen: true,
    incrementalRendering: true,
    maxFps: 10,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  running = sonar.run();
  let nextSample = 0;
  while (Date.now() - started < durationMs) {
    for (const child of monitors) {
      assert.equal(child.exitCode, null, 'notification monitor exited');
      assert.equal(child.signalCode, null, 'notification monitor was terminated');
    }
    const probe = await connectDaemon(data);
    try {
      assert.equal((await probe.call('probeHealth')).pid, expectedPid, 'unexpected daemon restart');
    } finally {
      probe.socket.destroy();
    }
    for (let i = 0; i < agents.length; i++) {
      await call(agents[i], 'getUpdates');
      await agents[i].call('takeHostDelivery', {
        sessionId: identities[i].sessionId,
        phase: 'idle',
      });
    }
    const agent = agents[operations % agents.length];
    const turn = await call(agent, 'acquireTurn', {
      target: { type: 'thread', threadId },
    });
    await call(agent, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: {
        kind: 'appendMessage',
        body: `soak-${operations} 魚🐟`,
        mentions: { agents: [], here: false, global: true },
      },
    });
    operations++;
    if (
      !nativeMemory &&
      restarts < 2 &&
      Date.now() - started >= (durationMs * (restarts + 1)) / 3
    ) {
      for (const c of agents.splice(0)) c.socket.destroy();
      const stop = await connectDaemon(data);
      await stop.call('stopDaemon');
      stop.socket.destroy();
      await delay(1500);
      await ensureDaemon(data);
      await connectAgents();
      restarts++;
    }
    if (Date.now() >= nextSample) {
      global.gc?.();
      const memory = process.memoryUsage();
      if (nativeMemory) {
        const workingMemory = await processMemory(expectedPid);
        const checkpoint = daemonMessage();
        nativeDaemon.send({ gc: true });
        const retained = await checkpoint;
        try {
          assert.equal(retained.gc, true);
          const probe = await connectDaemon(data);
          let health;
          try {
            health = await probe.call('probeHealth');
          } finally {
            probe.socket.destroy();
          }
          assert.equal(health.pid, expectedPid, 'unexpected daemon restart');
          assert.equal(health.storage.bindingIdentity, '0.7.2-bassfish.1');
          assert.equal(health.storage.replacementFailures, 0);
          assert.equal(retained.connections, health.storage.connections.length);
          assert.equal(health.storage.active, retained.connections);
          assert.equal(health.storage.openConnections, retained.connections);
          assert.equal(health.storage.replacementsPending, 0);
          finalStorage = health.storage;
          const sample = {
            ...(await processMemory(expectedPid)),
            elapsedMs: Date.now() - started,
            heapUsedBytes: retained.memory.heapUsed,
            externalBytes: retained.memory.external,
            workingPhysicalBytes: workingMemory.physicalBytes,
            checkpointConnections: retained.connections,
          };
          nativeSamples.push(sample);
          process.stdout.write(
            JSON.stringify({
              nativeMemory: sample,
              replacements: health.storage.replacementSuccesses,
            }) + '\n',
          );
        } finally {
          if (nativeDaemon.connected) nativeDaemon.send({ resume: true });
        }
      }
      assert.ok(memory.heapUsed < 128 * 1048576, 'Sonar retained heap exceeded 128 MiB');
      assert.equal(performance.getEntriesByType('measure').length, 0);
      process.stdout.write(
        JSON.stringify({
          elapsedMs: Date.now() - started,
          operations,
          restarts,
          notifications,
          heapMiB: Math.round(memory.heapUsed / 1048576),
          rssMiB: Math.round(memory.rss / 1048576),
          pid: expectedPid,
        }) + '\n',
      );
      nextSample = Date.now() + sampleIntervalMs;
    }
    await delay(2000);
  }
  const observer = await connectDaemon(data);
  try {
    await observer.call('openObserver', { workspace: repo, protocolVersion: 2 });
    const detail = await observer.call('readObservation', { kind: 'thread', id: threadId });
    assert.equal(detail.thread.headSequence, String(operations));
  } finally {
    observer.socket.destroy();
  }
  assert.ok(notifications > 0, 'no native notification delivery observed');
  let nativeResult;
  if (nativeMemory) {
    assert.equal(restarts, 0);
    for (const suffix of ['', '.1', '.2', '.3']) {
      try {
        let pending = '';
        for await (const chunk of createReadStream(join(data, 'run', 'runtime.log' + suffix), {
          encoding: 'utf8',
        })) {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            const record = JSON.parse(line);
            assert.ok(
              record.event !== 'session.disconnected' || record.reason !== 'heartbeat_expired',
              'unexpected session expiry',
            );
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    assert.ok(finalStorage.replacementSuccesses >= 2, 'soak must span multiple recycling cycles');
    // The measured window is the final third. A short qualification run spends that window
    // still warming up, where drift legitimately exceeds the steady-state bound, so record the
    // trend without gating on it and leave the memory gate to the full-length soak.
    const gateTrend = durationMs / 3 >= 300_000;
    nativeResult = {
      ...(gateTrend ? verifyMemoryWindow : measureMemoryWindow)(
        nativeSamples.filter(s => s.elapsedMs >= (durationMs * 2) / 3),
        'daemon soak',
        Infinity,
      ),
      trendGated: gateTrend,
    };
  }
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      nativeResult,
      durationMs: Date.now() - started,
      operations,
      restarts,
      notifications,
    }) + '\n',
  );
} finally {
  for (const child of monitors) child.kill('SIGTERM');
  await Promise.all(
    monitors.map(child =>
      child.exitCode !== null || child.signalCode !== null
        ? undefined
        : new Promise(resolve => child.once('exit', resolve)),
    ),
  );
  sonar?.close();
  app?.unmount();
  await running;
  for (const agent of agents) agent.socket.destroy();
  try {
    const c = await connectDaemon(data);
    await c.call('stopDaemon');
    c.socket.destroy();
    await delay(1000);
  } catch {}
  if (nativeDaemon) {
    nativeDaemon.kill('SIGTERM');
    let timeout;
    try {
      const result = await Promise.race([
        nativeExited,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            nativeDaemon.kill('SIGKILL');
            reject(new Error('native daemon shutdown exceeded 10 seconds'));
          }, 10_000);
        }),
      ]);
      assert.equal(result.code, 0, 'native daemon exited unexpectedly');
    } finally {
      clearTimeout(timeout);
    }
  }
  await rm(root, { recursive: true, force: true });
}
