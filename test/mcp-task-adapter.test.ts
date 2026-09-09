import test from 'node:test';
import assert from 'node:assert/strict';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { TaskAwareStdioTransport } from '../src/mcp.js';
import {
  createTaskResult,
  tasksExtensionId,
  wireTask,
  wireTaskNotification,
} from '../src/tasks.js';

class MemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sent: JSONRPCMessage[] = [];
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
  receive(message: Record<string, unknown>): void {
    this.onmessage?.(message as unknown as JSONRPCMessage);
  }
}

test('the Tasks transport emits the official CreateTaskResult instead of a tool sentinel', async () => {
  const inner = new MemoryTransport();
  const transport = new TaskAwareStdioTransport(() => {}, inner);
  await transport.start();
  await transport.send({
    jsonrpc: '2.0',
    id: 7,
    result: {
      content: [],
      structuredContent: {
        __bassfishTask: {
          taskId: 'task-1',
          status: 'working',
          statusMessage: 'Queued',
          createdAt: '2026-09-06T00:00:00.000Z',
          lastUpdatedAt: '2026-09-06T00:00:00.000Z',
          ttlMs: 60_000,
          pollIntervalMs: 250,
        },
      },
    },
  } as JSONRPCMessage);
  const result = (inner.sent[0] as unknown as { result: unknown }).result;
  assert.equal(createTaskResult.parse(result).resultType, 'task');
  assert.equal(JSON.stringify(result).includes('__bassfishTask'), false);
});

test('task subscriptions require the negotiated extension and round-trip taskIds', async () => {
  const inner = new MemoryTransport();
  let subscribed: string[] = [];
  const transport = new TaskAwareStdioTransport(ids => {
    subscribed = ids;
  }, inner);
  await transport.start();
  transport.setProtocolVersion('2026-07-28');
  let forwarded: Record<string, unknown> | undefined;
  transport.onmessage = message => {
    forwarded = message as unknown as Record<string, unknown>;
  };
  inner.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'subscriptions/listen',
    params: { notifications: { taskIds: ['task-1'] } },
  });
  assert.equal(forwarded, undefined);
  assert.equal((inner.sent[0] as unknown as { error: { code: number } }).error.code, -32021);
  inner.receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'subscriptions/listen',
    params: {
      notifications: { taskIds: ['task-1'] },
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': { extensions: { [tasksExtensionId]: {} } },
      },
    },
  });
  assert.deepEqual(subscribed, ['task-1']);
  assert.deepEqual(
    ((forwarded!.params as Record<string, unknown>).notifications as Record<string, unknown>)
      .taskIds,
    undefined,
  );
  await transport.send({
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      notifications: {},
      _meta: { 'io.modelcontextprotocol/subscriptionId': 2 },
    },
  } as JSONRPCMessage);
  assert.deepEqual(
    (
      (inner.sent.at(-1) as unknown as { params: Record<string, unknown> }).params
        .notifications as Record<string, unknown>
    ).taskIds,
    ['task-1'],
  );
  inner.receive({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 2 },
  });
  assert.deepEqual(subscribed, []);
});

test('task notifications are routed only to matching live subscriptions', async () => {
  const inner = new MemoryTransport();
  const transport = new TaskAwareStdioTransport(() => {}, inner);
  await transport.start();
  transport.setProtocolVersion('2026-07-28');
  transport.onmessage = () => {};
  inner.receive({
    jsonrpc: '2.0',
    id: 'listen-a',
    method: 'subscriptions/listen',
    params: {
      notifications: { taskIds: ['task-a'] },
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': { extensions: { [tasksExtensionId]: {} } },
      },
    },
  });
  await transport.send({
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      notifications: {},
      _meta: { 'io.modelcontextprotocol/subscriptionId': 'listen-a' },
    },
  } as JSONRPCMessage);
  const before = inner.sent.length;
  await transport.send({
    jsonrpc: '2.0',
    method: 'notifications/tasks',
    params: { taskId: 'task-b', status: 'working' },
  } as JSONRPCMessage);
  assert.equal(inner.sent.length, before);
  await transport.send({
    jsonrpc: '2.0',
    method: 'notifications/tasks',
    params: { taskId: 'task-a', status: 'working' },
  } as JSONRPCMessage);
  assert.equal(inner.sent.length, before + 1);
  assert.equal(
    (inner.sent.at(-1) as unknown as { params: { _meta: Record<string, unknown> } }).params._meta[
      'io.modelcontextprotocol/subscriptionId'
    ],
    'listen-a',
  );
});

test('task notifications carry DetailedTask directly without a result discriminator', () => {
  const notification = wireTaskNotification({
    taskId: 'task-1',
    status: 'working',
    createdAt: '2026-09-06T00:00:00.000Z',
    lastUpdatedAt: '2026-09-06T00:00:00.000Z',
    ttlMs: 1,
  });
  assert.equal(Object.hasOwn(notification, 'resultType'), false);
});

test('completed task results use structured content without duplicate text JSON', () => {
  const task = wireTask(
    {
      taskId: 'task-1',
      status: 'completed',
      createdAt: '2026-09-06T00:00:00.000Z',
      lastUpdatedAt: '2026-09-06T00:00:01.000Z',
      ttlMs: 1,
      result: { state: 'claimed', requestToken: 'request', turnToken: 'turn' },
    },
    'complete',
  );
  const result = task.result as { content: unknown[]; structuredContent: Record<string, unknown> };
  assert.deepEqual(result.content, []);
  assert.equal(result.structuredContent.turnToken, 'turn');
});
