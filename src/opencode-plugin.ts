import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory, socketPath } from './config.js';
import { RpcClient } from './ipc.js';
import { processAncestry, readOrCreateOpenCodeClientId } from './agents/claude-native.js';
import {
  formatDeliveryContext,
  type DeliveredNotification,
  type DeliveryBatch,
} from './notification-delivery.js';

export type OpenCodeDeliveryBatch = DeliveryBatch;

interface OpenCodeClient {
  session: {
    get(options: unknown): Promise<unknown>;
    status(options: unknown): Promise<unknown>;
    prompt(options: unknown): Promise<unknown>;
  };
  app: { log(options: unknown): Promise<unknown> };
}

export interface OpenCodePluginInput {
  client: OpenCodeClient;
  directory: string;
}
export type OpenCodePluginOptions = Record<string, never>;
interface WakeClient {
  call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  close(): void;
}
export interface OpenCodePluginDependencies {
  connect?: (dataDir: string) => Promise<WakeClient>;
  clientId?: (dataDir: string) => Promise<string>;
  ancestry?: () => Promise<number[]>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const reservedEnvironment = {
  BASSFISH_OPENCODE_NATIVE: '1',
};
const hostSessionRouteKey = '__bassfishHostSessionId';
const bassfishToolNames = new Set([
  'getContext',
  'setAgentName',
  'notifications',
  'waitForWork',
  'findResources',
  'createResource',
  'acquireTurn',
  'cancelTurn',
  'readTurn',
  'commitTurn',
  'releaseTurn',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function responseData(value: unknown): unknown {
  const wrapper = record(value);
  if (!wrapper) return value;
  if (wrapper.error) throw new Error('OpenCode rejected a Bassfish plugin request.');
  return 'data' in wrapper ? wrapper.data : value;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(value.filter(item => typeof item === 'string' && item.length > 0) as string[]),
      ].slice(0, 100)
    : [];
}
function commandIsBassfish(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string') &&
    value.some(item => item === 'bassfish' || item.endsWith('/bassfish')) &&
    value.includes('mcp')
  );
}
function isBassfishTool(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (const name of bassfishToolNames)
    if (
      value === name ||
      value === `bassfish_${name}` ||
      value === `mcp__bassfish__${name}` ||
      value.endsWith(`__bassfish__${name}`)
    )
      return true;
  return false;
}

/** Adds native delivery metadata without replacing user-owned Bassfish MCP settings. */
export function configureOpenCodeMcp(
  config: Record<string, unknown>,
  directory: string,
  _rawOptions: unknown = {},
): string {
  const mcp = config.mcp === undefined ? {} : record(config.mcp);
  if (!mcp) throw new Error('OpenCode config.mcp must be an object for the Bassfish plugin.');
  const current = mcp.bassfish === undefined ? undefined : record(mcp.bassfish);
  if (mcp.bassfish !== undefined && !current)
    throw new Error('OpenCode mcp.bassfish must be a local MCP object.');
  if (current && (current.type !== 'local' || !commandIsBassfish(current.command))) {
    throw new Error(
      'The Bassfish OpenCode plugin cannot augment a non-local or non-Bassfish mcp.bassfish entry.',
    );
  }
  const environment = current?.environment === undefined ? {} : record(current.environment);
  if (!environment) throw new Error('OpenCode mcp.bassfish.environment must be an object.');
  const configuredEnvironment: Record<string, unknown> = {
    ...environment,
    ...reservedEnvironment,
  };
  delete configuredEnvironment.BASSFISH_WAKE_MODE;
  delete configuredEnvironment.BASSFISH_MAX_AUTO_WAKES_PER_HOUR;
  mcp.bassfish = {
    ...(current ?? {}),
    type: 'local',
    enabled: true,
    command: current?.command ?? ['bassfish', 'mcp', '--workspace', directory],
    environment: configuredEnvironment,
  };
  config.mcp = mcp;
  const configuredDataDir = configuredEnvironment.BASSFISH_DATA_DIR;
  if (typeof configuredDataDir === 'string' && configuredDataDir !== '{env:BASSFISH_DATA_DIR}')
    return configuredDataDir;
  return dataDirectory();
}

export function formatOpenCodeDeliveryPrompt(batch: OpenCodeDeliveryBatch): string {
  return formatDeliveryContext(batch);
}

function mergeDelivery(
  left: OpenCodeDeliveryBatch,
  right: OpenCodeDeliveryBatch,
): OpenCodeDeliveryBatch {
  const byId = new Map<string, DeliveredNotification>();
  for (const notification of [...left.notifications, ...right.notifications])
    byId.set(notification.notificationId, notification);
  return {
    kind:
      left.kind === 'actionable' || right.kind === 'actionable'
        ? 'actionable'
        : left.kind === 'activity' || right.kind === 'activity'
          ? 'activity'
          : 'none',
    count: new Set([...left.notificationIds, ...right.notificationIds]).size,
    notificationIds: strings([...left.notificationIds, ...right.notificationIds]),
    threadIds: strings([...left.threadIds, ...right.threadIds]),
    ticketIds: strings([...left.ticketIds, ...right.ticketIds]),
    reasons: strings([...left.reasons, ...right.reasons]),
    senders: strings([...left.senders, ...right.senders]),
    notifications: [...byId.values()],
  };
}
const emptyDelivery = (): OpenCodeDeliveryBatch => ({
  kind: 'none',
  count: 0,
  notificationIds: [],
  threadIds: [],
  ticketIds: [],
  reasons: [],
  senders: [],
  notifications: [],
});

export function createBassfishPlugin(dependencies: OpenCodePluginDependencies = {}) {
  const connect = dependencies.connect ?? (async dir => RpcClient.connect(socketPath(dir)));
  const getClientId = dependencies.clientId ?? readOrCreateOpenCodeClientId;
  const getAncestry = dependencies.ancestry ?? processAncestry;
  const wait =
    dependencies.delay ??
    (async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    });

  return async function BassfishPlugin(input: OpenCodePluginInput, rawOptions: unknown = {}) {
    const abort = new AbortController();
    const parents = new Map<string, string | undefined>();
    const sessions = new Map<
      string,
      {
        idle: boolean;
        actionable: OpenCodeDeliveryBatch;
        activity: OpenCodeDeliveryBatch;
        injecting: boolean;
        controller: AbortController;
        client?: WakeClient;
      }
    >();
    let runtimeDataDir: string | undefined;
    let nativeIdentity: Promise<{ clientId: string; processAncestors: number[] }> | undefined;

    const log = async (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => {
      await input.client.app
        .log({
          body: {
            service: 'bassfish',
            level,
            message,
            ...(error === undefined
              ? {}
              : { extra: { error: error instanceof Error ? error.message : String(error) } }),
          },
        })
        .catch(() => {});
    };
    const session = async (sessionID: string): Promise<Record<string, unknown> | undefined> => {
      const result = record(
        responseData(
          await input.client.session.get({
            path: { id: sessionID },
            query: { directory: input.directory },
          }),
        ),
      );
      if (result)
        parents.set(sessionID, typeof result.parentID === 'string' ? result.parentID : undefined);
      return result;
    };
    const rootSession = async (sessionID: string): Promise<string> => {
      let current = sessionID;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        if (!parents.has(current)) await session(current);
        const parent = parents.get(current);
        if (!parent) return current;
        current = parent;
      }
      return sessionID;
    };
    const statusIsIdle = async (sessionID: string): Promise<boolean> => {
      const statuses = record(
        responseData(await input.client.session.status({ query: { directory: input.directory } })),
      );
      return record(statuses?.[sessionID])?.type === 'idle';
    };
    const schedule = (sessionID: string) => {
      const state = sessions.get(sessionID);
      if (!state || state.injecting) return;
      const queue =
        state.actionable.notificationIds.length > 0
          ? 'actionable'
          : state.idle && state.activity.notificationIds.length > 0
            ? 'activity'
            : undefined;
      if (!queue) return;
      state.injecting = true;
      let attempted: OpenCodeDeliveryBatch | undefined;
      queueMicrotask(() => {
        void (async () => {
          if (state.idle) {
            const idle = await statusIsIdle(sessionID);
            if (!idle) {
              state.idle = false;
              if (queue === 'activity') return;
            }
          }
          attempted = state[queue];
          state[queue] = emptyDelivery();
          const resume = state.idle;
          if (resume) state.idle = false;
          responseData(
            await input.client.session.prompt({
              path: { id: sessionID },
              query: { directory: input.directory },
              body: {
                ...(!resume ? { noReply: true } : {}),
                parts: [
                  { type: 'text', text: formatOpenCodeDeliveryPrompt(attempted), synthetic: true },
                ],
              },
            }),
          );
        })()
          .catch(error => {
            if (attempted) state[queue] = mergeDelivery(attempted, state[queue]);
            void log('error', 'Bassfish notification injection failed.', error);
          })
          .finally(() => {
            state.injecting = false;
            schedule(sessionID);
          });
      });
    };
    const runPump = async (sessionID: string, dataDir: string) => {
      const state = sessions.get(sessionID);
      if (!state) return;
      const { clientId, processAncestors } = await (nativeIdentity ??= Promise.all([
        getClientId(dataDir),
        getAncestry(),
      ]).then(([id, ancestors]) => ({ clientId: id, processAncestors: ancestors })));
      let backoff = 250;
      while (!abort.signal.aborted && !state.controller.signal.aborted) {
        try {
          state.client = await connect(dataDir);
          backoff = 250;
          while (!abort.signal.aborted && !state.controller.signal.aborted) {
            const batch: OpenCodeDeliveryBatch = await state.client.call<OpenCodeDeliveryBatch>(
              'waitNativeDelivery',
              {
                workspace: input.directory,
                host: 'opencode',
                clientId,
                processAncestors,
                sessionId: sessionID,
                timeoutMs: 20_000,
              },
              state.controller.signal,
            );
            if (batch.count > 0 && batch.notificationIds.length > 0) {
              const queue = batch.kind === 'actionable' ? 'actionable' : 'activity';
              state[queue] = mergeDelivery(state[queue], batch);
              schedule(sessionID);
            }
          }
        } catch (error) {
          state.client?.close();
          state.client = undefined;
          if (abort.signal.aborted || state.controller.signal.aborted) return;
          await log('error', 'Bassfish native delivery connection stopped; reconnecting.', error);
          try {
            await wait(backoff, state.controller.signal);
          } catch {
            return;
          }
          backoff = Math.min(backoff * 2, 5_000);
        }
      }
    };
    const ensureSession = (sessionID: string) => {
      let state = sessions.get(sessionID);
      if (!state) {
        state = {
          idle: false,
          actionable: emptyDelivery(),
          activity: emptyDelivery(),
          injecting: false,
          controller: new AbortController(),
        };
        sessions.set(sessionID, state);
        if (runtimeDataDir) void runPump(sessionID, runtimeDataDir);
      }
      return state;
    };
    const closeSession = async (sessionID: string) => {
      const state = sessions.get(sessionID);
      if (!state) return;
      state.controller.abort();
      state.client?.close();
      sessions.delete(sessionID);
      if (!runtimeDataDir) return;
      try {
        const { clientId, processAncestors } = await nativeIdentity!;
        const client = await connect(runtimeDataDir);
        try {
          await client.call('closeNativeHostSession', {
            workspace: input.directory,
            host: 'opencode',
            clientId,
            processAncestors,
            sessionId: sessionID,
          });
        } finally {
          client.close();
        }
      } catch (error) {
        if (!abort.signal.aborted)
          await log('error', 'Bassfish OpenCode session cleanup failed.', error);
      }
    };

    return {
      config: async (config: Record<string, unknown>) => {
        runtimeDataDir = configureOpenCodeMcp(config, input.directory, rawOptions);
        nativeIdentity = Promise.all([getClientId(runtimeDataDir), getAncestry()]).then(
          ([clientId, processAncestors]) => ({ clientId, processAncestors }),
        );
        for (const sessionID of sessions.keys()) void runPump(sessionID, runtimeDataDir);
      },
      'chat.message': async (
        hookInput: Record<string, unknown>,
        hookOutput: Record<string, unknown>,
      ) => {
        const sessionID = hookInput.sessionID;
        const parts = Array.isArray(hookOutput.parts) ? hookOutput.parts : [];
        if (typeof sessionID === 'string' && parts.some(part => record(part)?.synthetic !== true)) {
          const root = await rootSession(sessionID);
          ensureSession(root).idle = false;
        }
      },
      'tool.execute.before': async (
        hookInput: Record<string, unknown>,
        hookOutput: Record<string, unknown>,
      ) => {
        if (!isBassfishTool(hookInput.tool)) return;
        const sessionID = hookInput.sessionID;
        if (typeof sessionID !== 'string')
          throw new Error('OpenCode did not provide a session ID for a Bassfish tool call.');
        const root = await rootSession(sessionID);
        ensureSession(root);
        const args = record(hookOutput.args) ?? {};
        args[hostSessionRouteKey] = root;
        hookOutput.args = args;
      },
      event: async ({ event }: { event: unknown }) => {
        const value = record(event);
        const properties = record(value?.properties);
        const info = record(properties?.info);
        const sessionID =
          typeof properties?.sessionID === 'string'
            ? properties.sessionID
            : typeof info?.id === 'string'
              ? info.id
              : undefined;
        if (sessionID && (value?.type === 'session.created' || value?.type === 'session.updated'))
          parents.set(sessionID, typeof info?.parentID === 'string' ? info.parentID : undefined);
        if (!sessionID) return;
        if (value?.type === 'session.deleted') {
          if (!parents.get(sessionID)) await closeSession(sessionID);
          parents.delete(sessionID);
          return;
        }
        const state = sessions.get(sessionID);
        if (!state) return;
        if (value?.type === 'session.idle') state.idle = true;
        else if (value?.type === 'session.status')
          state.idle = record(properties?.status)?.type === 'idle';
        else return;
        schedule(sessionID);
      },
      dispose: async () => {
        abort.abort();
        for (const state of sessions.values()) {
          state.controller.abort();
          state.client?.close();
        }
        sessions.clear();
      },
    };
  };
}

export const BassfishPlugin = createBassfishPlugin();
export default { id: 'bassfish', server: BassfishPlugin };
