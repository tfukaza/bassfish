import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Writable, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDaemon, connectDaemon } from '../dist/daemon.js';
import { readOrCreateClaudeClientId } from '../dist/agents/claude-native.js';
import { SonarClient } from '../dist/sonar/client.js';
import { loadSonarUi } from '../dist/sonar/ui-runtime.js';
const exec = promisify(execFile);
const durationMs = Number(
  process.argv.find(a => a.startsWith('--duration-ms='))?.split('=')[1] ?? 45 * 60_000,
);
assert.ok(Number.isInteger(durationMs) && durationMs >= 10_000);
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
      await call(agents[i], 'getContext');
      await agents[i].call('takeHostDelivery', {
        sessionId: identities[i].sessionId,
        phase: 'idle',
      });
    }
    const agent = agents[operations % agents.length];
    const turn = await call(agent, 'acquireTurn', {
      target: { type: 'thread', threadId },
      timeoutMs: 0,
    });
    await call(agent, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: { kind: 'appendMessage', body: `@global soak-${operations} 魚🐟` },
    });
    operations++;
    if (restarts < 2 && Date.now() - started >= (durationMs * (restarts + 1)) / 3) {
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
      nextSample = Date.now() + 60_000;
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
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
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
  await rm(root, { recursive: true, force: true });
}
