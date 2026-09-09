import assert from 'node:assert/strict';
import test from 'node:test';
import bassfishPlugin, {
  configureOpenCodeMcp,
  createBassfishPlugin,
  formatOpenCodeDeliveryPrompt,
} from '../src/opencode-plugin.js';

test('OpenCode plugin augments an existing local Bassfish MCP without replacing user settings', () => {
  const config: Record<string, unknown> = {
    mcp: {
      bassfish: {
        type: 'local',
        command: ['/opt/bin/bassfish', 'mcp', '--workspace', '/repo'],
        cwd: '/repo',
        timeout: 12_000,
        environment: { EXISTING: 'kept', BASSFISH_DATA_DIR: '/private/data' },
      },
      other: { type: 'remote', url: 'https://example.test' },
    },
  };
  const dataDir = configureOpenCodeMcp(config, '/repo');
  const mcp = config.mcp as Record<string, Record<string, unknown>>;
  const bassfish = mcp.bassfish!;
  assert.equal(dataDir, '/private/data');
  assert.equal(bassfish.cwd, '/repo');
  assert.equal(bassfish.timeout, 12_000);
  assert.deepEqual(bassfish.command, ['/opt/bin/bassfish', 'mcp', '--workspace', '/repo']);
  assert.deepEqual(bassfish.environment, {
    EXISTING: 'kept',
    BASSFISH_DATA_DIR: '/private/data',
    BASSFISH_OPENCODE_NATIVE: '1',
  });
  assert.equal(mcp.other!.url, 'https://example.test');
});

test('OpenCode plugin creates its MCP entry with native delivery enabled', () => {
  const config: Record<string, unknown> = {};
  configureOpenCodeMcp(config, '/repo');
  const bassfish = (config.mcp as Record<string, Record<string, unknown>>).bassfish!;
  assert.deepEqual(bassfish.command, ['bassfish', 'mcp', '--workspace', '/repo']);
  assert.deepEqual(bassfish.environment, {
    BASSFISH_OPENCODE_NATIVE: '1',
  });
  assert.throws(
    () =>
      configureOpenCodeMcp(
        { mcp: { bassfish: { type: 'remote', url: 'https://example.test' } } },
        '/repo',
      ),
    /non-local/,
  );
});

test('OpenCode package entry exports the native plugin server', () => {
  assert.equal(bassfishPlugin.id, 'bassfish');
  assert.equal(typeof bassfishPlugin.server, 'function');
  const prompt = formatOpenCodeDeliveryPrompt({
    kind: 'actionable',
    count: 1,
    notificationIds: ['n-1'],
    threadIds: ['t-1'],
    ticketIds: [],
    senders: ['WildSeal'],
    reasons: ['direct_mention'],
    notifications: [
      {
        notificationId: 'n-1',
        resourceType: 'thread',
        resourceId: 't-1',
        threadId: 't-1',
        sender: 'WildSeal',
        reasons: ['direct_mention'],
        content: {
          kind: 'thread_message',
          threadTitle: 'Review',
          body: 'Please review this change.',
          retracted: false,
        },
      },
    ],
  });
  assert.match(prompt, /n-1/);
  assert.match(prompt, /t-1/);
  assert.match(prompt, /WildSeal/);
  assert.match(prompt, /Please review this change/);
});

test('native OpenCode actionable delivery is inserted into a busy top-level session', async () => {
  const prompts: Array<Record<string, unknown>> = [];
  let calls = 0;
  const statuses: Record<string, { type: string }> = { root: { type: 'busy' } };
  const pluginFactory = createBassfishPlugin({
    clientId: async () => '00000000-0000-4000-8000-000000000555',
    ancestry: async () => [300, 200, 1],
    delay: async (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    connect: async () => ({
      call: async <T>(_method: string, _params?: unknown, signal?: AbortSignal): Promise<T> => {
        if (calls++ === 0)
          return {
            kind: 'actionable',
            count: 1,
            notificationIds: ['direct-1'],
            threadIds: ['thread-1'],
            ticketIds: [],
            reasons: ['direct_mention'],
            senders: ['Alice'],
            notifications: [
              {
                notificationId: 'direct-1',
                resourceType: 'thread',
                resourceId: 'thread-1',
                threadId: 'thread-1',
                sender: 'Alice',
                reasons: ['direct_mention'],
                content: {
                  kind: 'thread_message',
                  threadTitle: 'Review',
                  body: '@Reviewer please check this.',
                  retracted: false,
                },
              },
            ],
          } as T;
        return new Promise<T>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      close: () => {},
    }),
  });
  const hooks = await pluginFactory({
    directory: '/repo',
    client: {
      session: {
        get: async () => ({ data: { id: 'root' } }),
        status: async () => ({ data: statuses }),
        prompt: async request => {
          prompts.push(request as Record<string, unknown>);
          return { data: {} };
        },
      },
      app: { log: async () => ({}) },
    },
  });
  try {
    await hooks.config({
      mcp: {
        bassfish: {
          type: 'local',
          command: ['bassfish', 'mcp'],
          environment: { BASSFISH_DATA_DIR: '/tmp/bassfish-test' },
        },
      },
    });
    await hooks['chat.message']({ sessionID: 'root' }, { parts: [{ type: 'text' }] });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompts.length, 1);
    assert.equal((prompts[0] as { body: { noReply?: boolean } }).body.noReply, true);
    assert.match(JSON.stringify(prompts[0]), /please check this/);
  } finally {
    await hooks.dispose();
  }
});

test('native OpenCode plugin routes each top-level session independently and waits for idle', async () => {
  const prompts: Array<Record<string, unknown>> = [];
  const delivered = new Set<string>();
  const pluginFactory = createBassfishPlugin({
    clientId: async () => '00000000-0000-4000-8000-000000000111',
    ancestry: async () => [300, 200, 1],
    delay: async (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    connect: async () => ({
      call: async <T>(_method: string, params?: unknown, signal?: AbortSignal): Promise<T> => {
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
        if (sessionId && !delivered.has(sessionId)) {
          delivered.add(sessionId);
          return {
            kind: 'activity',
            count: 1,
            notificationIds: [`n-${sessionId}`],
            threadIds: [`t-${sessionId}`],
            ticketIds: [],
            reasons: ['thread_activity'],
            senders: ['WildSeal'],
            notifications: [
              {
                notificationId: `n-${sessionId}`,
                resourceType: 'thread',
                resourceId: `t-${sessionId}`,
                threadId: `t-${sessionId}`,
                sender: 'WildSeal',
                reasons: ['thread_activity'],
                content: {
                  kind: 'thread_message',
                  threadTitle: 'Updates',
                  body: `update for ${sessionId}`,
                  retracted: false,
                },
              },
            ],
          } as T;
        }
        return new Promise<T>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      close: () => {},
    }),
  });
  const parent = new Map([
    ['root-1', undefined],
    ['child', 'root-1'],
    ['root-2', undefined],
  ] as Array<[string, string | undefined]>);
  const statuses: Record<string, { type: string }> = {
    'root-1': { type: 'idle' },
    child: { type: 'idle' },
    'root-2': { type: 'busy' },
  };
  const hooks = await pluginFactory({
    directory: '/repo',
    client: {
      session: {
        get: async (request: unknown) => {
          const id = (request as { path: { id: string } }).path.id;
          return { data: { id, ...(parent.get(id) ? { parentID: parent.get(id) } : {}) } };
        },
        status: async () => ({ data: statuses }),
        prompt: async (request: unknown) => {
          prompts.push(request as Record<string, unknown>);
          return { data: {} };
        },
      },
      app: { log: async () => ({}) },
    },
  });
  try {
    await hooks.config({
      mcp: {
        bassfish: {
          type: 'local',
          command: ['bassfish', 'mcp'],
          environment: { BASSFISH_DATA_DIR: '/tmp/bassfish-test' },
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    await hooks['chat.message'](
      { sessionID: 'root-1' },
      { parts: [{ type: 'text', text: 'human' }] },
    );
    await hooks['chat.message'](
      { sessionID: 'child' },
      { parts: [{ type: 'text', text: 'subagent' }] },
    );
    await hooks['chat.message'](
      { sessionID: 'root-2' },
      { parts: [{ type: 'text', text: 'another human' }] },
    );
    const childCall: Record<string, unknown> = { args: { query: 'kept' } };
    await hooks['tool.execute.before'](
      { sessionID: 'child', tool: 'mcp__bassfish__getContext' },
      childCall,
    );
    assert.deepEqual(childCall.args, {
      query: 'kept',
      __bassfishHostSessionId: 'root-1',
    });
    const unrelatedCall: Record<string, unknown> = { args: {} };
    await hooks['tool.execute.before'](
      { sessionID: 'root-2', tool: 'unrelated_tool' },
      unrelatedCall,
    );
    assert.deepEqual(unrelatedCall.args, {});

    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root-1' } } });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompts.length, 1);
    assert.deepEqual((prompts[0] as { path: unknown }).path, { id: 'root-1' });
    assert.match(JSON.stringify(prompts[0]), /n-root-1/);

    statuses['root-2'] = { type: 'idle' };
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root-2' } } });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompts.length, 2);
    assert.deepEqual((prompts[1] as { path: unknown }).path, { id: 'root-2' });
    assert.match(JSON.stringify(prompts[1]), /n-root-2/);
  } finally {
    await hooks.dispose();
  }
});
