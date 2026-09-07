import { McpServer } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, StandardSchemaWithJSON, Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BassfishError } from './domain.js';
import { schemas, descriptions } from './api.js';
import type { ToolName } from './api.js';
import { connectDaemon, ensureDaemon } from './daemon.js';
import type { RpcClient } from './ipc.js';
import { cancelTaskParams, getTaskParams, hasTasksCapability, taskAck, taskResult, tasksExtensionId, toolResult, updateTaskParams, wireTask, wireTaskNotification } from './tasks.js';
import { packageVersion } from './config.js';

export class TaskAwareStdioTransport implements Transport {
  onclose?: () => void; onerror?: (error: Error) => void; onmessage?: (message: JSONRPCMessage) => void;
  private taskIds = new Set<string>(); private subscriptionMeta: Record<string,unknown> | undefined;
  constructor(private readonly subscribe: (ids: string[]) => void, private readonly inner: Transport = new StdioServerTransport()) {}
  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.(); this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = message => {
      const raw = message as unknown as Record<string,unknown>;
      if (raw.method === 'subscriptions/listen') {
        const clone = structuredClone(raw) as Record<string,unknown>; const params = clone.params as Record<string,unknown> | undefined;
        const notifications = params?.notifications as Record<string,unknown> | undefined; const ids = Array.isArray(notifications?.taskIds) ? notifications.taskIds.filter(value => typeof value === 'string') as string[] : [];
        if (ids.length) {
          const meta = params?._meta as Record<string,unknown> | undefined; const envelope = meta?.['io.modelcontextprotocol/clientCapabilities'] ? { clientCapabilities: meta['io.modelcontextprotocol/clientCapabilities'] } : undefined;
          if (!hasTasksCapability(envelope)) { void this.inner.send({ jsonrpc: '2.0', id: raw.id as string, error: { code: -32021, message: 'Missing required client capability', data: { requiredCapabilities: { extensions: { [tasksExtensionId]: {} } } } } } as JSONRPCMessage); return; }
          this.taskIds = new Set(ids); delete notifications!.taskIds; this.subscribe(ids);
        }
        this.onmessage?.(clone as unknown as JSONRPCMessage); return;
      }
      this.onmessage?.(message);
    };
    await this.inner.start();
  }
  async close(): Promise<void> { await this.inner.close(); }
  async send(message: JSONRPCMessage): Promise<void> {
    const raw = structuredClone(message) as unknown as Record<string,unknown>;
    if (raw.method === 'notifications/subscriptions/acknowledged' && this.taskIds.size) {
      const params = raw.params as Record<string,unknown>; const notifications = (params.notifications ??= {}) as Record<string,unknown>; notifications.taskIds = [...this.taskIds];
      this.subscriptionMeta = params._meta as Record<string,unknown> | undefined;
    }
    if (raw.method === 'notifications/tasks' && this.subscriptionMeta) {
      const params = raw.params as Record<string,unknown>; params._meta = { ...(params._meta as object | undefined), ...this.subscriptionMeta };
    }
    const result = raw.result as Record<string,unknown> | undefined; const structured = result?.structuredContent as Record<string,unknown> | undefined;
    if (structured?.__bassfishTask) raw.result = { ...wireTask(structured.__bassfishTask as Record<string,unknown>,'task'), ...(result?._meta ? { _meta: result._meta } : {}) };
    await this.inner.send(raw as unknown as JSONRPCMessage);
  }
}

/** Stdio adapter: MCP validation and transport around the shared Bassfish daemon. */
export async function runMcp(workspace: string, dataDir: string, binary: string, name?: string): Promise<void> {
  let client: RpcClient | undefined;
  let connecting: Promise<RpcClient> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let stopped = false;
  let preferredName = name;
  async function connection(): Promise<RpcClient> {
    if (client && !client.socket.destroyed) return client;
    return connecting ??= (async () => {
      await ensureDaemon(dataDir, binary);
      const opened = await connectDaemon(dataDir);
      try {
        const result = await opened.call<{ session: { name: string } }>('openSession', { workspace, name: preferredName });
        if (stopped) { await opened.call('closeSession'); throw new BassfishError('CANCELLED', 'Adapter stopped during startup.'); }
        preferredName = result.session.name; client = opened;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          void opened.call('heartbeatSession').catch(() => { if (heartbeat) clearInterval(heartbeat); opened.socket.destroy(); });
        }, 5000); heartbeat.unref();
        return opened;
      } catch (error) { opened.close(); throw error; }
    })().finally(() => { connecting = undefined; });
  }
  let protocolServer: McpServer | undefined; const watchers = new Map<string,AbortController>();
  const watchTasks = (ids: string[]) => {
    for (const taskId of ids) if (!watchers.has(taskId)) {
      const controller = new AbortController(); watchers.set(taskId,controller);
      void (async () => {
        let after = 0;
        while (!controller.signal.aborted) {
          try {
            const backend = await connection(); const task = await backend.call<Record<string,unknown>>('waitTask',{ taskId, updatedAfter: after, timeoutMs: 20_000 },controller.signal);
            const updated = Date.parse(String(task.lastUpdatedAt)); if (updated > after) {
              after = updated; await protocolServer?.server.notification({ method: 'notifications/tasks', params: wireTaskNotification(task) } as never);
            }
            if (['completed','failed','cancelled'].includes(String(task.status))) break;
          } catch (error) { if (!controller.signal.aborted && error instanceof BassfishError && error.code !== 'TASK_NOT_FOUND') continue; break; }
        }
        watchers.delete(taskId);
      })();
    }
  };
  const taskTransport = new TaskAwareStdioTransport(watchTasks);
  const transport = await serveStdio(() => {
    const server = new McpServer({ name: 'bassfish', version: packageVersion }, { capabilities: { tools: {}, extensions: { [tasksExtensionId]: {} } } as never }); protocolServer = server;
    server.server.setRequestHandler('tasks/get',{ params: getTaskParams, result: taskResult },async params => {
      const backend = await connection(); return wireTask(await backend.call<Record<string,unknown>>('getTask',{ taskId: params.taskId }),'complete') as never;
    });
    server.server.setRequestHandler('tasks/cancel',{ params: cancelTaskParams, result: taskAck },async params => {
      const backend = await connection(); await backend.call('cancelTask',{ taskId: params.taskId }); return { resultType: 'complete' as const };
    });
    server.server.setRequestHandler('tasks/update',{ params: updateTaskParams, result: taskAck },async params => {
      const backend = await connection(); await backend.call('peekTask',{ taskId: params.taskId }); throw new BassfishError('INVALID_TASK_STATE','Bassfish floor tasks never request client input.');
    });
    for (const name of Object.keys(schemas) as ToolName[]) {
      const inputSchema: StandardSchemaWithJSON = schemas[name];
      server.registerTool(name, { description: descriptions[name], inputSchema,
        annotations: { readOnlyHint: ['getSession','listAgents','listThreads','listNotes','searchNotes','getFloorRequest','waitForFloor','readFloor','listHistory','readRevision','diffRevision','previewRestore','getNoteOutline','findInNote','inspectSnapshot','searchProjectNotes','searchProjectNoteHistory','listSnapshotHistory','previewSnapshotRestore'].includes(name),
          destructiveHint: ['commitFloor','restoreRevision','restoreSnapshot'].includes(name), idempotentHint: false, openWorldHint: false } }, async (args, context) => {
        try {
          const backend = await connection();
          const taskCapable = name === 'requestFloor' && hasTasksCapability(context.mcpReq.envelope);
          const data = await backend.call('callTool', { name, args, taskCapable }, context.mcpReq.signal);
          if (name === 'setAgentName') preferredName = (data as { name: string }).name;
          if (data && typeof data === 'object' && 'task' in data) return { content: [], structuredContent: { __bassfishTask: (data as { task: unknown }).task } };
          return toolResult(data) as never;
        } catch (error) {
          const failure = error instanceof BassfishError ? error : new BassfishError('BACKEND_UNAVAILABLE', 'Bassfish could not complete the request. No operation was retried.');
          const output = { error: { code: failure.code, message: failure.message } };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
        }
      });
    }
    return server;
  }, { transport: taskTransport });
  const stop = async () => {
    if (stopped) return; stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    for (const watcher of watchers.values()) watcher.abort(); watchers.clear();
    try { if (client && !client.socket.destroyed) await client.call('closeSession'); }
    finally { client?.close(); await transport.close(); }
  };
  const shutdown = () => { void stop().catch(() => { client?.socket.destroy(); }); };
  process.stdin.once('end', shutdown); process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
