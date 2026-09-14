// Ordinary Codex TUI, real plugin hooks, fake local provider, private Bassfish state.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { RpcClient } from '../src/ipc.ts';

const execute = promisify(execFile);
// The private fixture supplies its own hooks. cmux otherwise injects another
// hook-trust flag when `codex` resolves to its shim. The installed-plugin test
// includes harmless inline command hooks to verify that both sources coexist.
const codexEnv = { ...process.env, CMUX_CODEX_HOOKS_DISABLED: '1' };
const root = resolve('.tmp/codex-queue-smoke');
await mkdir(root, { recursive: true });
const fixture = await mkdtemp(join(root, 'fixture-'));
const dataDir = await realpath(await mkdtemp('/tmp/bfn-')); // Keep the daemon Unix socket below its path limit.
const stateDir = await realpath(await mkdtemp('/tmp/bfs-'));
const installedPlugin = process.env.BASSFISH_CODEX_SMOKE_INSTALLED_PLUGIN !== '0';
if (installedPlugin) {
  codexEnv.CODEX_HOME = stateDir;
  await writeFile(
    join(stateDir, 'config.toml'),
    `[projects.${JSON.stringify(resolve('.'))}]\ntrust_level="trusted"\n`,
  );
}
const evidence = { checks: [], generations: [] };
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (name, actual, expected) => {
  const pass = actual === expected;
  evidence.checks.push({ name, actual, expected, pass });
  console.log(JSON.stringify({ name, actual, expected, pass }));
  if (!pass) throw new Error(`Check failed: ${name}`);
};
const toml = value =>
  Array.isArray(value)
    ? '[' + value.map(toml).join(', ') + ']'
    : value && typeof value === 'object'
      ? '{ ' +
        Object.entries(value)
          .map(([k, v]) => JSON.stringify(k) + ' = ' + toml(v))
          .join(', ') +
        ' }'
      : JSON.stringify(value);
let proc, server, producer;
let stderr = '';
const deadline = setTimeout(() => proc?.kill('SIGTERM'), 180000);
const waitUntil = async (name, predicate) => {
  for (let i = 0; i < 600; i++) {
    if (await predicate()) return;
    if (proc?.exitCode !== null) throw new Error(`TUI exited before ${name}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${name}`);
};
try {
  evidence.codex = (await execute('codex', ['--version'], { env: codexEnv })).stdout.trim();
  evidence.transport = 'Ordinary local TUI and codex queue; no remote session';
  evidence.hookSource = installedPlugin ? 'Installed local plugin' : 'Inline fixture hooks';
  // Read only integration names, so the private fixture cannot contact configured servers.
  const configText = await readFile(
    join(codexEnv.CODEX_HOME ?? join(process.env.HOME, '.codex'), 'config.toml'),
    'utf8',
  ).catch(() => '');
  const disabled = [];
  for (const match of configText.matchAll(/^\[(mcp_servers|plugins)\.([^\]\n]+)\]/gm))
    if (!match[2].includes('.')) disabled.push(`${match[1]}.${match[2]}.enabled=false`);
  server = createServer(async (req, res) => {
    let raw = Buffer.concat(await Array.fromAsync(req));
    if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
    else if (req.headers['content-encoding'] === 'deflate') raw = inflateSync(raw);
    else if (req.headers['content-encoding'] === 'br') raw = brotliDecompressSync(raw);
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
      return;
    }
    if (!req.url.endsWith('/responses')) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const input = JSON.parse(raw.toString());
    for (const item of input.input ?? []) {
      if (item.type !== 'message') continue;
      const text =
        typeof item.content === 'string'
          ? item.content
          : (item.content ?? []).map(p => p.text ?? '').join('\n');
      if (text.includes('[Bassfish:')) evidence.deliveredText = text.slice(0, 12 * 1024);
    }
    if (!evidence.firstRequestTools)
      evidence.firstRequestTools = (input.tools ?? []).map(t => ({
        type: t.type,
        name: t.name,
        tools: t.tools?.map(x => x.name),
      }));
    const sequence = evidence.generations.length + 1;
    evidence.generations.push({ sequence, model: input.model, requestBytes: raw.length });
    const message = {
      id: `msg_mock_${sequence}`,
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      status: 'completed',
      content: [{ type: 'output_text', text: `MOCK_WAKE_${sequence}`, annotations: [] }],
    };
    const response = {
      id: `resp_mock_${sequence}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: input.model,
      status: 'completed',
      output: [message],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    emit('response.output_item.added', {
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    });
    emit('response.output_text.delta', {
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: message.content[0].text,
    });
    emit('response.output_item.done', { output_index: 0, item: message });
    emit('response.completed', { response });
    res.end();
  });
  await new Promise((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  const overrides = [
    'model_provider="bassfish_queue_smoke"',
    'model="bassfish-wake-mock"',
    'model_providers.bassfish_queue_smoke.name="Local fake provider"',
    `model_providers.bassfish_queue_smoke.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.bassfish_queue_smoke.wire_api="responses"',
    'model_providers.bassfish_queue_smoke.requires_openai_auth=false',
    'model_providers.bassfish_queue_smoke.supports_websockets=false',
    'model_providers.bassfish_queue_smoke.request_max_retries=0',
    'model_providers.bassfish_queue_smoke.stream_max_retries=0',
    `sqlite_home=${JSON.stringify(stateDir)}`,
    `log_dir=${JSON.stringify(join(fixture, 'logs'))}`,
    'history.persistence="none"',
    'analytics.enabled=false',
    'features.code_mode=false',
    `features.plugins=${installedPlugin}`,
    'features.apps=false',
    'features.enable_request_compression=false',
    ...disabled,
  ];
  const wrapper = join(fixture, 'queue-wrapper');
  // Let stock Codex create its current schema without starting a foreground turn.
  // Mark backfill complete BEFORE the TUI starts, exclusively in the private fixture.
  await execute(
    'codex',
    [
      'queue',
      '--thread',
      '00000000-0000-0000-0000-000000000000',
      '--message',
      'Initialize private test schema',
      ...overrides.flatMap(c => ['-c', c]),
    ],
    { cwd: fixture, env: codexEnv, timeout: 15000, maxBuffer: 8192 },
  ).catch(() => {});
  const initialized = new DatabaseSync(join(stateDir, 'state_5.sqlite'));
  try {
    initialized
      .prepare(
        "INSERT INTO backfill_state(id,status,updated_at) VALUES(1,'complete',?) ON CONFLICT(id) DO UPDATE SET status='complete'",
      )
      .run(Math.floor(Date.now() / 1000));
  } finally {
    initialized.close();
  }
  evidence.privateBackfillComplete = true;
  check('Private schema initialization makes no model requests', evidence.generations.length, 0);
  await writeFile(
    wrapper,
    '#!/usr/bin/env python3\nimport os, sys, json\nconfigs=json.loads(' +
      JSON.stringify(JSON.stringify(overrides)) +
      ')\nos.execvp("codex", ["codex", *sys.argv[1:], *[part for value in configs for part in ("-c",value)]])\n',
    { mode: 0o755 },
  );
  overrides.push('features.hooks=true');
  const commandEvents = join(fixture, 'command-hooks.jsonl');
  if (installedPlugin) {
    // Copy only packaging files, with explicit private state so the installed
    // plugin cannot contact the user's daemon or model provider.
    const marketplace = join(fixture, 'marketplace');
    const plugin = join(marketplace, 'plugins', 'bassfish');
    await mkdir(join(plugin, 'hooks'), { recursive: true });
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
    await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
    for (const file of ['.codex-plugin/plugin.json', 'hooks/hooks.json'])
      await writeFile(join(plugin, file), await readFile(join('plugins/bassfish', file)));
    await writeFile(
      join(marketplace, '.agents/plugins/marketplace.json'),
      await readFile('.agents/plugins/marketplace.json'),
    );
    const mcp = JSON.parse(await readFile('plugins/bassfish/.mcp.json', 'utf8'));
    Object.assign(mcp.mcpServers.bassfish, {
      command: 'node',
      args: [resolve('dist/cli.js'), 'mcp', '--workspace', fixture],
      env: {
        BASSFISH_CODEX_NATIVE: '1',
        BASSFISH_DATA_DIR: dataDir,
        BASSFISH_CODEX_QUEUE_EXECUTABLE: wrapper,
        BASSFISH_CODEX_QUEUE_SQLITE_HOME: stateDir,
        CODEX_HOME: stateDir,
        CMUX_CODEX_HOOKS_DISABLED: '1',
        PATH: codexEnv.PATH,
      },
    });
    await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcp));
    await execute('codex', ['plugin', 'marketplace', 'add', marketplace], {
      env: codexEnv,
      timeout: 15000,
    });
    await execute('codex', ['plugin', 'add', 'bassfish@bassfish'], {
      env: codexEnv,
      timeout: 15000,
    });
    evidence.pluginConfig = await readFile(join(stateDir, 'config.toml'), 'utf8');
    evidence.pluginInventory = (
      await execute('codex', ['plugin', 'list', '--json'], { env: codexEnv, timeout: 15000 })
    ).stdout;
    const commandHook = join(fixture, 'command-hook');
    await writeFile(
      commandHook,
      '#!/usr/bin/env python3\nimport json,sys\nevent=json.load(sys.stdin)\nwith open(' +
        JSON.stringify(commandEvents) +
        ',"a") as f: f.write(json.dumps({"event":event["hook_event_name"]})+"\\n")\n',
      { mode: 0o755 },
    );
    for (const event of ['UserPromptSubmit', 'Stop'])
      overrides.push(
        `hooks.${event}=${toml([{ hooks: [{ type: 'command', command: commandHook, timeout: 3 }] }])}`,
      );
  } else {
    overrides.push(
      'mcp_servers.bassfish.enabled=true',
      `mcp_servers.bassfish.command=${JSON.stringify(resolve('dist/cli.js'))}`,
      `mcp_servers.bassfish.args=${toml(['mcp', '--workspace', fixture])}`,
      `mcp_servers.bassfish.env=${toml({
        BASSFISH_CODEX_NATIVE: '1',
        BASSFISH_CODEX_QUEUE_EXECUTABLE: wrapper,
        BASSFISH_DATA_DIR: dataDir,
        BASSFISH_CODEX_QUEUE_SQLITE_HOME: stateDir,
      })}`,
    );
    const hooks = JSON.parse(await readFile('plugins/bassfish/hooks/hooks.json', 'utf8')).hooks;
    for (const [event, value] of Object.entries(hooks))
      overrides.push(`hooks.${event}=${toml(value)}`);
  }
  const tuiLog = join(root, 'tui.log');
  const args = [
    ...overrides.flatMap(c => ['-c', c]),
    '--dangerously-bypass-hook-trust',
    '-c',
    `projects.${JSON.stringify(fixture)}.trust_level="trusted"`,
    '-C',
    fixture,
    '-s',
    'read-only',
    'Return the one-word mock response. This is a local fake-model test.',
  ];
  proc = spawn(
    'python3',
    [resolve('test/fixtures/codex-pty.py'), fixture, tuiLog, JSON.stringify(args)],
    { stdio: ['ignore', 'ignore', 'pipe'], env: codexEnv },
  );
  proc.stderr.on('data', d => {
    stderr = (stderr + d.toString()).slice(-5000);
  });
  proc.on('error', error => {
    stderr += String(error);
  });
  const visible = async text => (await readFile(tuiLog, 'utf8').catch(() => '')).includes(text);
  await waitUntil(
    'first completion',
    () => evidence.generations.length > 0 && visible('MOCK_WAKE_1'),
  );
  await delay(2000);
  const initialRequests = evidence.generations.length;
  evidence.initialModelRequests = initialRequests; // Fresh Codex homes can also generate a session title.
  const db = new DatabaseSync(join(stateDir, 'state_5.sqlite'));
  const threads = db.prepare('SELECT id, rollout_path FROM threads WHERE cwd=?').all(fixture);
  db.close();
  check('Exactly one private TUI thread', threads.length, 1);
  evidence.threadId = threads[0].id;
  evidence.ownedTestRollout = threads[0].rollout_path;
  check(
    'Initial completed foreground turn count',
    (await readFile(evidence.ownedTestRollout, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter(d => d.type === 'event_msg' && d.payload?.type === 'task_complete').length,
    1,
  );
  producer = await RpcClient.connect(join(dataDir, 'run/daemon.sock'));
  await producer.call('openSession', { workspace: fixture, name: 'SmokeProducer' });
  const context = await producer.call('callMcpTool', { name: 'getUpdates', args: {} });
  const recipient = context.agents.find(a => a.name !== 'SmokeProducer');
  check('Native hooks registered a recipient', Boolean(recipient), true);
  const created = await producer.call('callMcpTool', {
    name: 'createResource',
    args: { resourceType: 'thread', title: 'Private native wake', description: '' },
  });
  const generic = await producer.call('callMcpTool', {
    name: 'acquireTurn',
    args: { target: { type: 'thread', threadId: created.threadId } },
  });
  await producer.call('callMcpTool', {
    name: 'commitTurn',
    args: {
      turnToken: generic.turnToken,
      mutation: { kind: 'appendMessage', body: 'Generic project awareness update' },
    },
  });
  await delay(2000);
  check('Generic thread activity leaves Codex idle', evidence.generations.length, initialRequests);
  await producer.call('callMcpTool', {
    name: 'createResource',
    args: {
      resourceType: 'ticket',
      title: 'NATIVE_SMOKE_ASSIGNMENT: private assigned work',
      description: 'Please complete this assigned task',
      owner: recipient.name,
    },
  });
  const turn = await producer.call('callMcpTool', {
    name: 'acquireTurn',
    args: { target: { type: 'thread', threadId: created.threadId } },
  });
  await producer.call('callMcpTool', {
    name: 'commitTurn',
    args: {
      turnToken: turn.turnToken,
      mutation: {
        kind: 'appendMessage',
        body: 'NATIVE_SMOKE_UPDATE: please review',
        mentions: { agents: [recipient.name], here: false, global: false },
      },
    },
  });
  await producer.call('closeSession');
  producer.close();
  producer = undefined;
  await waitUntil(
    'queued completion',
    () =>
      evidence.generations.length > initialRequests && visible(`MOCK_WAKE_${initialRequests + 1}`),
  );
  await delay(2000);
  const wakeRequests = evidence.generations.length;
  evidence.wakeModelRequests = wakeRequests - initialRequests;
  check(
    'Actionable notification woke the same TUI',
    await visible(`MOCK_WAKE_${initialRequests + 1}`),
    true,
  );
  check(
    'Queued model input contains the assigned ticket',
    evidence.deliveredText?.includes('NATIVE_SMOKE_ASSIGNMENT') ?? false,
    true,
  );
  check(
    'Queued model input contains the direct mention',
    evidence.deliveredText?.includes('NATIVE_SMOKE_UPDATE') ?? false,
    true,
  );
  for (let i = 0; i < 6; i++) {
    await delay(10000);
    check(
      `No extra generation after ${(i + 1) * 10}s idle`,
      evidence.generations.length,
      wakeRequests,
    );
  }
  const rollout = (await readFile(evidence.ownedTestRollout, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  check(
    'Exactly two completed foreground turns',
    rollout.filter(d => d.type === 'event_msg' && d.payload?.type === 'task_complete').length,
    2,
  );
  const turns = rollout.filter(d => d.type === 'turn_context');
  if (installedPlugin) {
    const events = (await readFile(commandEvents, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    check(
      'Inline prompt hook coexists with the plugin',
      events.some(x => x.event === 'UserPromptSubmit'),
      true,
    );
    check(
      'Inline Stop hooks coexist with the plugin',
      events.filter(x => x.event === 'Stop').length,
      2,
    );
  }
  check('Exactly two foreground turn contexts', turns.length, 2);
  check(
    'Queue retained the original read-only sandbox',
    turns.every(d => d.payload.sandbox_policy?.type === 'read-only'),
    true,
  );
  check(
    'Queue retained the original approval policy',
    turns[1].payload.approval_policy,
    turns[0].payload.approval_policy,
  );
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.error = String(error);
  evidence.stderrTail = stderr;
  evidence.tuiTail = (await readFile(join(root, 'tui.log'), 'utf8').catch(() => '')).slice(-2048);
  evidence.tuiExitCode = proc?.exitCode;
  if (evidence.ownedTestRollout) {
    evidence.hookEvents = (await readFile(evidence.ownedTestRollout, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter(d => /hook/.test(d.payload?.type ?? ''))
      .map(d => d.payload);
  }
  try {
    const logs = new DatabaseSync(join(stateDir, 'logs_2.sqlite'), { readOnly: true });
    try {
      evidence.codexDiagnostics = logs
        .prepare(
          "SELECT level,target,substr(feedback_log_body,-1200) AS body FROM logs WHERE level IN ('WARN','ERROR') OR target LIKE '%hook%' OR target LIKE '%mcp%' ORDER BY id DESC LIMIT 12",
        )
        .all();
    } finally {
      logs.close();
    }
  } catch {}
  const fileDiagnostics = (
    await readFile(join(fixture, 'logs/codex-tui.log'), 'utf8').catch(() => '')
  )
    .split('\n')
    .filter(row => / WARN | ERROR /.test(row))
    .slice(-12)
    .map(row => row.slice(-1200));
  if (fileDiagnostics.length) evidence.codexFileDiagnostics = fileDiagnostics;
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  producer?.close();
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM');
    await Promise.race([new Promise(r => proc.once('exit', r)), delay(3000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  await execute(resolve('dist/cli.js'), ['daemon', 'stop'], {
    env: { ...process.env, BASSFISH_DATA_DIR: dataDir },
  }).catch(() => {});
  server?.closeAllConnections();
  await new Promise(r => (server ? server.close(r) : r()));
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await rm(fixture, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      evidence: join(root, 'evidence.json'),
      success: evidence.success,
      error: evidence.error,
    }),
  );
}
