import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDaemon, connectDaemon } from '../../src/daemon.js';
import { packageRoot } from '../../src/config.js';
import type { RpcClient } from '../../src/ipc.js';
import type {
  ContentObservation,
  ObservationSnapshot,
  ObservedThreadDetail,
  ObservationGraph,
  ObservedTicketDetail,
} from '../../src/observation-types.js';
const exec = promisify(execFile);
test(
  'real Sonar observers see committed chat, ticket DAGs, contention and retained events without agent side effects',
  { timeout: 90000 },
  async t => {
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-sonar-'),
    );
    const data = join(root, 'data'),
      repo = join(root, 'repo'),
      otherRepo = join(root, 'other');
    const clients: RpcClient[] = [];
    const cli = async (...args: string[]) =>
      await exec(process.execPath, [join(packageRoot, 'dist/cli.js'), ...args], {
        env: { ...process.env, BASSFISH_DATA_DIR: data },
      });
    t.after(async () => {
      for (const client of clients) client.socket.destroy();
      await cli('daemon', 'stop').catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await exec('git', ['init', repo]);
    await exec('git', ['init', otherRepo]);
    await ensureDaemon(data);
    const observer = await connectDaemon(data);
    clients.push(observer);
    await observer.call('openObserver', { workspace: repo, protocolVersion: 2 });
    const empty = await observer.call<ObservationSnapshot>('readObservation', { kind: 'snapshot' });
    assert.equal(empty.status, 'empty');
    await assert.rejects(
      observer.call('openSession', { workspace: repo, name: 'Intruder' }),
      /read-only/,
    );
    await assert.rejects(
      observer.call('forceRelease', { turnId: 'anything', force: true }),
      /read-only/,
    );
    const agent = async (name: string, workspace = repo) => {
      const c = await connectDaemon(data);
      clients.push(c);
      await c.call('openSession', { workspace, name });
      return c;
    };
    const alice = await agent('Alice'),
      bob = await agent('Bob'),
      external = await agent('External', otherRepo);
    const call = <T>(c: RpcClient, name: string, args: unknown): Promise<T> =>
      c.call('callMcpTool', { name, args });
    const thread = await call<{
      threadId: string;
    }>(alice, 'createResource', {
      resourceType: 'thread',
      title: 'Sonar chat',
      description: 'Live conversations',
    });
    const createTicket = async (title: string, dependsOn: string[] = []) =>
      await call<{
        ticketId: string;
      }>(alice, 'createResource', {
        resourceType: 'ticket',
        title,
        description: 'Graph node',
        owner: 'Bob',
        dependsOn,
        body: '# Private body\nContent stays out of summaries.',
      });
    const first = await createTicket('Token storage');
    const second = await createTicket('Refresh API', [first.ticketId]);
    const third = await createTicket('Session UI', [second.ticketId]);
    await call(alice, 'acquireTurn', {
      target: { type: 'files', paths: [{ path: 'src', kind: 'directory' }] },
      timeoutMs: 0,
    });
    await call(external, 'acquireTurn', {
      target: { type: 'files', paths: [{ path: join(root, 'shared.ts'), kind: 'file' }] },
      timeoutMs: 0,
    });
    await call(bob, 'acquireTurn', {
      target: {
        type: 'files',
        paths: [
          { path: 'src/auth.ts', kind: 'file' },
          { path: join(root, 'shared.ts'), kind: 'file' },
        ],
      },
      timeoutMs: 0,
    });
    let snapshot = await observer.call<ObservationSnapshot>('readObservation', {
      kind: 'snapshot',
    });
    assert.equal(snapshot.status, 'ready', snapshot.contentError);
    assert.equal(snapshot.agents.length, 2);
    assert.deepEqual(
      snapshot.turns
        .find(r => r.owner === 'Bob')!
        .blockers.map(b => b.owner)
        .sort(),
      ['Alice', 'External'],
    );
    assert.equal(snapshot.content!.tickets.length, 3);
    assert.equal(JSON.stringify(snapshot.content).includes('Private body'), false);
    assert.deepEqual(snapshot.content!.tickets.find(t => t.id === third.ticketId)!.blockedBy, [
      second.ticketId,
    ]);
    const graph = await observer.call<ObservationGraph>('readObservation', {
      kind: 'graph',
      id: second.ticketId,
    });
    assert.equal(graph.tickets.length, 3);
    const detail = await observer.call<ObservedTicketDetail>('readObservation', {
      kind: 'ticket',
      id: second.ticketId,
    });
    assert.match(detail.page.text, /Private body/);
    assert.equal('body' in detail.ticket, false);
    const started = performance.now();
    const waiting = observer.call<{
      cursor: string;
    }>('waitObservation', {
      cursor: snapshot.cursor,
      timeoutMs: 20000,
    });
    const turn = await call<{
      turnToken: string;
    }>(alice, 'acquireTurn', {
      target: { type: 'thread', threadId: thread.threadId },
      timeoutMs: 0,
    });
    await call(alice, 'commitTurn', {
      turnToken: turn.turnToken,
      mutation: {
        kind: 'appendMessage',
        body: 'Hello from Alice',
        mentions: { agents: ['Bob'], here: false },
      },
    });
    assert.notEqual((await waiting).cursor, snapshot.cursor);
    assert.ok(performance.now() - started < 1000);
    snapshot = await observer.call<ObservationSnapshot>('readObservation', { kind: 'snapshot' });
    assert.equal(snapshot.content!.threads[0]!.preview, 'Hello from Alice');
    assert.deepEqual(snapshot.content!.threads[0]!.participants, ['Alice']);
    const before = JSON.stringify(snapshot.turns);
    const readers = await Promise.all(
      [1, 2].map(async () => {
        const c = await connectDaemon(data);
        clients.push(c);
        await c.call('openObserver', { workspace: repo, protocolVersion: 2 });
        return c;
      }),
    );
    await Promise.all(readers.map(c => c.call('readObservation', { kind: 'snapshot' })));
    await readers[0]!.call('closeObserver');
    await assert.rejects(readers[0]!.call('stopDaemon'), /read-only/);
    const conversation = await observer.call<ObservedThreadDetail>('readObservation', {
      kind: 'thread',
      id: thread.threadId,
    });
    assert.equal(conversation.messages[0]!.body, 'Hello from Alice');
    const after = await observer.call<ObservationSnapshot>('readObservation', { kind: 'snapshot' });
    assert.equal(JSON.stringify(after.turns), before);
    assert.equal(after.agents.length, 2);
    const filtered = await observer.call<ContentObservation>('readObservation', {
      kind: 'content',
      filter: { query: 'Refresh' },
    });
    assert.deepEqual(
      filtered.tickets.map(t => t.title),
      ['Refresh API'],
    );
    const json = await cli('sonar', '--workspace', repo, '--json');
    assert.equal(json.stderr, '');
    assert.equal(JSON.parse(json.stdout).status, 'ready');
    assert.match((await cli('sonar', '--workspace', repo, '--plain')).stdout, /Sonar chat/);
    await cli('daemon', 'stop');
    await ensureDaemon(data);
    const restarted = await connectDaemon(data);
    clients.push(restarted);
    await restarted.call('openObserver', { workspace: repo, protocolVersion: 2 });
    const recovered = await restarted.call<ObservationSnapshot>('readObservation', {
      kind: 'snapshot',
    });
    assert.notEqual(recovered.epoch, snapshot.epoch);
    assert.equal(recovered.turns.length, 0);
    assert.ok(recovered.activity!.events.some(e => e.kind === 'thread.appendMessage'));
    assert.ok(
      recovered.activity!.events.some(e =>
        ['session_lost', 'daemon_restart'].includes(String(e.details.reason)),
      ),
    );
    await delay(10);
  },
);
