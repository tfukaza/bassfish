import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { packageRoot } from '../../src/config.js';
const exec = promisify(execFile);
test(
  'human CLI lifecycle is quiet, idempotent, and safe to sequence',
  { timeout: 60000 },
  async t => {
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-cli-'),
    );
    const data = join(root, 'data');
    const repo = join(root, 'repo');
    const cli = join(packageRoot, 'dist', 'cli.js');
    const env = { ...process.env, BASSFISH_DATA_DIR: data };
    t.after(
      async () => await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    );
    await mkdir(repo);
    await exec('git', ['init', repo]);
    const run = async (...args: string[]) => await exec(process.execPath, [cli, ...args], { env });
    const status = await run('daemon', 'status', '--json');
    assert.deepEqual(JSON.parse(status.stdout), {
      state: 'stopped',
      diagnostics: {
        logPath: join(data, 'run', 'daemon.log'),
        runtimeLogPath: join(data, 'run', 'runtime.log'),
        clientLogPath: join(data, 'run', 'clients.log'),
      },
    });
    assert.equal(status.stderr, '');
    const redundantStop = await run('daemon', 'stop', '--json');
    assert.deepEqual(JSON.parse(redundantStop.stdout), { stopping: false, state: 'stopped' });
    assert.equal(redundantStop.stderr, '');
    const started = await run('daemon', 'start', '--json');
    assert.equal(JSON.parse(started.stdout).state, 'ready');
    assert.equal(started.stderr, '');
    const createdThread = await run(
      'thread',
      'create',
      'Readable handoff',
      '--description',
      'Human terminal output',
      '--workspace',
      repo,
      '--name',
      'Human',
      '--json',
    );
    const threadId = JSON.parse(createdThread.stdout).threadId as string;
    const threads = await run('thread', 'list', '--workspace', repo, '--plain');
    assert.match(threads.stdout, /Threads · 1/);
    assert.match(threads.stdout, /Readable handoff/);
    assert.match(threads.stdout, new RegExp(threadId));
    const createdTicket = await run(
      'ticket',
      'create',
      'Polish CLI',
      '--description',
      'Verify human output',
      '--owner',
      'Human',
      '--workspace',
      repo,
      '--name',
      'Human',
      '--json',
    );
    const ticketId = JSON.parse(createdTicket.stdout).ticketId as string;
    const tickets = await run('ticket', 'list', '--workspace', repo, '--plain');
    assert.match(tickets.stdout, /Tickets · 1/);
    assert.match(tickets.stdout, /Polish CLI/);
    assert.match(tickets.stdout, new RegExp(ticketId));
    const shownTicket = await run('ticket', 'show', ticketId, '--workspace', repo, '--plain');
    assert.match(shownTicket.stdout, /Ticket ID\s+/);
    assert.match(shownTicket.stdout, /Verify human output/);
    const project = await run('project', 'inspect', '--workspace', repo, '--plain');
    assert.match(project.stdout, /Project content/);
    assert.match(project.stdout, /Threads\s+1/);
    assert.match(project.stdout, /Tickets\s+1/);
    const stopped = await run('daemon', 'stop', '--json');
    assert.deepEqual(JSON.parse(stopped.stdout), { stopping: true });
    assert.equal(stopped.stderr, '');
    const reset = await run('data', 'reset', '--yes', '--json');
    const resetResult = JSON.parse(reset.stdout) as {
      reset: boolean;
      backup: string;
    };
    assert.equal(resetResult.reset, true);
    assert.match(resetResult.backup, /data\.backup-/);
    assert.equal(reset.stderr, '');
    const after = await run('daemon', 'status', '--plain');
    assert.equal(
      after.stdout,
      `○ Daemon stopped\n  Daemon log  ${join(data, 'run', 'daemon.log')}\n  Runtime log ${join(data, 'run', 'runtime.log')}\n  Client log  ${join(data, 'run', 'clients.log')}\n`,
    );
    assert.equal(after.stderr, '');
  },
);
