import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { exclusiveLock } from './lock.js';
import { requireThat } from './domain.js';

export interface SqlEndpoint {
  socketPath: string;
  password: string;
}

/** Separate guardian: daemon pipe closure kills/reaps SQL before releasing its lifetime lock. */
export async function runSqlWorker(dataDir: string, binary: string): Promise<void> {
  process.umask(0o077);
  const run = join(dataDir, 'run');
  await mkdir(run, { recursive: true, mode: 0o700 });
  const unlock = exclusiveLock(join(run, 'sql-owner.lock'), 10_000);
  const passwordPath = join(run, 'sql-password');
  let password: string;
  try {
    password = (await readFile(passwordPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    password = randomBytes(32).toString('hex');
    await writeFile(passwordPath, password, { mode: 0o600, flag: 'wx' });
  }
  requireThat(
    /^[a-f0-9]{64}$/.test(password),
    'SQL_CREDENTIALS',
    'The SQL credential file is incomplete or invalid; no listener was started.',
  );
  const projects = join(dataDir, 'projects');
  const configRoot = join(dataDir, 'dolt-config');
  await mkdir(projects, { recursive: true, mode: 0o700 });
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  // Dolt 2.3.2 initializes and persists these credentials before accepting connections.
  // Existing privileges are never reset on restart; a mismatch fails readiness closed.
  const doltEnv = {
    ...process.env,
    DOLT_ROOT_PATH: configRoot,
    DOLT_CLI_PASSWORD: undefined,
    DOLT_ROOT_PASSWORD: password,
    DOLT_ROOT_HOST: 'localhost',
  };
  const privileges = join(configRoot, 'privileges.db');
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
  const socketPath = join(run, `sql-${randomBytes(3).toString('hex')}.sock`);
  const yamlString = (s: string) => JSON.stringify(s).replaceAll('$', '$$');
  const config = [
    `data_dir: ${yamlString(projects)}`,
    `cfg_dir: ${yamlString(configRoot)}`,
    `privilege_file: ${yamlString(privileges)}`,
    `branch_control_file: ${yamlString(join(configRoot, 'branch-control.db'))}`,
    'log_level: error',
    'behavior:',
    '  autocommit: true',
    '  dolt_transaction_commit: false',
    '  event_scheduler: "OFF"',
    '  auto_gc_behavior:',
    '    enable: false',
    'listener:',
    '  host: "127.0.0.1"',
    `  port: ${port}`,
    `  socket: ${yamlString(socketPath)}`,
    '  read_timeout_millis: 60000',
    '  write_timeout_millis: 60000',
    'system_variables:',
    `  secure_file_priv: ${yamlString(join(run, 'disabled-file-access'))}`,
    '',
  ].join('\n');
  const configPath = join(run, 'sql.yaml');
  await writeFile(configPath, config, { mode: 0o600 });
  const child = spawn(binary, ['sql-server', '--config', configPath], {
    cwd: dataDir,
    env: doltEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    hard.unref();
  };
  process.stdin.resume();
  process.stdin.once('end', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // The parent connects only to this incarnation's unique socket, never a surviving old server.
  process.stdout.write(JSON.stringify({ socketPath, password } satisfies SqlEndpoint) + '\n');
  child.stdout.on('data', () => {
    /* Do not log SQL or content. */
  });
  child.stderr.on('data', data => process.stderr.write(data));
  child.once('error', error => {
    process.stderr.write(`Dolt could not start: ${error.message}\n`);
    unlock();
    process.exit(1);
  });
  child.once('exit', code => {
    unlock();
    process.exit(stopping ? 0 : code || 1);
  });
  const socketMode = setInterval(() => {
    void chmod(socketPath, 0o600).catch(() => {});
  }, 1000);
  socketMode.unref();
}
