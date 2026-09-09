import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { BassfishError, requireThat } from './domain.js';
import { Bassfish } from './service.js';
import { SqliteControl } from './storage/control.js';
import { DoltContent } from './storage/dolt.js';
import { SystemClock } from './runtime.js';
import { resolveRepository } from './repository.js';
import { nameSchema } from './contracts.js';
import { exclusiveLock } from './lock.js';
import { listenRpc, RpcClient } from './ipc.js';
import { loadRuntimeConfig, runtimeConfigSchema, socketPath, packageRoot } from './config.js';
import type { RuntimeConfig } from './config.js';
import { entryArgs, requireDolt, startSql } from './supervisor.js';
import { selectNativeCandidate } from './agents/claude-native.js';
import {
  ProjectObserver,
  observerOpenSchema,
  observationReadSchema,
  observationWaitSchema,
} from './observer.js';

const wakeHostSchema = z.enum(['claude', 'opencode']);
const wakeNativeSchema = z
  .object({
    host: wakeHostSchema,
    clientId: z.string().uuid(),
    processAncestors: z.array(z.number().int().positive()).min(1).max(64),
  })
  .strict();
const nativeSchema = z.union([wakeNativeSchema, z.object({ host: z.literal('codex') }).strict()]);
const hostSessionIdSchema = z.string().min(1).max(200);
const openSchema = z
  .object({
    workspace: z.string().min(1),
    name: nameSchema.optional(),
    native: nativeSchema.optional(),
    hostSessionId: hostSessionIdSchema.optional(),
  })
  .strict();
const callSchema = z
  .object({
    name: z.string(),
    args: z.unknown().default({}),
    taskCapable: z.boolean().default(false),
    hostSessionId: hostSessionIdSchema.optional(),
  })
  .strict();
const taskSchema = z
  .object({ taskId: z.string().min(1).max(200), hostSessionId: hostSessionIdSchema.optional() })
  .strict();
const waitTaskSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    updatedAfter: z.number().int().nonnegative(),
    timeoutMs: z.number().int().min(0).max(20_000),
    hostSessionId: hostSessionIdSchema.optional(),
  })
  .strict();
const waitWorkSchema = z
  .object({
    timeoutMs: z.number().int().min(0).max(20_000),
    hostSessionId: hostSessionIdSchema.optional(),
  })
  .strict();
const bindHostSessionSchema = z.object({ sessionId: hostSessionIdSchema }).strict();
const releaseSchema = z.object({ turnId: z.string().min(1), force: z.literal(true) }).strict();
const nativeDeliverySchema = z
  .object({
    workspace: z.string().min(1),
    host: wakeHostSchema,
    clientId: z.string().uuid(),
    processAncestors: z.array(z.number().int().positive()).min(1).max(64),
    sessionId: hostSessionIdSchema.optional(),
    timeoutMs: z.number().int().min(0).max(20_000),
  })
  .strict();
const closeNativeHostSessionSchema = nativeDeliverySchema
  .omit({ timeoutMs: true })
  .extend({ sessionId: hostSessionIdSchema })
  .strict();
const hostDeliverySchema = z
  .object({
    sessionId: hostSessionIdSchema,
    phase: z.enum(['prompt', 'active', 'idle']),
  })
  .strict();
type NativeConnection = z.infer<typeof nativeSchema>;
interface AdapterSession {
  id: string;
  commonDir: string;
  workspace: string;
  name?: string;
  native?: NativeConnection;
  defaultHostSessionId?: string;
  defaultHandle?: string;
  handles: Map<string, string>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  requireThat(result.success, 'INVALID_ARGUMENT', 'Invalid backend request.');
  return result.data;
}

export type DaemonOverrides = Partial<Pick<RuntimeConfig, 'turnTimeoutMs'>>;

export async function runDaemon(
  dataDir: string,
  binary: string,
  overrides: DaemonOverrides = {},
): Promise<void> {
  process.umask(0o077);
  const path = socketPath(dataDir);
  await mkdir(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await chmod(join(dataDir, 'run'), 0o700);
  const unlock = exclusiveLock(join(dataDir, 'run', 'daemon-owner.lock'));
  let sql: Awaited<ReturnType<typeof startSql>> | undefined;
  let control: SqliteControl | undefined;
  let content: DoltContent | undefined;
  let rpc: Awaited<ReturnType<typeof listenRpc>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (closing ??= (async () => {
      if (timer) clearInterval(timer);
      // Accepted writes drain before either store is closed; process death uses recovery instead.
      await rpc?.close();
      await content?.close();
      await sql?.close();
      control?.close();
      unlock();
    })());
  try {
    const config = runtimeConfigSchema.parse({
      ...(await loadRuntimeConfig(dataDir)),
      ...overrides,
    });
    try {
      const stale = await lstat(path);
      requireThat(
        stale.isSocket(),
        'UNSAFE_SOCKET_PATH',
        'The daemon socket path contains a non-socket file.',
      );
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    sql = await startSql(dataDir, binary);
    void sql.ended.then(() => {
      if (!closing) fatal(new Error('The SQL guardian exited unexpectedly.'));
    });
    control = new SqliteControl(join(dataDir, 'control.sqlite'));
    content = new DoltContent(sql.endpoint);
    const service = new Bassfish(
      control,
      content,
      new SystemClock(),
      {
        offerMs: config.offerMs,
        turnTimeoutMs: config.turnTimeoutMs,
        reconnectMs: config.reconnectMs,
        instanceMs: config.instanceMs,
        queueMs: config.queueMs,
        retentionMs: config.retentionMs,
        waitMs: config.waitMs,
      },
      dataDir,
    );
    await service.initialize();
    const sessions = new Map<Socket, AdapterSession>();
    const observers = new Map<Socket, string>();
    const observerSockets = new WeakSet<Socket>();
    const observer = new ProjectObserver(control, content, service.epoch);
    const nativeSessions = new Map<Socket, AdapterSession>();
    const idleHostSessions = new Set<string>();
    const nativeWaiters = new Set<() => void>();
    const signalNativeChange = () => {
      for (const wake of nativeWaiters) wake();
      nativeWaiters.clear();
    };
    control.subscribe(signalNativeChange);
    const waitNativeChange = (timeout: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          nativeWaiters.delete(done);
          signal?.removeEventListener('abort', abort);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new BassfishError('CANCELLED', 'Native wake observation was cancelled.'));
        };
        nativeWaiters.add(done);
        timer = setTimeout(done, Math.max(0, timeout));
        timer.unref();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    const closeHandle = (session: AdapterSession, sessionId: string, clean = true) => {
      const handle = session.handles.get(sessionId);
      if (!handle) return;
      service.disconnect(handle, clean);
      session.handles.delete(sessionId);
      idleHostSessions.delete(`${session.id}:${sessionId}`);
      if (session.defaultHostSessionId === sessionId) session.defaultHostSessionId = undefined;
    };
    const closeAdapter = (session: AdapterSession, clean = true) => {
      for (const handle of new Set([
        ...(session.defaultHandle ? [session.defaultHandle] : []),
        ...session.handles.values(),
      ]))
        service.disconnect(handle, clean);
      session.defaultHandle = undefined;
      session.defaultHostSessionId = undefined;
      session.handles.clear();
      for (const key of [...idleHostSessions])
        if (key.startsWith(`${session.id}:`)) idleHostSessions.delete(key);
    };
    const ensureHostHandle = async (session: AdapterSession, sessionId: string) => {
      requireThat(
        session.native,
        'HOST_SESSION_UNAVAILABLE',
        'This adapter was not started by a Bassfish host plugin.',
      );
      const existing = session.handles.get(sessionId);
      if (existing) {
        try {
          service.heartbeat(existing);
          return existing;
        } catch (error) {
          if (!(error instanceof BassfishError) || error.code !== 'SESSION_EXPIRED') throw error;
          session.handles.delete(sessionId);
        }
      }
      const opened = await service.open(
        session.commonDir,
        undefined,
        session.native,
        session.workspace,
        sessionId,
      );
      session.handles.set(sessionId, opened.agentHandle);
      return opened.agentHandle;
    };
    const resolveHandle = async (session: AdapterSession, hostSessionId?: string) => {
      if (hostSessionId) return ensureHostHandle(session, hostSessionId);
      if (session.defaultHostSessionId)
        return ensureHostHandle(session, session.defaultHostSessionId);
      requireThat(
        session.defaultHandle,
        'HOST_SESSION_REQUIRED',
        'The host plugin must bind its current session before using Bassfish.',
      );
      return session.defaultHandle;
    };
    const bindHostSession = async (session: AdapterSession, sessionId: string) => {
      requireThat(
        session.native && session.native.host !== 'opencode',
        'HOST_SESSION_UNAVAILABLE',
        'Only Claude Code and Codex bind a default host session.',
      );
      if (session.defaultHostSessionId && session.defaultHostSessionId !== sessionId)
        closeHandle(session, session.defaultHostSessionId);
      const handle = await ensureHostHandle(session, sessionId);
      session.defaultHostSessionId = sessionId;
      return { agentHandle: handle, session: service.info(handle) };
    };
    let lastActivity = Date.now();
    const opening = new Set<Socket>();
    rpc = await listenRpc(
      path,
      async (method, params, signal, socket) => {
        lastActivity = Date.now();
        requireThat(!closing, 'DAEMON_STOPPING', 'The daemon is stopping.');
        requireThat(
          !observerSockets.has(socket) ||
            ['readObservation', 'waitObservation', 'closeObserver'].includes(method),
          'OBSERVER_READ_ONLY',
          'Observer connections are read-only.',
        );
        switch (method) {
          case 'openObserver': {
            requireThat(
              !sessions.has(socket) && !opening.has(socket),
              'SESSION_EXISTS',
              'This connection is already in use.',
            );
            const args = parse(observerOpenSchema, params);
            observerSockets.add(socket);
            opening.add(socket);
            try {
              const commonDir = await resolveRepository(args.workspace);
              requireThat(
                !signal.aborted && !socket.destroyed,
                'CANCELLED',
                'Observation opening cancelled.',
              );
              observers.set(socket, commonDir);
              return { protocolVersion: 1, epoch: service.epoch };
            } finally {
              opening.delete(socket);
            }
          }
          case 'readObservation': {
            const commonDir = observers.get(socket);
            requireThat(commonDir, 'OBSERVER_REQUIRED', 'Open an observer connection first.');
            return observer.read(commonDir, parse(observationReadSchema, params));
          }
          case 'waitObservation': {
            const commonDir = observers.get(socket);
            requireThat(commonDir, 'OBSERVER_REQUIRED', 'Open an observer connection first.');
            const args = parse(observationWaitSchema, params);
            return observer.wait(commonDir, args.cursor, args.timeoutMs, signal);
          }
          case 'closeObserver':
            observers.delete(socket);
            return { closed: true };
          case 'getHealth':
            return {
              apiVersion: 11,
              pid: process.pid,
              epoch: service.epoch,
              dataDir,
              state: sql?.alive() ? 'ready' : 'sqlUnavailable',
              config,
              control: service.inspect(),
            };
          case 'stopDaemon':
            setTimeout(() => {
              void stop().catch(fatal);
            }, 25);
            return { stopping: true };
          case 'inspectDaemon':
            return service.inspect();
          case 'forceRelease':
            service.forceRelease(parse(releaseSchema, params).turnId);
            return { released: true };
          case 'openSession': {
            requireThat(
              !sessions.has(socket) && !opening.has(socket),
              'SESSION_EXISTS',
              'One instance is allowed per adapter connection.',
            );
            const args = parse(openSchema, params);
            opening.add(socket);
            try {
              const commonDir = await resolveRepository(args.workspace);
              requireThat(!signal.aborted, 'CANCELLED', 'Session opening cancelled.');
              const session: AdapterSession = {
                id: randomUUID(),
                commonDir,
                workspace: args.workspace,
                name: args.name,
                native: args.native,
                handles: new Map(),
              };
              let result: { agentHandle?: string; session: unknown } = { session: null };
              if (args.native && args.hostSessionId) {
                const handle = await ensureHostHandle(session, args.hostSessionId);
                session.defaultHostSessionId = args.hostSessionId;
                result = { agentHandle: handle, session: service.info(handle) };
              } else if (!args.native) {
                const opened = await service.open(commonDir, args.name, undefined, args.workspace);
                session.defaultHandle = opened.agentHandle;
                result = opened;
              }
              if (socket.destroyed || signal.aborted) {
                closeAdapter(session, false);
                throw new BassfishError('CANCELLED', 'Adapter disconnected while opening.');
              }
              sessions.set(socket, session);
              if (args.native && 'clientId' in args.native) {
                nativeSessions.set(socket, session);
                signalNativeChange();
              }
              return result;
            } finally {
              opening.delete(socket);
            }
          }
          case 'closeSession': {
            const session = sessions.get(socket);
            if (session) closeAdapter(session);
            sessions.delete(socket);
            if (nativeSessions.delete(socket)) signalNativeChange();
            return { closed: true };
          }
          case 'heartbeatSession': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter instance first.');
            for (const handle of new Set([
              ...(session.defaultHandle ? [session.defaultHandle] : []),
              ...session.handles.values(),
            ]))
              service.heartbeat(handle);
            return { alive: true };
          }
          case 'bindHostSession': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const result = await bindHostSession(
              session,
              parse(bindHostSessionSchema, params).sessionId,
            );
            signalNativeChange();
            return result;
          }
          case 'takeHostDelivery': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            requireThat(
              session.native && session.native.host !== 'opencode',
              'HOST_SESSION_UNAVAILABLE',
              'Host delivery hooks are available only to Claude Code and Codex.',
            );
            const args = parse(hostDeliverySchema, params);
            const key = `${session.id}:${args.sessionId}`;
            if (args.phase === 'idle') idleHostSessions.add(key);
            else idleHostSessions.delete(key);
            const batch = await service.waitForDeliveryHandle(
              await ensureHostHandle(session, args.sessionId),
              0,
              args.phase === 'active' ? 'actionable' : 'all',
              signal,
            );
            if ((batch as { count: number }).count > 0) idleHostSessions.delete(key);
            signalNativeChange();
            return batch;
          }
          case 'callTool': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(callSchema, params);
            const handle = await resolveHandle(session, args.hostSessionId);
            return service.call(handle, args.name, args.args, signal, {
              taskCapable: args.taskCapable,
            });
          }
          case 'callMcpTool': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(callSchema, params);
            const handle = await resolveHandle(session, args.hostSessionId);
            return service.callMcp(handle, args.name, args.args, signal, {
              taskCapable: args.taskCapable,
            });
          }
          case 'getTask': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(taskSchema, params);
            return service.getTask(await resolveHandle(session, args.hostSessionId), args.taskId);
          }
          case 'peekTask': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(taskSchema, params);
            return service.getTask(
              await resolveHandle(session, args.hostSessionId),
              args.taskId,
              false,
            );
          }
          case 'cancelTask': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(taskSchema, params);
            return service.cancelTask(
              await resolveHandle(session, args.hostSessionId),
              args.taskId,
            );
          }
          case 'waitTask': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(waitTaskSchema, params);
            return service.waitTask(
              await resolveHandle(session, args.hostSessionId),
              args.taskId,
              args.updatedAfter,
              args.timeoutMs,
              signal,
            );
          }
          case 'waitWork': {
            const session = sessions.get(socket);
            requireThat(session, 'SESSION_REQUIRED', 'Open an adapter connection first.');
            const args = parse(waitWorkSchema, params);
            return service.waitForWork(
              await resolveHandle(session, args.hostSessionId),
              args.timeoutMs,
              signal,
            );
          }
          case 'waitNativeDelivery': {
            const args = parse(nativeDeliverySchema, params);
            const commonDir = await resolveRepository(args.workspace);
            const until = performance.now() + args.timeoutMs;
            while (true) {
              const candidates = [...nativeSessions.values()].flatMap(value => {
                const native = value.native;
                return native &&
                  'clientId' in native &&
                  value.commonDir === commonDir &&
                  native.host === args.host &&
                  native.clientId === args.clientId
                  ? [
                      {
                        handle: value.id,
                        processAncestors: native.processAncestors,
                      },
                    ]
                  : [];
              });
              const match = selectNativeCandidate(candidates, args.processAncestors);
              const remaining = Math.max(0, until - performance.now());
              if (match) {
                const session = [...nativeSessions.values()].find(
                  candidate => candidate.id === match.handle,
                );
                const sessionId = args.sessionId ?? session?.defaultHostSessionId;
                try {
                  if (
                    session &&
                    sessionId &&
                    (args.host === 'opencode' || idleHostSessions.has(`${session.id}:${sessionId}`))
                  ) {
                    const batch = await service.waitForDeliveryHandle(
                      await ensureHostHandle(session, sessionId),
                      0,
                      'all',
                      signal,
                    );
                    if ((batch as { count: number }).count > 0) {
                      idleHostSessions.delete(`${session.id}:${sessionId}`);
                      return batch;
                    }
                  }
                } catch (error) {
                  if (!(error instanceof BassfishError) || error.code !== 'SESSION_EXPIRED')
                    throw error;
                }
              }
              if (remaining <= 0)
                return {
                  kind: 'none',
                  count: 0,
                  notificationIds: [],
                  threadIds: [],
                  ticketIds: [],
                  reasons: [],
                  senders: [],
                  notifications: [],
                };
              await waitNativeChange(Math.min(remaining, 250), signal);
            }
          }
          case 'closeNativeHostSession': {
            const args = parse(closeNativeHostSessionSchema, params);
            const commonDir = await resolveRepository(args.workspace);
            const candidates = [...nativeSessions.values()].flatMap(value => {
              const native = value.native;
              return native &&
                'clientId' in native &&
                value.commonDir === commonDir &&
                native.host === args.host &&
                native.clientId === args.clientId
                ? [{ handle: value.id, processAncestors: native.processAncestors }]
                : [];
            });
            const match = selectNativeCandidate(candidates, args.processAncestors);
            const session = match
              ? [...nativeSessions.values()].find(candidate => candidate.id === match.handle)
              : undefined;
            if (session) closeHandle(session, args.sessionId);
            signalNativeChange();
            return { closed: Boolean(session) };
          }
          default:
            throw new BassfishError('UNKNOWN_METHOD', 'Unknown backend method.');
        }
      },
      socket => {
        observers.delete(socket);
        const session = sessions.get(socket);
        if (session) closeAdapter(session, false);
        sessions.delete(socket);
        if (nativeSessions.delete(socket)) signalNativeChange();
      },
    );
    await chmod(path, 0o600);
    timer = setInterval(() => {
      try {
        service.sweep();
        if (
          sessions.size === 0 &&
          observers.size === 0 &&
          !service.hasPendingWork() &&
          Date.now() - lastActivity >= config.idleMs
        )
          void stop().catch(fatal);
      } catch (error) {
        fatal(error);
      }
    }, 250);
    process.once('SIGINT', () => {
      void stop().catch(fatal);
    });
    process.once('SIGTERM', () => {
      void stop().catch(fatal);
    });
  } catch (error) {
    await stop();
    throw error;
  }
}
function fatal(error: unknown): never {
  process.stderr.write(
    `Bassfish daemon stopped: ${error instanceof BassfishError ? error.code : 'INTERNAL_ERROR'}\n`,
  );
  process.exit(1); // The SQL guardian reaps its child when this pipe closes.
}

export async function connectDaemon(dataDir: string): Promise<RpcClient> {
  return RpcClient.connect(socketPath(dataDir));
}
async function probe(dataDir: string): Promise<boolean> {
  let client;
  try {
    client = await connectDaemon(dataDir);
    const result = await client.call<{ apiVersion: number }>('getHealth');
    requireThat(result.apiVersion === 11, 'API_VERSION', 'Incompatible daemon API.');
    return true;
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false;
    throw error;
  } finally {
    client?.close();
  }
}
export async function ensureDaemon(
  dataDir: string,
  binary: string,
  overrides: DaemonOverrides = {},
): Promise<void> {
  if (await probe(dataDir)) {
    requireThat(
      overrides.turnTimeoutMs === undefined,
      'DAEMON_RUNNING',
      'The daemon is already running. Stop it before starting with a different turn timeout.',
    );
    return;
  }
  await requireDolt(binary);
  await mkdir(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
  const unlock = exclusiveLock(join(dataDir, 'run', 'startup.lock'), 10_000);
  try {
    if (await probe(dataDir)) {
      requireThat(
        overrides.turnTimeoutMs === undefined,
        'DAEMON_RUNNING',
        'Another daemon started first. Stop it before starting with a different turn timeout.',
      );
      return;
    }
    const daemonArgs =
      overrides.turnTimeoutMs === undefined
        ? []
        : ['--turn-timeout', `${overrides.turnTimeoutMs}ms`];
    const child = spawn(process.execPath, entryArgs('daemon', 'run', ...daemonArgs), {
      cwd: packageRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BASSFISH_DATA_DIR: dataDir, BASSFISH_DOLT_BIN: binary },
    });
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    child.once('exit', () => {
      failed = true;
    });
    child.unref();
    const deadline = performance.now() + 30_000;
    while (!(await probe(dataDir))) {
      if (failed || performance.now() > deadline)
        throw new BassfishError(
          'DAEMON_START_FAILED',
          'Daemon startup failed. Run bassfish daemon run in the foreground to inspect startup diagnostics.',
        );
      await delay(100);
    }
  } finally {
    unlock();
  }
}
