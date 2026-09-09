import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const limit = 1024 * 1024;
export function daemonDiagnostics(dataDir: string): {
  logPath: string;
  lastLifecycle?: Record<string, unknown>;
} {
  const logPath = join(dataDir, 'run', 'daemon.log');
  try {
    return {
      logPath,
      lastLifecycle: JSON.parse(readFileSync(join(dataDir, 'run', 'daemon-state.json'), 'utf8')),
    };
  } catch {
    return { logPath };
  }
}
/** Copy/truncate preserves the inherited O_APPEND stderr descriptor across rotation. */
export function rotateDaemonLog(dataDir: string): void {
  const { logPath } = daemonDiagnostics(dataDir);
  if (!existsSync(logPath) || statSync(logPath).size < limit) return;
  if (existsSync(`${logPath}.1`)) copyFileSync(`${logPath}.1`, `${logPath}.2`);
  copyFileSync(logPath, `${logPath}.1`);
  truncateSync(logPath, 0);
  for (const path of [`${logPath}.1`, `${logPath}.2`]) if (existsSync(path)) chmodSync(path, 0o600);
}
export function openDaemonLog(dataDir: string): number {
  mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
  const fd = openSync(daemonDiagnostics(dataDir).logPath, 'a', 0o600);
  chmodSync(daemonDiagnostics(dataDir).logPath, 0o600);
  return fd;
}
export function recordDaemonLifecycle(
  dataDir: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const record = { at: new Date().toISOString(), pid: process.pid, event, ...details };
  try {
    const fd = openDaemonLog(dataDir);
    closeSync(fd);
    rotateDaemonLog(dataDir);
    appendFileSync(daemonDiagnostics(dataDir).logPath, JSON.stringify(record) + '\n');
    if (event !== 'maintenance_deferred' && event !== 'maintenance_recovered') {
      const path = join(dataDir, 'run', 'daemon-state.json');
      writeFileSync(`${path}.tmp`, JSON.stringify(record) + '\n', { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }
  } catch {
    process.stderr.write('Bassfish could not persist daemon diagnostics.\n');
  }
}
export function daemonError(error: unknown): Record<string, unknown> {
  return {
    code: (error as { code?: string } | null)?.code ?? 'INTERNAL_ERROR',
    error: error instanceof Error ? error.message.slice(0, 8192) : String(error).slice(0, 8192),
    stack: error instanceof Error ? error.stack?.slice(0, 16384) : undefined,
  };
}
