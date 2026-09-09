import { McpServer } from '@modelcontextprotocol/server';
import type {
  JSONRPCMessage,
  StandardSchemaWithJSON,
  Transport,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BassfishError } from './domain.js';
import { mcpDescriptions, mcpSchemas } from './mcp-api.js';
import type { McpToolName } from './mcp-api.js';
import { presentMentionTask, presentNotifications, presentTask } from './mcp-presenters.js';
import { connectDaemon, ensureDaemon } from './daemon.js';
import type { RpcClient } from './ipc.js';
import {
  cancelTaskParams,
  getTaskParams,
  hasTasksCapability,
  taskAck,
  taskResult,
  tasksExtensionId,
  toolResult,
  updateTaskParams,
  wireTask,
  wireTaskNotification,
} from './tasks.js';
import { packageVersion } from './config.js';
import { MentionTaskRegistry } from './mention-tasks.js';
import { formatDeliveryContext, type DeliveryBatch } from './notification-delivery.js';
import { z } from 'zod';
import {
  processAncestry,
  readOrCreateClaudeClientId,
  readOrCreateOpenCodeClientId,
} from './agents/claude-native.js';

const hostSessionRouteKey = '__bassfishHostSessionId';
const hostSessionIdSchema = z.string().min(1).max(200);
function routedToolSchema(schema: z.ZodType): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      validate: value => {
        const raw =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
        const route = raw?.[hostSessionRouteKey];
        const clean = raw ? { ...raw } : value;
        if (raw) delete (clean as Record<string, unknown>)[hostSessionRouteKey];
        const restoreRoute = (result: Awaited<ReturnType<typeof standard.validate>>) => {
          if (result.issues || route === undefined) return result;
          return {
            value: {
              ...(result.value as Record<string, unknown>),
              [hostSessionRouteKey]: route,
            },
          };
        };
        const result = standard.validate(clean);
        return result instanceof Promise ? result.then(restoreRoute) : restoreRoute(result);
      },
    },
  } as StandardSchemaWithJSON;
}
function routedHostSessionId(args: unknown): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[hostSessionRouteKey];
  if (value === undefined) return undefined;
  const parsed = hostSessionIdSchema.safeParse(value);
  if (!parsed.success)
    throw new BassfishError('INVALID_ARGUMENT', 'The host session route is invalid.');
  return parsed.data;
}

export class TaskAwareStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private taskIds = new Set<string>();
  private subscriptionMeta: Record<string, unknown> | undefined;
  constructor(
    private readonly subscribe: (ids: string[]) => void,
    private readonly inner: Transport = new StdioServerTransport(),
  ) {}
  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = message => {
      const raw = message as unknown as Record<string, unknown>;
      if (raw.method === 'subscriptions/listen') {
        const clone = structuredClone(raw) as Record<string, unknown>;
        const params = clone.params as Record<string, unknown> | undefined;
        const notifications = params?.notifications as Record<string, unknown> | undefined;
        const ids = Array.isArray(notifications?.taskIds)
          ? (notifications.taskIds.filter(value => typeof value === 'string') as string[])
          : [];
        if (ids.length) {
          const meta = params?._meta as Record<string, unknown> | undefined;
          const envelope = meta?.['io.modelcontextprotocol/clientCapabilities']
            ? { clientCapabilities: meta['io.modelcontextprotocol/clientCapabilities'] }
            : undefined;
          if (!hasTasksCapability(envelope)) {
            void this.inner.send({
              jsonrpc: '2.0',
              id: raw.id as string,
              error: {
                code: -32021,
                message: 'Missing required client capability',
                data: { requiredCapabilities: { extensions: { [tasksExtensionId]: {} } } },
              },
            } as JSONRPCMessage);
            return;
          }
          this.taskIds = new Set(ids);
          delete notifications!.taskIds;
          this.subscribe(ids);
        }
        this.onmessage?.(clone as unknown as JSONRPCMessage);
        return;
      }
      this.onmessage?.(message);
    };
    await this.inner.start();
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const raw = structuredClone(message) as unknown as Record<string, unknown>;
    if (raw.method === 'notifications/subscriptions/acknowledged' && this.taskIds.size) {
      const params = raw.params as Record<string, unknown>;
      const notifications = (params.notifications ??= {}) as Record<string, unknown>;
      notifications.taskIds = [...this.taskIds];
      this.subscriptionMeta = params._meta as Record<string, unknown> | undefined;
    }
    if (raw.method === 'notifications/tasks' && this.subscriptionMeta) {
      const params = raw.params as Record<string, unknown>;
      params._meta = { ...(params._meta as object | undefined), ...this.subscriptionMeta };
    }
    const result = raw.result as Record<string, unknown> | undefined;
    const structured = result?.structuredContent as Record<string, unknown> | undefined;
    if (structured?.__bassfishTask)
      raw.result = {
        ...wireTask(structured.__bassfishTask as Record<string, unknown>, 'task'),
        ...(result?._meta ? { _meta: result._meta } : {}),
      };
    await this.inner.send(raw as unknown as JSONRPCMessage);
  }
}

/** Stdio adapter: MCP validation and transport around the shared Bassfish daemon. */
export async function runMcp(
  workspace: string,
  dataDir: string,
  binary: string,
  name?: string,
): Promise<void> {
  let client: RpcClient | undefined;
  let connecting: Promise<RpcClient> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let stopped = false;
  let preferredName = name;
  let defaultHostSessionId: string | undefined;
  const nativeClaude = process.env.BASSFISH_CLAUDE_NATIVE === '1';
  const nativeCodex = process.env.BASSFISH_CODEX_NATIVE === '1';
  const nativeOpenCode = process.env.BASSFISH_OPENCODE_NATIVE === '1';
  if ([nativeClaude, nativeCodex, nativeOpenCode].filter(Boolean).length > 1)
    throw new BassfishError('INVALID_NATIVE_HOST', 'Only one native host may own an MCP adapter.');
  const nativeHost = nativeClaude
    ? ('claude' as const)
    : nativeCodex
      ? ('codex' as const)
      : nativeOpenCode
        ? ('opencode' as const)
        : undefined;
  async function connection(): Promise<RpcClient> {
    if (client && !client.socket.destroyed) return client;
    return (connecting ??= (async () => {
      await ensureDaemon(dataDir, binary);
      const opened = await connectDaemon(dataDir);
      try {
        if (
          [
            process.env.BASSFISH_RUN_ID,
            process.env.BASSFISH_DELIVERY_TOKEN,
            process.env.BASSFISH_AGENT_HOST,
            process.env.BASSFISH_OPENCODE_DELIVERY_URL,
            process.env.BASSFISH_OPENCODE_DELIVERY_TOKEN,
          ].some(Boolean)
        ) {
          throw new BassfishError(
            'MANAGED_RUN_REMOVED',
            'The Bassfish-managed OpenCode runner was removed; install @bassfish/cli with `opencode plugin @bassfish/cli --global`.',
          );
        }
        let native: Record<string, unknown> | undefined;
        const configuredName = preferredName ?? process.env.BASSFISH_AGENT_NAME;
        if (nativeHost && !configuredName) {
          if (nativeHost === 'codex') native = { host: nativeHost };
          else {
            const clientId =
              nativeHost === 'claude'
                ? await readOrCreateClaudeClientId(process.env.BASSFISH_CLAUDE_PLUGIN_DATA ?? '')
                : await readOrCreateOpenCodeClientId(dataDir);
            native = {
              host: nativeHost,
              clientId,
              processAncestors: await processAncestry(),
            };
          }
        }
        const result = await opened.call<{ session: { name: string } | null }>('openSession', {
          workspace,
          name: configuredName,
          ...(native ? { native } : {}),
          ...(native && defaultHostSessionId ? { hostSessionId: defaultHostSessionId } : {}),
        });
        if (stopped) {
          await opened.call('closeSession');
          throw new BassfishError('CANCELLED', 'Adapter stopped during startup.');
        }
        if (result.session && !native) preferredName = result.session.name;
        client = opened;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          void opened.call('heartbeatSession').catch(() => {
            if (heartbeat) clearInterval(heartbeat);
            opened.socket.destroy();
          });
        }, 5000);
        heartbeat.unref();
        return opened;
      } catch (error) {
        opened.close();
        throw error;
      }
    })().finally(() => {
      connecting = undefined;
    }));
  }
  const taskRoutes = new Map<string, string | undefined>();
  const mentionTasks = new MentionTaskRegistry(async (hostSessionId, signal) => {
    while (!signal.aborted) {
      const backend = await connection();
      const batch = await backend.call<{
        notifications: Record<string, unknown>[];
        moreAvailable: boolean;
      }>('waitWork', { timeoutMs: 20_000, ...(hostSessionId ? { hostSessionId } : {}) }, signal);
      if (batch.notifications.length > 0) return batch;
    }
    throw new BassfishError('CANCELLED', 'Mention listening was cancelled.');
  });
  let protocolServer: McpServer | undefined;
  const watchers = new Map<string, AbortController>();
  const watchTasks = (ids: string[]) => {
    for (const taskId of ids)
      if (!watchers.has(taskId)) {
        const controller = new AbortController();
        watchers.set(taskId, controller);
        void (async () => {
          let after = 0;
          while (!controller.signal.aborted) {
            try {
              const rawTask = mentionTasks.has(taskId)
                ? await mentionTasks.waitForUpdate(taskId, after, 20_000, controller.signal)
                : await (
                    await connection()
                  ).call<Record<string, unknown>>(
                    'waitTask',
                    {
                      taskId,
                      updatedAfter: after,
                      timeoutMs: 20_000,
                      ...(taskRoutes.get(taskId) ? { hostSessionId: taskRoutes.get(taskId) } : {}),
                    },
                    controller.signal,
                  );
              const task = mentionTasks.has(taskId)
                ? presentMentionTask(rawTask)
                : presentTask(rawTask);
              const updated = Date.parse(String(task.lastUpdatedAt));
              if (updated > after) {
                after = updated;
                await protocolServer?.server.notification({
                  method: 'notifications/tasks',
                  params: wireTaskNotification(task),
                } as never);
              }
              if (['completed', 'failed', 'cancelled'].includes(String(task.status))) break;
            } catch (error) {
              if (
                !controller.signal.aborted &&
                error instanceof BassfishError &&
                error.code !== 'TASK_NOT_FOUND'
              )
                continue;
              break;
            }
          }
          watchers.delete(taskId);
        })();
      }
  };
  const taskTransport = new TaskAwareStdioTransport(watchTasks);
  // Presence belongs to the MCP process lifetime, not to the first tool call.
  // Register before exposing the protocol server so peers can discover this
  // identity even when the host has only initialized MCP or listed tools.
  await connection();
  const transport = await serveStdio(
    () => {
      const server = new McpServer(
        { name: 'bassfish', version: packageVersion },
        { capabilities: { tools: {}, extensions: { [tasksExtensionId]: {} } } as never },
      );
      protocolServer = server;
      server.server.setRequestHandler(
        'tasks/get',
        { params: getTaskParams, result: taskResult },
        async params => {
          if (mentionTasks.has(params.taskId))
            return wireTask(
              presentMentionTask(mentionTasks.get(params.taskId)),
              'complete',
            ) as never;
          const backend = await connection();
          const hostSessionId = taskRoutes.get(params.taskId);
          return wireTask(
            presentTask(
              await backend.call<Record<string, unknown>>('getTask', {
                taskId: params.taskId,
                ...(hostSessionId ? { hostSessionId } : {}),
              }),
            ),
            'complete',
          ) as never;
        },
      );
      server.server.setRequestHandler(
        'tasks/cancel',
        { params: cancelTaskParams, result: taskAck },
        async params => {
          if (mentionTasks.has(params.taskId)) {
            mentionTasks.cancel(params.taskId);
            return { resultType: 'complete' as const };
          }
          const backend = await connection();
          const hostSessionId = taskRoutes.get(params.taskId);
          await backend.call('cancelTask', {
            taskId: params.taskId,
            ...(hostSessionId ? { hostSessionId } : {}),
          });
          return { resultType: 'complete' as const };
        },
      );
      server.server.setRequestHandler(
        'tasks/update',
        { params: updateTaskParams, result: taskAck },
        async params => {
          if (mentionTasks.has(params.taskId))
            throw new BassfishError(
              'INVALID_TASK_STATE',
              'Bassfish mention tasks never request client input.',
            );
          const backend = await connection();
          const hostSessionId = taskRoutes.get(params.taskId);
          await backend.call('peekTask', {
            taskId: params.taskId,
            ...(hostSessionId ? { hostSessionId } : {}),
          });
          throw new BassfishError(
            'INVALID_TASK_STATE',
            'Bassfish turn tasks never request client input.',
          );
        },
      );
      for (const name of Object.keys(mcpSchemas) as McpToolName[]) {
        const inputSchema = routedToolSchema(mcpSchemas[name]);
        server.registerTool(
          name,
          {
            description: mcpDescriptions[name],
            inputSchema,
            annotations: {
              readOnlyHint: [
                'bindHostSession',
                'getContext',
                'waitForWork',
                'findResources',
                'readTurn',
              ].includes(name),
              destructiveHint: false,
              idempotentHint: [
                'bindHostSession',
                'getContext',
                'findResources',
                'readTurn',
                'waitForWork',
              ].includes(name),
              openWorldHint: false,
            },
          },
          async (args, context) => {
            try {
              const backend = await connection();
              const routedSessionId = routedHostSessionId(args);
              const publicArgs = { ...(args as Record<string, unknown>) };
              delete publicArgs[hostSessionRouteKey];
              if (routedSessionId && nativeHost !== 'opencode')
                throw new BassfishError(
                  'HOST_SESSION_UNAVAILABLE',
                  'Per-call host session routing is only available to the OpenCode plugin.',
                );
              if (name === 'bindHostSession') {
                if (!nativeHost || nativeHost === 'opencode')
                  throw new BassfishError(
                    'HOST_SESSION_UNAVAILABLE',
                    'This adapter does not support default host session binding.',
                  );
                const sessionId = publicArgs.sessionId as string;
                const data = await backend.call('bindHostSession', { sessionId });
                defaultHostSessionId = sessionId;
                return toolResult(data) as never;
              }
              if (name === 'deliverHostNotifications') {
                if (!nativeHost || nativeHost === 'opencode')
                  throw new BassfishError(
                    'HOST_SESSION_UNAVAILABLE',
                    'This adapter does not support notification delivery hooks.',
                  );
                const sessionId = publicArgs.sessionId as string;
                const phase = publicArgs.phase as 'prompt' | 'active' | 'idle';
                await backend.call('bindHostSession', { sessionId });
                defaultHostSessionId = sessionId;
                const batch = await backend.call<DeliveryBatch>('takeHostDelivery', {
                  sessionId,
                  phase,
                });
                if (batch.count === 0) return toolResult({}) as never;
                const message = formatDeliveryContext(batch);
                if (phase === 'idle')
                  return toolResult({ decision: 'block', reason: message }) as never;
                const hookEventName =
                  phase === 'prompt'
                    ? 'UserPromptSubmit'
                    : nativeHost === 'claude'
                      ? 'PostToolBatch'
                      : 'PostToolUse';
                return toolResult({
                  hookSpecificOutput: { hookEventName, additionalContext: message },
                }) as never;
              }
              if (name === 'waitForWork') {
                if (!hasTasksCapability(context.mcpReq.envelope))
                  throw new BassfishError(
                    'TASKS_REQUIRED',
                    'waitForWork requires the MCP Tasks extension.',
                  );
                const pending = await backend.call<{
                  notifications: Record<string, unknown>[];
                  moreAvailable: boolean;
                }>(
                  'waitWork',
                  {
                    timeoutMs: 0,
                    ...(routedSessionId ? { hostSessionId: routedSessionId } : {}),
                  },
                  context.mcpReq.signal,
                );
                if (pending.notifications.length > 0)
                  return toolResult(presentNotifications(pending)) as never;
                return {
                  content: [],
                  structuredContent: { __bassfishTask: mentionTasks.create(routedSessionId) },
                };
              }
              const taskCapable =
                name === 'acquireTurn' && hasTasksCapability(context.mcpReq.envelope);
              const data = await backend.call(
                'callMcpTool',
                {
                  name,
                  args: publicArgs,
                  taskCapable,
                  ...(routedSessionId ? { hostSessionId: routedSessionId } : {}),
                },
                context.mcpReq.signal,
              );
              if (name === 'setAgentName' && !nativeHost)
                preferredName = (data as { agentName: string }).agentName;
              if (data && typeof data === 'object' && 'task' in data) {
                const task = (data as { task: { taskId?: string } }).task;
                if (task.taskId) taskRoutes.set(task.taskId, routedSessionId);
                return {
                  content: [],
                  structuredContent: { __bassfishTask: task },
                };
              }
              return toolResult(data) as never;
            } catch (error) {
              const failure =
                error instanceof BassfishError
                  ? error
                  : new BassfishError(
                      'BACKEND_UNAVAILABLE',
                      'Bassfish could not complete the request. No operation was retried.',
                    );
              const output = { error: { code: failure.code, message: failure.message } };
              return { isError: true, content: [], structuredContent: output };
            }
          },
        );
      }
      return server;
    },
    { transport: taskTransport },
  );
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    mentionTasks.stop();
    for (const watcher of watchers.values()) watcher.abort();
    watchers.clear();
    try {
      if (client && !client.socket.destroyed) await client.call('closeSession');
    } finally {
      client?.close();
      await transport.close();
    }
  };
  const shutdown = () => {
    void stop().catch(() => {
      client?.socket.destroy();
    });
  };
  process.stdin.once('end', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (process.stdin.readableEnded) await stop();
}
