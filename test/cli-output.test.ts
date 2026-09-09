import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { commandHelp } from '../src/cli-help.js';
import { CliOutput, outputOptions, renderHuman } from '../src/cli-output.js';
import { runThreadCli } from '../src/thread-cli.js';

const exec = promisify(execFile);

test('CLI output mode follows terminal detection and explicit overrides', () => {
  const terminal: string[] = [];
  assert.deepEqual(outputOptions(terminal, {}, { stdoutTTY: true, stdinTTY: true, columns: 120 }), {
    mode: 'human',
    color: true,
    interactive: true,
    width: 120,
  });
  const pipe: string[] = [];
  assert.equal(outputOptions(pipe, {}, { stdoutTTY: false, stdinTTY: false }).mode, 'json');
  const json = ['doctor', '--json'];
  assert.equal(outputOptions(json, {}, { stdoutTTY: true, stdinTTY: true }).mode, 'json');
  assert.deepEqual(json, ['doctor']);
  const plain = ['--plain', 'doctor'];
  assert.deepEqual(outputOptions(plain, {}, { stdoutTTY: false, stdinTTY: true, columns: 72 }), {
    mode: 'human',
    color: false,
    interactive: false,
    width: 72,
  });
  assert.deepEqual(plain, ['doctor']);
  assert.throws(
    () => outputOptions(['--plain', '--json']),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  );
});

test('NO_COLOR and dumb terminals retain the human layout without ANSI styling', () => {
  assert.equal(
    outputOptions([], { NO_COLOR: '1' }, { stdoutTTY: true, stdinTTY: true }).color,
    false,
  );
  assert.equal(
    outputOptions([], { TERM: 'dumb' }, { stdoutTTY: true, stdinTTY: true }).color,
    false,
  );
});

test('human lifecycle results are concise and preserve recovery paths', () => {
  const options = { color: false, width: 80 };
  assert.equal(
    renderHuman(
      { command: 'daemon', action: 'stop' },
      { stopping: false, state: 'stopped' },
      options,
    ),
    '○ Daemon already stopped\n',
  );
  assert.equal(
    renderHuman(
      { command: 'data', action: 'reset' },
      { reset: true, backup: '/tmp/bassfish.backup' },
      options,
    ),
    '✓ Preview data moved to backup\n  Backup      /tmp/bassfish.backup\n',
  );
  const doctor = renderHuman(
    { command: 'doctor' },
    {
      version: '0.5.1',
      node: '24.12.0',
      platform: 'darwin-arm64',
      dataDir: '/tmp/bassfish',
      storage: { state: 'ready', version: '0.7.2' },
      daemon: { state: 'stopped' },
    },
    options,
  );
  assert.match(doctor, /^Bassfish 0\.5\.1/m);
  assert.match(doctor, /Turso\s+0\.7\.2 ✓/);
  assert.match(doctor, /Daemon\s+stopped ○/);
  assert.doesNotMatch(doctor, /\u001b/);
  const config = renderHuman(
    { command: 'config', action: 'show' },
    { offerMs: 30_000, turnTimeoutMs: 60_000 },
    options,
  );
  assert.match(config, /Offer window\s+30s \(30000 ms\)/);
  assert.match(config, /Content turn\s+1m \(60000 ms\)/);
  assert.doesNotMatch(config, /Offer Ms|Turn Timeout Ms/);
});

test('narrow resource views remain stacked and keep full copyable identifiers', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const rendered = renderHuman(
    { command: 'thread', action: 'list' },
    { threads: [{ id, title: 'A long thread title', state: 'active', revision: '7' }] },
    { color: false, width: 48 },
  );
  assert.match(rendered, /A long thread title/);
  assert.match(rendered, new RegExp(id));
  assert.ok(rendered.split('\n').every(line => line.length <= 80));
});

test('confirmation defaults to no and accepts an explicit yes', async () => {
  const ask = async (answer: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(`${answer}\n`);
    const cli = new CliOutput(
      { mode: 'human', color: false, interactive: true, width: 80 },
      output,
      new PassThrough(),
      input,
    );
    return cli.confirm('Continue?');
  };
  assert.equal(await ask(''), false);
  assert.equal(await ask('yes'), true);
});

test('help is grouped and every public human command has focused usage', () => {
  const root = commandHelp();
  for (const command of [
    'setup',
    'doctor',
    'daemon',
    'config',
    'data',
    'turn',
    'thread',
    'ticket',
    'project',
    'mcp',
  ]) {
    assert.match(root, new RegExp(`\\b${command}\\b`));
    assert.match(commandHelp(command), new RegExp(`bassfish ${command}`));
  }
  assert.match(commandHelp('thread'), /thread delete THREAD_ID \[--yes\]/);
  assert.match(commandHelp('project'), /project history/);
});

test('the CLI bootstrap suppresses only the SQLite experimental warning', async () => {
  const env = { ...process.env, BASSFISH_DATA_DIR: '/private/tmp/bassfish-cli-output-missing' };
  const version = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
    env,
  });
  assert.equal(version.stdout, '0.5.1\n');
  assert.equal(version.stderr, '');
  const doctor = await exec(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'doctor', '--json'],
    { env },
  );
  assert.equal(JSON.parse(doctor.stdout).daemon.state, 'stopped');
  assert.equal(doctor.stderr, '');
});

test('noninteractive thread deletion requires an explicit confirmation flag', async () => {
  await assert.rejects(
    runThreadCli('delete', ['thread'], async <T>() => ({}) as T, {
      interactive: false,
      confirm: async () => false,
    }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRMATION_REQUIRED',
  );
});
