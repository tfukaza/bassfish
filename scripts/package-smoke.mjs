import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-package-'));
const data = join(temporary, 'data');
let client;
let installedBinary;
let runtimeEnv;
try {
  const npmEnv = { ...process.env, npm_config_cache: join(temporary, 'npm-cache') };
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: root, env: npmEnv, maxBuffer: 10_000_000 });
  const manifest = JSON.parse(packed.stdout)[0];
  assert.equal(manifest.name, '@bassfish/cli');
  assert.ok(manifest.size < 1_000_000, `package tarball is unexpectedly large: ${manifest.size}`);
  const paths = manifest.files.map(file => file.path);
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/cli.js']) assert.ok(paths.includes(required), `missing ${required}`);
  assert.ok(paths.every(path => ['package.json', 'README.md', 'LICENSE'].includes(path) || path.startsWith('dist/')), `unexpected package files: ${paths.filter(path => !['package.json', 'README.md', 'LICENSE'].includes(path) && !path.startsWith('dist/')).join(', ')}`);

  const tarball = join(temporary, manifest.filename);
  assert.ok((await readFile(tarball)).byteLength > 0);
  const prefix = join(temporary, 'prefix');
  await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], { env: npmEnv, maxBuffer: 10_000_000 });
  const binary = join(prefix, 'bin', 'bassfish'); installedBinary = binary;
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal((await exec(binary, ['--version'])).stdout.trim(), packageJson.version);
  assert.match((await exec(binary, ['--help'])).stdout, /bassfish setup/);

  const env = { ...process.env, BASSFISH_DATA_DIR: data }; runtimeEnv = env;
  const first = JSON.parse((await exec(binary, ['setup'], { env, timeout: 180_000 })).stdout);
  const second = JSON.parse((await exec(binary, ['setup'], { env, timeout: 30_000 })).stdout);
  assert.equal(first.version, '2.3.2'); assert.equal(second.version, '2.3.2'); assert.equal(second.installed, false);
  const doctor = JSON.parse((await exec(binary, ['doctor'], { env })).stdout);
  assert.equal(doctor.version, packageJson.version); assert.equal(doctor.dolt.state, 'ready'); assert.equal(doctor.daemon.state, 'stopped');

  const repo = join(temporary, 'repo'); await exec('git', ['init', repo]);
  client = new Client({ name: 'bassfish-package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: binary, args: ['mcp', '--workspace', repo], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {}); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 30);
  const session = await client.callTool({ name: 'getSession', arguments: {} });
  assert.notEqual(session.isError, true); assert.ok(session.structuredContent?.projectId);
  await client.close(); client = undefined;
  await exec(binary, ['daemon', 'stop'], { env });
  await delay(100);
  process.stdout.write(JSON.stringify({ package: manifest.name, version: manifest.version, size: manifest.size, files: paths.length, status: 'pass' }, null, 2) + '\n');
} finally {
  await client?.close().catch(() => {});
  if (installedBinary && runtimeEnv) await exec(installedBinary, ['daemon', 'stop'], { env: runtimeEnv }).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
