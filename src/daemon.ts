import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { BassfishError, requireThat } from './domain.js';
import { Bassfish } from './service.js';
import { SqliteControl } from './storage/control.js';
import { DoltContent } from './storage/dolt.js';
import { SystemClock } from './runtime.js';
import { resolveRepository } from './repository.js';
import { nameSchema } from './api.js';
import { exclusiveLock } from './lock.js';
import { listenRpc, RpcClient } from './ipc.js';
import { loadRuntimeConfig, socketPath, packageRoot } from './config.js';
import { entryArgs, requireDolt, startSql } from './supervisor.js';
import { NoteSearchIndex } from './storage/search.js';

const openSchema = z.object({ workspace: z.string().min(1), name: nameSchema.optional() }).strict();
const callSchema = z.object({ name: z.string(), args: z.unknown().default({}), taskCapable: z.boolean().default(false) }).strict();
const taskSchema = z.object({ taskId: z.string().min(1).max(200) }).strict();
const waitTaskSchema = z.object({ taskId: z.string().min(1).max(200), updatedAfter: z.number().int().nonnegative(), timeoutMs: z.number().int().min(0).max(20_000) }).strict();
const releaseSchema = z.object({ turnId: z.string().min(1), force: z.literal(true) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  requireThat(result.success, 'INVALID_ARGUMENT', 'Invalid backend request.');
  return result.data;
}

export async function runDaemon(dataDir: string, binary: string): Promise<void> {
  process.umask(0o077);
  const path = socketPath(dataDir);
  await mkdir(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700); await chmod(join(dataDir, 'run'), 0o700);
  const unlock = exclusiveLock(join(dataDir, 'run', 'daemon-owner.lock'));
  let sql: Awaited<ReturnType<typeof startSql>> | undefined;
  let control: SqliteControl | undefined;
  let content: DoltContent | undefined;
  let search: NoteSearchIndex | undefined;
  let rpc: Awaited<ReturnType<typeof listenRpc>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> => closing ??= (async () => {
    if (timer) clearInterval(timer);
    // Accepted writes drain before either store is closed; process death uses recovery instead.
    await rpc?.close(); search?.close(); await content?.close(); await sql?.close(); control?.close(); unlock();
  })();
  try {
    const config = await loadRuntimeConfig(dataDir);
    try { const stale = await lstat(path); requireThat(stale.isSocket(), 'UNSAFE_SOCKET_PATH', 'The daemon socket path contains a non-socket file.'); await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    sql = await startSql(dataDir, binary);
    void sql.ended.then(() => { if (!closing) fatal(new Error('The SQL guardian exited unexpectedly.')); });
    control = new SqliteControl(join(dataDir, 'control.sqlite'));
    content = new DoltContent(sql.endpoint);
    search = new NoteSearchIndex(join(dataDir,'search.sqlite'));
    const service = new Bassfish(control, content, new SystemClock(), { offerMs: config.offerMs, leaseMs: config.leaseMs, reconnectMs: config.reconnectMs,
      instanceMs: config.instanceMs, queueMs: config.queueMs, retentionMs: config.retentionMs, waitMs: config.waitMs }, search, dataDir);
    await service.initialize();
    const sessions = new Map<Socket, string>();
    let lastActivity = Date.now();
    const opening = new Set<Socket>();
    rpc = await listenRpc(path, async (method, params, signal, socket) => {
      lastActivity = Date.now();
      requireThat(!closing, 'DAEMON_STOPPING', 'The daemon is stopping.');
      switch (method) {
        case 'getHealth': return { apiVersion: 3, pid: process.pid, epoch: service.epoch, dataDir, state: sql?.alive() ? 'ready' : 'sqlUnavailable', control: service.inspect() };
        case 'stopDaemon': setTimeout(() => { void stop().catch(fatal); }, 25); return { stopping: true };
        case 'inspectDaemon': return service.inspect();
        case 'forceRelease': service.forceRelease(parse(releaseSchema, params).turnId); return { released: true };
        case 'openSession': {
          requireThat(!sessions.has(socket) && !opening.has(socket), 'SESSION_EXISTS', 'One instance is allowed per adapter connection.');
          const args = parse(openSchema, params); opening.add(socket);
          try {
            const commonDir = await resolveRepository(args.workspace);
            requireThat(!signal.aborted, 'CANCELLED', 'Session opening cancelled.');
            const result = await service.open(commonDir, args.name);
            if (socket.destroyed || signal.aborted) { service.disconnect(result.agentHandle, false); throw new BassfishError('CANCELLED', 'Adapter disconnected while opening.'); }
            sessions.set(socket, result.agentHandle); return result;
          } finally { opening.delete(socket); }
        }
        case 'closeSession': { const handle = sessions.get(socket); if (handle) service.disconnect(handle); sessions.delete(socket); return { closed: true }; }
        case 'heartbeatSession': { const handle = sessions.get(socket); requireThat(handle, 'SESSION_REQUIRED', 'Open an adapter instance first.'); service.heartbeat(handle); return { alive: true }; }
        case 'callTool': {
          const handle = sessions.get(socket); requireThat(handle, 'SESSION_REQUIRED', 'Open an adapter instance first.');
          const args = parse(callSchema, params); return service.call(handle, args.name, args.args, signal, { taskCapable: args.taskCapable });
        }
        case 'getTask': { const handle = sessions.get(socket); requireThat(handle,'SESSION_REQUIRED','Open an adapter instance first.'); return service.getTask(handle,parse(taskSchema,params).taskId); }
        case 'peekTask': { const handle = sessions.get(socket); requireThat(handle,'SESSION_REQUIRED','Open an adapter instance first.'); return service.getTask(handle,parse(taskSchema,params).taskId,false); }
        case 'cancelTask': { const handle = sessions.get(socket); requireThat(handle,'SESSION_REQUIRED','Open an adapter instance first.'); return service.cancelTask(handle,parse(taskSchema,params).taskId); }
        case 'waitTask': { const handle = sessions.get(socket); requireThat(handle,'SESSION_REQUIRED','Open an adapter instance first.'); const args = parse(waitTaskSchema,params); return service.waitTask(handle,args.taskId,args.updatedAfter,args.timeoutMs,signal); }
        default: throw new BassfishError('UNKNOWN_METHOD', 'Unknown backend method.');
      }
    }, socket => { const handle = sessions.get(socket); if (handle) service.disconnect(handle, false); sessions.delete(socket); });
    await chmod(path, 0o600);
    timer = setInterval(() => {
      try {
        service.sweep();
        if (sessions.size === 0 && !service.hasPendingWork() && Date.now() - lastActivity >= config.idleMs) void stop().catch(fatal);
      } catch (error) { fatal(error); }
    }, 250);
    process.once('SIGINT', () => { void stop().catch(fatal); });
    process.once('SIGTERM', () => { void stop().catch(fatal); });
  } catch (error) { await stop(); throw error; }
}
function fatal(error: unknown): never {
  process.stderr.write(`Bassfish daemon stopped: ${error instanceof BassfishError ? error.code : 'INTERNAL_ERROR'}\n`);
  process.exit(1); // The SQL guardian reaps its child when this pipe closes.
}

export async function connectDaemon(dataDir: string): Promise<RpcClient> {
  return RpcClient.connect(socketPath(dataDir));
}
async function probe(dataDir: string): Promise<boolean> {
  let client;
    try { client = await connectDaemon(dataDir); const result = await client.call<{ apiVersion: number }>('getHealth'); requireThat(result.apiVersion === 3, 'API_VERSION', 'Incompatible daemon API.'); return true; }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { client?.close(); }
}
export async function ensureDaemon(dataDir: string, binary: string): Promise<void> {
  if (await probe(dataDir)) return;
  await requireDolt(binary);
  await mkdir(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
  const unlock = exclusiveLock(join(dataDir, 'run', 'startup.lock'), 10_000);
  try {
    if (await probe(dataDir)) return;
    const child = spawn(process.execPath, entryArgs('daemon', 'run'), { cwd: packageRoot, detached: true, stdio: 'ignore',
      env: { ...process.env, BASSFISH_DATA_DIR: dataDir, BASSFISH_DOLT_BIN: binary } });
    let failed = false;
    child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; }); child.unref();
    const deadline = performance.now() + 30_000;
    while (!(await probe(dataDir))) {
      if (failed || performance.now() > deadline) throw new BassfishError('DAEMON_START_FAILED', 'Daemon startup failed. Run bassfish daemon run in the foreground to inspect startup diagnostics.');
      await delay(100);
    }
  } finally { unlock(); }
}
