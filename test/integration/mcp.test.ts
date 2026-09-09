import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, mkdtemp, rm, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectDaemon, ensureDaemon } from '../../src/daemon.js';
import { packageRoot, socketPath } from '../../src/config.js';
import { createTaskResult, tasksExtensionId } from '../../src/tasks.js';
import type { Turn } from '../support.js';
import { generatedAgentNames } from '../../src/agent-names.js';
const exec = promisify(execFile);
test(
  'two actual stdio MCP clients: eager shared daemon, FIFO, durable content, SIGKILL recovery and CLI parity',
  { timeout: 90000 },
  async t => {
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-mcp-'),
    );
    const data = join(dir, 'data'),
      repo = join(dir, 'repo');
    await exec('git', ['init', repo]);
    const clients: Client[] = [];
    t.after(async () => {
      await Promise.allSettled(clients.map(c => c.close()));
      try {
        const rpc = await connectDaemon(data);
        const health = await rpc.call<{
          pid: number;
        }>('getHealth');
        await rpc.call('stopDaemon');
        rpc.close();
        const until = performance.now() + 10000;
        while (performance.now() < until) {
          try {
            process.kill(health.pid, 0);
          } catch {
            break;
          }
          await delay(50);
        }
      } catch {
        /* Startup may have failed; no daemon to stop. */
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      BASSFISH_DATA_DIR: data,
    };
    async function client(name?: string, extraEnv: Record<string, string> = {}): Promise<Client> {
      const c = new Client({ name: 'bassfish-integration', version: '1.0.0' });
      clients.push(c);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          join(packageRoot, 'dist/cli.js'),
          'mcp',
          '--workspace',
          repo,
          ...(name ? ['--name', name] : []),
        ],
        env: { ...env, ...extraEnv },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
      await c.connect(transport);
      return c;
    }
    const [alice, bob, anonymous] = await Promise.all([client('Alice'), client('Bob'), client()]);
    assert.equal(
      Object.hasOwn(alice.getServerCapabilities()?.extensions ?? {}, tasksExtensionId),
      false,
    );
    assert.equal((await lstat(socketPath(data))).mode & 0o777, 0o600); // MCP startup eagerly registers presence.
    const listed = await alice.listTools();
    assert.equal(listed.tools.length, 13);
    assert.ok(
      Buffer.byteLength(
        JSON.stringify(
          listed.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      ) <=
        14 * 1024,
    );
    async function call<T>(
      c: Client,
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      const result = await c.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.deepEqual(result.content, []);
      return result.structuredContent as T;
    }
    type PublicTicket = {
      state: string;
      requestToken: string;
      position?: number;
    };
    type PublicTurn = {
      state: 'claimed';
      requestToken: string;
      turnToken: string;
      resource: {
        revision: string;
      };
      messages: {
        body: string;
        mentions?: {
          agents: string[];
          here: boolean;
        };
      }[];
    };
    const discovered = await call<{
      agentName: string;
      agents: {
        name: string;
        online: boolean;
      }[];
      pendingTurns: PublicTicket[] | null;
    }>(alice, 'getContext');
    assert.equal(discovered.agents.find(agent => agent.name === 'Bob')?.online, true); // Bob has made no Bassfish tool call.
    const anonymousSession = await call<{
      agentName: string;
    }>(anonymous, 'getContext');
    assert.ok(generatedAgentNames.includes(anonymousSession.agentName));
    const codex = await client(undefined, { BASSFISH_CODEX_NATIVE: '1' });
    const unbound = await codex.callTool({ name: 'getContext', arguments: {} });
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound.content), /HOST_SESSION_REQUIRED:/);
    assert.equal(
      (
        unbound.structuredContent as {
          error: {
            code: string;
          };
        }
      ).error.code,
      'HOST_SESSION_REQUIRED',
    );
    await call(codex, 'bindHostSession', { sessionId: 'codex-session-one' });
    const codexInitial = await call<{
      agentName: string;
    }>(codex, 'getContext');
    await call(codex, 'setAgentName', { name: 'DurableCodex' });
    await codex.close();
    const resumedCodex = await client(undefined, { BASSFISH_CODEX_NATIVE: '1' });
    await call(resumedCodex, 'bindHostSession', { sessionId: 'codex-session-one' });
    assert.equal(
      (
        await call<{
          agentName: string;
        }>(resumedCodex, 'getContext')
      ).agentName,
      'DurableCodex',
    );
    assert.ok(generatedAgentNames.includes(codexInitial.agentName));
    await resumedCodex.close();
    const opencode = await client(undefined, { BASSFISH_OPENCODE_NATIVE: '1' });
    const rootOne = { __bassfishHostSessionId: 'opencode-root-one' };
    const rootTwo = { __bassfishHostSessionId: 'opencode-root-two' };
    await call(opencode, 'setAgentName', { ...rootOne, name: 'OpenCodeOne' });
    const routedOne = await call<{
      agentName: string;
    }>(opencode, 'getContext', rootOne);
    const routedTwo = await call<{
      agentName: string;
    }>(opencode, 'getContext', rootTwo);
    assert.equal(routedOne.agentName, 'OpenCodeOne');
    assert.notEqual(routedTwo.agentName, routedOne.agentName);
    await opencode.close();
    const created = await call<{
      threadId: string;
    }>(alice, 'createResource', {
      resourceType: 'thread',
      title: 'MCP roundtrip',
      description: 'Protected content',
    });
    const fetched = await call<{
      resource: {
        descriptionPreview: string;
        state: string;
      };
    }>(bob, 'findResources', { resourceType: 'thread', threadId: created.threadId });
    assert.equal(fetched.resource.descriptionPreview, 'Protected content');
    assert.equal(fetched.resource.state, 'active');
    const turn = await call<PublicTurn>(alice, 'acquireTurn', {
      target: { type: 'thread', threadId: created.threadId },
    });
    const queued = await call<PublicTicket>(bob, 'acquireTurn', {
      target: { type: 'thread', threadId: created.threadId },
      timeoutMs: 0,
    });
    assert.equal(queued.state, 'queued');
    assert.ok(!JSON.stringify(queued).includes('Protected'));
    const denied = await bob.callTool({
      name: 'readTurn',
      arguments: { view: 'page', turnToken: turn.turnToken },
    });
    assert.equal(denied.isError, true);
    assert.ok(!JSON.stringify(denied).includes('Protected'));
    const waiter = call<PublicTurn>(bob, 'acquireTurn', {
      requestToken: queued.requestToken,
      timeoutMs: 3000,
    });
    await call(alice, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: {
        kind: 'appendMessage',
        body: '@Bob hello from real MCP',
        mentions: { agents: ['Bob'], here: false },
      },
    });
    const read = await waiter;
    assert.equal(read.state, 'claimed');
    const inbox = await call<{
      notifications: {
        notificationId: string;
        reasons: string[];
      }[];
    }>(bob, 'notifications', { action: 'list' });
    assert.deepEqual(inbox.notifications[0]!.reasons, ['direct_mention']);
    const unsupportedListener = await alice.callTool({ name: 'waitForWork', arguments: {} });
    assert.equal(unsupportedListener.isError, true);
    assert.equal(
      (
        unsupportedListener.structuredContent as {
          error: {
            code: string;
          };
        }
      ).error.code,
      'TASKS_REQUIRED',
    );
    assert.equal(read.messages[0]!.body, '@Bob hello from real MCP');
    assert.deepEqual(read.messages[0]!.mentions, {
      agents: ['Bob'],
      here: false,
      global: false,
    });
    await call(bob, 'notifications', {
      action: 'acknowledge',
      notificationIds: [inbox.notifications[0]!.notificationId],
    });
    const modern = new Client(
      { name: 'bassfish-tasks-integration', version: '1.0.0' },
      {
        capabilities: { extensions: { [tasksExtensionId]: {} } } as never,
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    clients.push(modern);
    const modernTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, 'dist/cli.js'), 'mcp', '--workspace', repo, '--name', 'Charlie'],
      env,
      stderr: 'pipe',
    });
    modernTransport.stderr?.on('data', () => {});
    await modern.connect(modernTransport);
    assert.equal(
      Object.hasOwn(modern.getServerCapabilities()?.extensions ?? {}, tasksExtensionId),
      true,
    );
    assert.match(modern.getInstructions() ?? '', /inspect the latest relevant discussions/);
    assert.ok((await modern.listTools()).tools.every(tool => tool.outputSchema?.type === 'object'));
    // The pinned SDK client does not yet decode this external extension's open
    // resultType, so its typed client rejects after receiving the valid task wire
    // result. The transport conformance test validates that complete shape.
    await assert.rejects(
      modern.request(
        { method: 'tools/call', params: { name: 'waitForWork', arguments: {} } } as never,
        createTaskResult,
      ),
      (error: unknown) =>
        (
          error as {
            code?: string;
            data?: {
              resultType?: string;
            };
          }
        ).code === 'UNSUPPORTED_RESULT_TYPE' &&
        (
          error as {
            data?: {
              resultType?: string;
            };
          }
        ).data?.resultType === 'task',
    );
    await assert.rejects(
      modern.request(
        {
          method: 'tools/call',
          params: {
            name: 'acquireTurn',
            arguments: { target: { type: 'thread', threadId: created.threadId } },
          },
        } as never,
        createTaskResult,
      ),
      (error: unknown) =>
        (
          error as {
            code?: string;
            data?: {
              resultType?: string;
            };
          }
        ).code === 'UNSUPPORTED_RESULT_TYPE' &&
        (
          error as {
            data?: {
              resultType?: string;
            };
          }
        ).data?.resultType === 'task',
    );
    await modern.close();
    await call(bob, 'releaseTurn', { turnToken: read.turnToken });
    const crashHolder = await call<PublicTurn>(bob, 'acquireTurn', {
      target: { type: 'thread', threadId: created.threadId },
    });
    const pending = await call<PublicTicket>(alice, 'acquireTurn', {
      target: { type: 'thread', threadId: created.threadId },
      timeoutMs: 0,
    });
    const admin = await connectDaemon(data);
    const health = await admin.call<{
      pid: number;
      epoch: string;
    }>('getHealth');
    const disconnected = once(admin.socket, 'close');
    process.kill(health.pid, 'SIGKILL');
    await disconnected;
    // Closing one accepted socket does not mean the dying process has closed
    // its listening socket yet. Wait for refusal before testing a fresh start.
    const stoppedDeadline = performance.now() + 10000;
    while (true) {
      let connection;
      try {
        connection = await connectDaemon(data);
      } catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) break;
        throw error;
      } finally {
        connection?.socket.destroy();
      }
      assert.ok(performance.now() < stoppedDeadline, 'Killed daemon listener did not close');
      await delay(10);
    }
    // New daemon opens the committed Turso state and fences previous ownership.
    await ensureDaemon(data, { turnTimeoutMs: 90000 });
    const restartedAdmin = await connectDaemon(data);
    const restartedHealth = await restartedAdmin.call<{
      config: {
        turnTimeoutMs: number;
      };
    }>('getHealth');
    restartedAdmin.close();
    assert.equal(restartedHealth.config.turnTimeoutMs, 90000);
    const resumed = await call<{
      agentName: string;
      pendingTurns: PublicTicket[];
    }>(alice, 'getContext');
    assert.equal(resumed.agentName, 'Alice');
    const retained = resumed.pendingTurns[0]!;
    assert.equal(retained.state, 'offered');
    assert.equal(retained.requestToken, pending.requestToken);
    const stale = await bob.callTool({
      name: 'readTurn',
      arguments: { view: 'page', turnToken: crashHolder.turnToken },
    });
    assert.equal(stale.isError, true);
    const final = await call<PublicTurn>(alice, 'acquireTurn', {
      requestToken: retained.requestToken,
    });
    assert.equal(final.messages.length, 1);
    await call(alice, 'releaseTurn', { turnToken: final.turnToken });
    const cli = await exec(
      process.execPath,
      [join(packageRoot, 'dist/cli.js'), 'thread', 'show', created.threadId, '--workspace', repo],
      { env },
    );
    const shown = JSON.parse(cli.stdout) as Turn;
    assert.equal(shown.page.messages[0]!.body, '@Bob hello from real MCP');
    await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'thread',
        'describe',
        created.threadId,
        '--description',
        'CLI topic',
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    const got = await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'thread',
        'get',
        created.threadId,
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    assert.equal(
      (
        JSON.parse(got.stdout) as {
          description: string;
        }
      ).description,
      'CLI topic',
    );
    const found = await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'thread',
        'search',
        'cli topic',
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    assert.deepEqual(
      (
        JSON.parse(found.stdout) as {
          threads: {
            id: string;
          }[];
        }
      ).threads.map(thread => thread.id),
      [created.threadId],
    );
    const fileTarget = { type: 'files', paths: [{ path: 'handoff.md', kind: 'file' }] };
    const files = await call<{
      turnToken: string;
      target: {
        paths: {
          path: string;
        }[];
      };
    }>(alice, 'acquireTurn', { target: fileTarget });
    const fileQueue = await call<{
      state: string;
      requestToken: string;
    }>(bob, 'acquireTurn', {
      target: fileTarget,
      timeoutMs: 0,
    });
    assert.equal(fileQueue.state, 'queued');
    await writeFile(files.target.paths[0]!.path, 'Native file content\n');
    await call(alice, 'releaseTurn', { turnToken: files.turnToken });
    const nextFiles = await call<{
      turnToken: string;
      target: {
        paths: {
          path: string;
        }[];
      };
    }>(bob, 'acquireTurn', { requestToken: fileQueue.requestToken });
    assert.equal(await readFile(nextFiles.target.paths[0]!.path, 'utf8'), 'Native file content\n');
    const locks = JSON.parse(
      (await exec(process.execPath, [join(packageRoot, 'dist/cli.js'), 'turn', 'list'], { env }))
        .stdout,
    );
    assert.ok(JSON.stringify(locks).includes('handoff.md'));
    await call(bob, 'releaseTurn', { turnToken: nextFiles.turnToken });
    const bodyFile = join(dir, 'ticket.md');
    await writeFile(bodyFile, 'CLI body\n');
    const cliCreated = await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'ticket',
        'create',
        'CLI',
        '--description',
        'CLI task',
        '--owner',
        'Human',
        '--file',
        bodyFile,
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    const ticketId = (
      JSON.parse(cliCreated.stdout) as {
        ticketId: string;
      }
    ).ticketId;
    const cliShown = await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'ticket',
        'show',
        ticketId,
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    assert.equal(JSON.parse(cliShown.stdout).body, 'CLI body\n');
    const editor = join(dir, 'editor.sh');
    await writeFile(editor, '#!/bin/sh\nprintf "Edited safely\\n" > "$1"\n', { mode: 0o700 });
    await chmod(editor, 0o700);
    await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'ticket',
        'edit',
        ticketId,
        '--editor',
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env: { ...env, VISUAL: editor } },
    );
    const edited = await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'ticket',
        'show',
        ticketId,
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    assert.equal(JSON.parse(edited.stdout).body, 'Edited safely\n');
    const threadHistory = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'thread',
            'history',
            created.threadId,
            '--workspace',
            repo,
            '--name',
            'Human',
          ],
          { env },
        )
      ).stdout,
    ) as {
      entries: unknown[];
    };
    assert.ok(threadHistory.entries.length >= 2);
    assert.equal(JSON.stringify(threadHistory).includes('doltCommit'), false);
    const threadRevision = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'thread',
            'revision',
            created.threadId,
            '2',
            '--workspace',
            repo,
            '--name',
            'Human',
          ],
          { env },
        )
      ).stdout,
    ) as {
      messages: {
        body: string;
      }[];
    };
    assert.equal(threadRevision.messages[0]!.body, '@Bob hello from real MCP');
    await exec(
      process.execPath,
      [
        join(packageRoot, 'dist/cli.js'),
        'thread',
        'diff',
        created.threadId,
        '2',
        '--workspace',
        repo,
        '--name',
        'Human',
      ],
      { env },
    );
    const ticketRevision = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'ticket',
            'revision',
            ticketId,
            '1',
            '--workspace',
            repo,
          ],
          { env },
        )
      ).stdout,
    );
    assert.equal(ticketRevision.body, 'CLI body\n');
    const ticketHistory = JSON.parse(
      (
        await exec(
          process.execPath,
          [join(packageRoot, 'dist/cli.js'), 'ticket', 'history', ticketId, '--workspace', repo],
          { env },
        )
      ).stdout,
    );
    assert.equal(ticketHistory.entries.length, 2);
    const inspectedProject = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'project',
            'inspect',
            '--workspace',
            repo,
            '--name',
            'Human',
          ],
          { env },
        )
      ).stdout,
    ) as {
      exportedAt: string;
      messageCount: number;
    };
    assert.ok(inspectedProject.exportedAt);
    assert.equal(inspectedProject.messageCount, 1);
    const projectHistory = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'project',
            'history',
            '--workspace',
            repo,
            '--name',
            'Human',
          ],
          { env },
        )
      ).stdout,
    ) as {
      entries: {
        operationId: string;
      }[];
    };
    assert.ok(projectHistory.entries.length >= 4);
    assert.ok(projectHistory.entries.every(entry => entry.operationId));
    const exported = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            join(packageRoot, 'dist/cli.js'),
            'project',
            'export',
            '--workspace',
            repo,
            '--name',
            'Human',
          ],
          { env },
        )
      ).stdout,
    ) as {
      path: string;
    };
    assert.ok(exported.path.endsWith('.zip'));
    const status = await exec('git', ['-C', repo, 'status', '--porcelain']);
    assert.equal(status.stdout, '?? handoff.md\n');
    assert.equal(await readFile(join(repo, 'handoff.md'), 'utf8'), 'Native file content\n');
  },
);
