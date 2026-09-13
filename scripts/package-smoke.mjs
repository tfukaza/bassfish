import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(
  join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-package-'),
);
const data = join(temporary, 'data');
let client;
let installedBinary;
let runtimeEnv;
try {
  const npmEnv = { ...process.env, npm_config_cache: join(temporary, 'npm-cache') };
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', temporary], {
    cwd: root,
    env: npmEnv,
    maxBuffer: 10_000_000,
  });
  const manifest = JSON.parse(packed.stdout)[0];
  assert.equal(manifest.name, '@bassfish/cli');
  assert.ok(manifest.size < 1_000_000, `package tarball is unexpectedly large: ${manifest.size}`);
  const paths = manifest.files.map(file => file.path);
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    '.claude-plugin/marketplace.json',
    'dist/cli.js',
    'dist/opencode-plugin.js',
    'dist/runtime-diagnostics.js',
    'dist/runtime-diagnostics-worker.js',
    'dist/runtime-sampler.js',
    'plugins/claude/.claude-plugin/plugin.json',
    'plugins/claude/hooks/hooks.json',
    'plugins/claude/monitors/monitors.json',
    'plugins/claude/bin/bassfish-launcher',
    'plugins/claude/skills/coordinate-peers/SKILL.md',
    'plugins/bassfish/.codex-plugin/plugin.json',
    'plugins/bassfish/.mcp.json',
    'plugins/bassfish/plugin.json',
    'plugins/bassfish/mcp.json',
    'plugins/bassfish/hooks/hooks.json',
    'plugins/opencode/README.md',
  ])
    assert.ok(paths.includes(required), `missing ${required}`);
  for (const removed of [
    'dist/agent-runner.js',
    'dist/agents/opencode.js',
    'dist/agents/wake-source.js',
    'dist/sql-worker.js',
    'dist/storage/dolt.js',
    'dist/storage/control.js',
    'dist/storage/restartable-content.js',
    'plugins/opencode/bassfish.js',
  ])
    assert.equal(paths.includes(removed), false, `obsolete runner artifact ${removed}`);
  assert.ok(
    paths.every(
      path =>
        ['package.json', 'README.md', 'LICENSE'].includes(path) ||
        path.startsWith('.claude-plugin/') ||
        path.startsWith('dist/') ||
        path.startsWith('plugins/'),
    ),
    `unexpected package files: ${paths.filter(path => !['package.json', 'README.md', 'LICENSE'].includes(path) && !path.startsWith('.claude-plugin/') && !path.startsWith('dist/') && !path.startsWith('plugins/')).join(', ')}`,
  );

  const tarball = join(temporary, manifest.filename);
  assert.ok((await readFile(tarball)).byteLength > 0);
  const prefix = join(temporary, 'prefix');
  await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], {
    env: npmEnv,
    maxBuffer: 10_000_000,
  });
  const binary = join(prefix, 'bin', 'bassfish');
  installedBinary = binary;
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const installedRoot = join(prefix, 'lib', 'node_modules', '@bassfish', 'cli');
  const installedLauncher = join(installedRoot, 'plugins', 'claude', 'bin', 'bassfish-launcher');
  assert.notEqual(
    (await stat(installedLauncher)).mode & 0o111,
    0,
    'Claude launcher is not executable',
  );
  const marketplace = JSON.parse(
    await readFile(join(installedRoot, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  const claudePlugin = JSON.parse(
    await readFile(
      join(installedRoot, 'plugins', 'claude', '.claude-plugin', 'plugin.json'),
      'utf8',
    ),
  );
  const codexPlugin = JSON.parse(
    await readFile(
      join(installedRoot, 'plugins', 'bassfish', '.codex-plugin', 'plugin.json'),
      'utf8',
    ),
  );
  const portableCodexPlugin = JSON.parse(
    await readFile(join(installedRoot, 'plugins', 'bassfish', 'plugin.json'), 'utf8'),
  );
  const portableCodexMcp = JSON.parse(
    await readFile(join(installedRoot, 'plugins', 'bassfish', 'mcp.json'), 'utf8'),
  );
  assert.equal(
    marketplace.plugins.find(plugin => plugin.name === 'bassfish')?.version,
    packageJson.version,
  );
  assert.equal(claudePlugin.version, packageJson.version);
  assert.match(
    codexPlugin.version,
    new RegExp(`^${packageJson.version.replaceAll('.', '\\.')}\\+codex\\.\\d{14}$`),
  );
  assert.equal(portableCodexPlugin.version, packageJson.version);
  assert.equal(portableCodexPlugin.name, codexPlugin.name);
  assert.equal(portableCodexPlugin.description, codexPlugin.description);
  assert.deepEqual(portableCodexPlugin.extensions['com.openai'].interface, codexPlugin.interface);
  assert.equal(portableCodexPlugin.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.equal(portableCodexMcp.mcpServers.bassfish.type, 'stdio');
  assert.equal((await exec(binary, ['--version'])).stdout.trim(), packageJson.version);
  assert.match((await exec(binary, ['--help'])).stdout, /bassfish setup/);

  const env = { ...process.env, BASSFISH_DATA_DIR: data };
  runtimeEnv = env;
  const first = JSON.parse((await exec(binary, ['setup'], { env, timeout: 180_000 })).stdout);
  const second = JSON.parse((await exec(binary, ['setup'], { env, timeout: 30_000 })).stdout);
  assert.equal(first.version, '0.7.2');
  assert.equal(second.version, '0.7.2');
  assert.equal(second.state, 'ready');
  let doctor = JSON.parse((await exec(binary, ['doctor'], { env })).stdout);
  const runtimeDeadline = Date.now() + 5000;
  while (doctor.daemon.diagnostics.runtime?.status === 'starting' && Date.now() < runtimeDeadline) {
    await delay(100);
    doctor = JSON.parse((await exec(binary, ['doctor'], { env })).stdout);
  }
  assert.equal(
    doctor.daemon.diagnostics.runtime?.status,
    'responsive',
    'installed runtime worker did not become healthy',
  );
  assert.ok(doctor.daemon.diagnostics.runtime.summaryAgeMs < 2000);
  assert.equal(doctor.version, packageJson.version);
  assert.equal(doctor.storage.state, 'ready');
  assert.equal(doctor.daemon.state, 'ready');

  const repo = join(temporary, 'repo');
  await exec('git', ['init', repo]);
  client = new Client({ name: 'bassfish-package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: binary,
    args: ['mcp', '--workspace', repo],
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  assert.match(client.getInstructions() ?? '', /inspect the latest relevant discussions/);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.ok(tools.every(tool => tool.outputSchema?.type === 'object'));
  const session = await client.callTool({ name: 'getContext', arguments: {} });
  assert.notEqual(session.isError, true);
  assert.ok(session.structuredContent?.agentName);
  assert.deepEqual(session.content, []);
  await client.close();
  client = undefined;
  await exec(binary, ['daemon', 'stop'], { env });
  await delay(100);
  process.stdout.write(
    JSON.stringify(
      {
        package: manifest.name,
        version: manifest.version,
        size: manifest.size,
        files: paths.length,
        status: 'pass',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await client?.close().catch(() => {});
  if (installedBinary && runtimeEnv)
    await exec(installedBinary, ['daemon', 'stop'], { env: runtimeEnv }).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
