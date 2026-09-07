import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { SqlEndpoint } from './sql-worker.js';
import { BassfishError } from './domain.js';

export function entryArgs(command: string, ...args: string[]): string[] {
  const entry = fileURLToPath(new URL('./cli.js', import.meta.url));
  return import.meta.url.endsWith('.ts') ? ['--import', 'tsx', entry.replace(/\.js$/, '.ts'), command, ...args] : [entry, command, ...args];
}
export interface SupervisedSql {
  endpoint: SqlEndpoint;
  guardianPid: number;
  alive: () => boolean;
  ended: Promise<void>;
  close: () => Promise<void>;
}
export async function startSql(dataDir: string, binary: string): Promise<SupervisedSql> {
  let version: string;
  const isolatedConfig = join(dataDir, 'dolt-config', '.dolt');
  await mkdir(isolatedConfig, { recursive: true, mode: 0o700 });
  const configPath = join(isolatedConfig, 'config_global.json');
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // This is Bassfish's own Dolt configuration, never the user's global Dolt config.
  if (config['metrics.disabled'] !== 'true') await writeFile(configPath, JSON.stringify({ ...config, 'metrics.disabled': 'true' }), { mode: 0o600 });
  try { version = (await promisify(execFile)(binary, ['version'], { timeout: 5000, env: { ...process.env, DOLT_ROOT_PATH: join(dataDir, 'dolt-config') } })).stdout.trim(); }
  catch { throw new BassfishError('DOLT_UNAVAILABLE', 'Run npm run setup:dolt or set BASSFISH_DOLT_BIN to Dolt 2.3.2.'); }
  if (!/(?:^|\s)2\.3\.2(?:\s|$)/.test(version)) throw new BassfishError('DOLT_VERSION', 'This build is tested with Dolt 2.3.2. Set BASSFISH_DOLT_BIN to that version.');
  const child = spawn(process.execPath, entryArgs('sql-worker', dataDir, binary), { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  child.stdin.on('error', () => {});
  let closing = false;
  const ended = new Promise<void>(resolve => child.once('exit',() => {
    if (!closing && process.platform !== 'win32' && child.pid) {
      // The guardian and Dolt share a private process group. If the guardian itself
      // dies, kill any orphaned SQL process before the daemon can continue.
      try { process.kill(-child.pid,'SIGKILL'); } catch {}
    }
    resolve();
  }));
  const close = async () => { closing = true; child.stdin.end(); await reap(child); };
  try {
    const endpoint = await new Promise<SqlEndpoint>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(new Error('SQL guardian readiness timeout')), 15_000);
      lines.once('line', line => { clearTimeout(timer); try { resolve(JSON.parse(line) as SqlEndpoint); } catch (error) { reject(error); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`SQL guardian exited: ${stderr}`)); });
    });
    const deadline = performance.now() + 20_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Dolt failed to start: ${stderr}`);
      try {
        const connection = await mysql.createConnection({ ...endpoint, user: 'root', connectTimeout: 500 });
        await connection.ping(); await connection.end(); break;
      } catch (error) {
        if (performance.now() >= deadline) throw new Error(`Dolt readiness failed: ${String(error)} ${stderr}`);
        await delay(100);
      }
    }
    return { endpoint, guardianPid: child.pid!, alive: () => child.exitCode === null && child.signalCode === null, ended, close };
  } catch (error) { await close(); throw error; }
}
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Never force-kill the guardian: it owns the exclusion lock until Dolt has actually exited.
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
}
