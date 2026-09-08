import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectDaemon } from '../../dist/daemon.js';
import { doltBinary, packageRoot } from '../../dist/config.js';

const exec = promisify(execFile),
  dir = await mkdtemp('/private/tmp/bf-workflows-');
const repo = join(dir, 'repo'),
  data = join(dir, 'data'),
  clients = [];
const evidence = {
  kind: 'Scripted examples validated through isolated Bassfish MCP clients',
  checks: [],
  messages: [],
  file: { path: 'src/pagination.ts', text: '' },
};
async function client(name) {
  const c = new Client({ name: 'bassfish-workflow-fixture', version: '1.0.0' });
  clients.push(c);
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, 'dist/cli.js'), 'mcp', '--workspace', repo, '--name', name],
      env: { ...process.env, BASSFISH_DATA_DIR: data, BASSFISH_DOLT_BIN: doltBinary() },
      stderr: 'pipe',
    }),
  );
  return c;
}
async function call(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r));
  return r.structuredContent;
}
function checked(name, condition) {
  assert(condition, name);
  evidence.checks.push(name);
}
try {
  await exec('git', ['init', repo]);
  const api = await client('api-agent');
  const initial = await call(api, 'getContext');
  checked('One session starts online', initial.agentName === 'api-agent');
  let ui = await client('client-agent');
  checked(
    'A second connected session joins',
    (await call(api, 'getContext')).agents.some(a => a.name === 'client-agent' && a.online),
  );
  const thread = await call(api, 'createResource', {
    resourceType: 'thread',
    title: 'API pagination',
    description: '',
  });
  const target = { type: 'thread', threadId: thread.threadId };
  async function acquire(c, t = target) {
    const r = await call(c, 'acquireTurn', { target: t, timeoutMs: 0 });
    assert.equal(r.state, 'claimed');
    return r;
  }
  async function post(c, body, mentions = { agents: [], here: false }) {
    const turn = await acquire(c);
    await call(c, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: { kind: 'appendMessage', body, mentions },
    });
  }
  async function read(c) {
    const t = await acquire(c);
    await call(c, 'releaseTurn', { turnToken: t.turnToken });
    return t.messages;
  }
  await post(ui, 'Hi, I’ll take the client.');
  checked(
    'The API agent reads the client’s question',
    (await read(api)).at(-1).body === 'Hi, I’ll take the client.',
  );
  await post(api, 'Hey! Welcome to the team.');
  checked(
    'The client reads the API agent’s answer',
    (await read(ui)).at(-1).body === 'Hey! Welcome to the team.',
  );
  await ui.close();
  for (let i = 0; i < 30; i++) {
    if (
      !(await call(api, 'getContext', { includeOfflineAgents: true })).agents.find(
        a => a.name === 'client-agent',
      ).online
    )
      break;
    await delay(100);
  }
  checked(
    'Closing the client marks it offline',
    !(await call(api, 'getContext', { includeOfflineAgents: true })).agents.find(
      a => a.name === 'client-agent',
    ).online,
  );
  checked('Shared messages survive disconnection', (await read(api)).length === 2);
  ui = await client('client-agent');
  const reviewer = await client('reviewer'),
    offline = await client('offline-agent');
  await read(ui);
  await read(offline);
  await offline.close();
  for (let i = 0; i < 30; i++) {
    if (
      !(await call(api, 'getContext', { includeOfflineAgents: true })).agents.find(
        a => a.name === 'offline-agent',
      ).online
    )
      break;
    await delay(100);
  }
  await post(api, '@reviewer Can you check this?', { agents: ['reviewer'], here: false });
  checked(
    'Structured direct mention delivers a notification',
    (await call(reviewer, 'notifications', { action: 'list' })).notifications.some(n =>
      n.reasons.includes('direct_mention'),
    ),
  );
  checked(
    'The reviewer reads the mentioned thread',
    (await read(reviewer)).at(-1).body.includes('@reviewer'),
  );
  await post(reviewer, 'Looks good. Ship it.');
  await post(reviewer, '@here Review complete.', { agents: [], here: true });
  for (const [name, c] of [
    ['api-agent', api],
    ['client-agent', ui],
  ])
    checked(
      `@here reaches online follower ${name}`,
      (await call(c, 'notifications', { action: 'list' })).notifications.some(n =>
        n.reasons.includes('here'),
      ),
    );
  checked(
    '@here excludes its sender',
    !(await call(reviewer, 'notifications', { action: 'list' })).notifications.some(n =>
      n.reasons.includes('here'),
    ),
  );
  const offlineAgain = await client('offline-agent');
  checked(
    '@here excludes offline followers',
    !(await call(offlineAgain, 'notifications', { action: 'list' })).notifications.some(n =>
      n.reasons.includes('here'),
    ),
  );
  evidence.messages = (await read(api)).map(m => ({ author: m.author, body: m.body }));
  const filePath = join(repo, 'src/pagination.ts');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(filePath, '');
  const targetFile = { type: 'files', paths: [{ path: 'src/pagination.ts', kind: 'file' }] };
  const first = await acquire(api, targetFile),
    queued = await call(ui, 'acquireTurn', { target: targetFile, timeoutMs: 0 });
  checked(
    'Claude Code waits while Codex holds the file',
    queued.state === 'queued' && Boolean(queued.requestToken),
  );
  await readFile(filePath, 'utf8');
  await writeFile(filePath, 'export const pageSize = 20;\n');
  await call(api, 'releaseTurn', { turnToken: first.turnToken });
  const second = await call(ui, 'acquireTurn', {
    requestToken: queued.requestToken,
    timeoutMs: 1000,
  });
  const latest = await readFile(filePath, 'utf8');
  checked(
    'After acquiring, Claude Code reads the latest saved file',
    second.state === 'claimed' && latest === 'export const pageSize = 20;\n',
  );
  await writeFile(filePath, latest + 'export const lastPageCursor = null;\n');
  await call(ui, 'releaseTurn', { turnToken: second.turnToken });
  const final = await acquire(api, targetFile);
  evidence.file.text = await readFile(filePath, 'utf8');
  checked(
    'Both native file edits are retained',
    evidence.file.text === 'export const pageSize = 20;\nexport const lastPageCursor = null;\n',
  );
  checked('The released file can be acquired again', final.state === 'claimed');
  await call(api, 'releaseTurn', { turnToken: final.turnToken });
  // Check the actual presentation against captured content; never publish tokens or raw tool results.
  const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(
    /<[^>]*>/g,
    '',
  );
  for (const m of evidence.messages)
    assert(html.includes(m.body), `Missing captured message: ${m.body}`);
  for (const line of ['export const pageSize = 20;', 'export const lastPageCursor = null;'])
    assert(html.includes(line));
  await mkdir(new URL('../fixtures/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../fixtures/workflows.json', import.meta.url),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(
    `Validated ${evidence.checks.length} workflow behaviors; saved sanitized fixture evidence.`,
  );
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  try {
    const admin = await connectDaemon(data);
    const health = await admin.call('getHealth');
    await admin.call('stopDaemon');
    admin.close();
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(health.pid, 0);
      } catch {
        break;
      }
      await delay(50);
    }
  } catch {}
  await rm(dir, { recursive: true, force: true });
}
