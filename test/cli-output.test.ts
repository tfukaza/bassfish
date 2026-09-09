import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { commandHelp } from '../src/cli-help.js';
import { comparablePreview } from '../src/cli-helpers.js';
import { CliOutput, outputOptions, renderHuman } from '../src/cli-output.js';
import { runProjectCli } from '../src/project-cli.js';
import { runThreadCli } from '../src/thread-cli.js';
import { cancelledResult } from '../src/cli-output.js';

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
      version: '0.4.0',
      node: '24.12.0',
      platform: 'darwin-arm64',
      dataDir: '/tmp/bassfish',
      dolt: { state: 'ready', version: '2.3.2' },
      daemon: { state: 'stopped' },
    },
    options,
  );
  assert.match(doctor, /^Bassfish 0\.4\.0/m);
  assert.match(doctor, /Dolt\s+2\.3\.2 ✓/);
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

test('restore comparison ignores only turn-specific preview fields', () => {
  const left = { previewToken: 'one', expiresAt: 'soon', nextCursor: 'a', changes: [{ id: 'x' }] };
  const right = {
    previewToken: 'two',
    expiresAt: 'later',
    nextCursor: null,
    changes: [{ id: 'x' }],
  };
  assert.equal(comparablePreview(left), comparablePreview(right));
  assert.notEqual(comparablePreview(left), comparablePreview({ ...right, changes: [{ id: 'y' }] }));
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
  assert.match(commandHelp('project'), /project restore SNAPSHOT_ID/);
});

test('the CLI bootstrap suppresses only the SQLite experimental warning', async () => {
  const env = { ...process.env, BASSFISH_DATA_DIR: '/private/tmp/bassfish-cli-output-missing' };
  const version = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
    env,
  });
  assert.equal(version.stdout, '0.4.0\n');
  assert.equal(version.stderr, '');
  const doctor = await exec(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'doctor', '--json'],
    { env },
  );
  assert.equal(JSON.parse(doctor.stdout).daemon.state, 'stopped');
  assert.equal(doctor.stderr, '');
});

test('interactive thread restore releases its preview turn before asking', async () => {
  const calls: string[] = [];
  const call = async <T>(name: string): Promise<T> => {
    calls.push(name);
    if (name === 'requestTurn')
      return { state: 'offered', requestId: 'request', offerId: 'offer' } as T;
    if (name === 'claimTurn')
      return {
        turn: { id: 'turn', fencingToken: '1' },
        snapshot: { revision: '2' },
        page: {},
      } as T;
    if (name === 'previewRestore')
      return { previewToken: 'preview', fromRevision: '1', toRevision: '2' } as T;
    return { released: true } as T;
  };
  let promptCalls = 0;
  const result = await runThreadCli('restore', ['thread', '1'], call, {
    interactive: true,
    confirm: async () => {
      promptCalls++;
      assert.equal(calls.at(-1), 'releaseTurn');
      return false;
    },
  });
  assert.equal(result, cancelledResult);
  assert.equal(promptCalls, 1);
  assert.deepEqual(calls, ['requestTurn', 'claimTurn', 'previewRestore', 'releaseTurn']);
});

test('interactive thread restore shows a fresh preview when content changes during review', async () => {
  const calls: string[] = [];
  let previews = 0;
  const call = async <T>(name: string): Promise<T> => {
    calls.push(name);
    if (name === 'requestTurn')
      return { state: 'offered', requestId: 'request', offerId: 'offer' } as T;
    if (name === 'claimTurn')
      return {
        turn: { id: 'turn', fencingToken: '1' },
        snapshot: { revision: '2' },
        page: {},
      } as T;
    if (name === 'previewRestore') {
      previews++;
      return { previewToken: `preview-${previews}`, changes: [`revision-${previews}`] } as T;
    }
    return { released: true } as T;
  };
  const prompts: { prompt: string; value: unknown }[] = [];
  const result = await runThreadCli('restore', ['thread', '1'], call, {
    interactive: true,
    confirm: async (prompt, preview) => {
      assert.equal(calls.at(-1), 'releaseTurn');
      prompts.push({ prompt, value: preview?.value });
      return prompts.length === 1;
    },
  });
  assert.equal(result, cancelledResult);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!.prompt, /changed while you reviewed/);
  assert.deepEqual(prompts[1]!.value, {
    previewToken: 'preview-2',
    changes: ['revision-2'],
  });
  assert.equal(calls.includes('restoreRevision'), false);
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

test('interactive project restore gathers every preview page and releases before asking', async () => {
  const calls: { name: string; args?: unknown }[] = [];
  const call = async <T>(name: string, args?: unknown): Promise<T> => {
    calls.push({ name, args });
    if (name === 'requestTurn')
      return { state: 'offered', requestId: 'request', offerId: 'offer' } as T;
    if (name === 'claimTurn')
      return {
        turn: { id: 'turn', fencingToken: '1' },
        snapshot: { revision: '2' },
        page: {},
      } as T;
    if (name === 'previewSnapshotRestore') {
      const cursor = (args as { cursor?: string }).cursor;
      return {
        previewToken: 'preview',
        currentCommit: 'current',
        targetCommit: 'target',
        changes: [{ resourceId: cursor ? 'two' : 'one' }],
        nextCursor: cursor ? null : 'next',
      } as T;
    }
    return { released: true } as T;
  };
  let shown: unknown;
  const result = await runProjectCli('restore', ['snapshot', '--limit', '1'], call, {
    interactive: true,
    confirm: async (_prompt, preview) => {
      shown = preview?.value;
      assert.equal(calls.at(-1)?.name, 'releaseTurn');
      return false;
    },
  });
  assert.equal(result, cancelledResult);
  assert.deepEqual((shown as { changes: unknown[] }).changes, [
    { resourceId: 'one' },
    { resourceId: 'two' },
  ]);
  assert.deepEqual(
    calls.map(item => item.name),
    ['requestTurn', 'claimTurn', 'previewSnapshotRestore', 'previewSnapshotRestore', 'releaseTurn'],
  );
});
