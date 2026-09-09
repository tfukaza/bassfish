import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { SqliteControl } from '../src/storage/control.js';
import { ActivityJournal, activityLimit, activityRetentionMs } from '../src/storage/activity.js';
import { ProjectObserver } from '../src/observer.js';
import { fixture, hold } from './support.js';
import { graphRelations, layoutTickets, graphNeighbor } from '../src/sonar/graph.js';
import { Canvas, clip, safeText } from '../src/sonar/visual.js';
import {
  initialScreen,
  paintScreen,
  conversationLines,
  reservationPathRows,
} from '../src/sonar/screen.js';
import { SonarApp } from '../src/sonar/app.js';
import { SonarClient } from '../src/sonar/client.js';
import type {
  ActivityDraft,
  ObservationSnapshot,
  ObservedTicket,
  ObservedThreadDetail,
} from '../src/observation-types.js';

function ticket(
  id: string,
  dependencies: string[] = [],
  state: ObservedTicket['state'] = 'todo',
): ObservedTicket {
  return {
    id,
    title: `Ticket ${id}`,
    description: 'A real prerequisite relationship',
    owner: 'alice',
    ownerName: 'Alice',
    state,
    dependsOn: dependencies,
    blockedBy: dependencies,
    blocks: [],
    ready: !dependencies.length,
    revision: '1',
    creator: 'alice',
    creatorName: 'Alice',
    lastEditor: 'alice',
    lastEditorName: 'Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function demo(): ObservationSnapshot {
  const a = ticket('a', [], 'done'),
    b = ticket('b', ['a'], 'in_progress'),
    c = ticket('c', ['a']),
    d = ticket('d', ['b', 'c']);
  a.blocks = ['b', 'c'];
  b.blocks = ['d'];
  c.blocks = ['d'];
  b.blockedBy = [];
  c.blockedBy = [];
  return {
    protocolVersion: 1,
    epoch: 'epoch',
    cursor: '4',
    at: Date.now(),
    project: { id: 'p', commonDir: '/repo/.git', recovering: false },
    status: 'ready',
    agents: [
      {
        id: 'alice',
        name: 'Alice',
        online: true,
        host: 'claude',
        workspace: '/repo',
        lastSeen: Date.now(),
      },
    ],
    turns: [],
    content: {
      commit: 'abcdef123456',
      threads: [
        {
          id: 'thread',
          title: 'Auth implementation',
          description: '',
          state: 'active',
          revision: '1',
          headSequence: '1',
          creator: 'alice',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestAuthor: 'Alice',
          preview: 'Hello from agents',
          participants: ['Alice'],
        },
      ],
      tickets: [a, b, c, d],
      totals: { threads: 1, tickets: 4, states: { done: 1, in_progress: 1, todo: 2 } },
      nextThreadOffset: null,
      nextTicketOffset: null,
    },
    activity: {
      events: [],
      nextBefore: null,
      recordingSince: Date.now(),
      retainedSince: null,
      buckets: Array<number>(30).fill(0),
      bucketStart: Date.now(),
    },
  };
}
const threadDetail = (snapshot: ObservationSnapshot): ObservedThreadDetail => ({
  resourceType: 'thread',
  thread: snapshot.content!.threads[0]!,
  commit: snapshot.content!.commit,
  messages: [
    {
      id: 'message',
      threadId: 'thread',
      sequence: '1',
      identityId: 'alice',
      name: 'Alice',
      instanceId: 'instance',
      createdAt: new Date().toISOString(),
      body: 'Hello from agents\n\n```ts\nconst emoji = "魚🐟";\n```',
      mentions: { agents: ['Bob'], here: false, global: false },
    },
  ],
  truncated: false,
  nextBefore: null,
});

test('reservation trees distinguish exact locks from grouping directories', () => {
  const turn = {
    id: 'files',
    workspace: '/repo',
    state: 'CLAIMED',
    paths: [
      { path: '/repo/docs/readme.md', kind: 'file' as const },
      { path: '/repo/src/lib/components/hero', kind: 'directory' as const },
      { path: '/repo/src/lib/components/motion/spring.ts', kind: 'file' as const },
    ],
  };
  const unicode = reservationPathRows(turn, false);
  assert.equal(unicode.filter(row => row.text.includes('src/')).length, 1);
  assert.equal(unicode.filter(row => row.text.includes('lib/')).length, 1);
  assert.match(unicode.find(row => row.text.includes('hero/'))!.text, /◆ hero\/ · LOCKED DIR/);
  assert.match(
    unicode.find(row => row.text.includes('spring\.ts'))!.text,
    /◆ spring\.ts · LOCKED FILE/,
  );
  assert.doesNotMatch(unicode.find(row => row.text.includes('components/'))!.text, /LOCKED/);
  assert.ok(unicode.some(row => row.text.includes('├─')));
  assert.ok(unicode.some(row => row.text.includes('└─')));
  assert.ok(unicode.some(row => row.text.includes('│ ')));

  const ascii = reservationPathRows(turn, true);
  assert.match(ascii.find(row => row.text.includes('hero/'))!.text, /\* hero\/ · LOCKED DIR/);
  assert.ok(ascii.some(row => row.text.includes('|-')));
  assert.ok(ascii.some(row => row.text.includes('`-')));
  assert.doesNotMatch(ascii.map(row => row.text).join('\n'), /[◆◇├└│]/);

  const queued = reservationPathRows({ ...turn, state: 'QUEUED' }, false);
  assert.match(queued.find(row => row.text.includes('hero/'))!.text, /◇ hero\/ · REQUEST DIR/);
  assert.doesNotMatch(queued.map(row => row.text).join('\n'), /LOCKED/);
});

test('Sonar reads and waits without changing coordination, and heartbeats create no events', async t => {
  const f = await fixture();
  t.after(f.close);
  const observer = new ProjectObserver(
    f.control,
    {
      head: f.content.head.bind(f.content),
      snapshot: f.content.snapshot.bind(f.content),
      ticketSnapshot: f.content.ticketSnapshot.bind(f.content),
      observeContent: async () => demo().content!,
      observeGraph: async () => ({ commit: 'abcdef', tickets: [], hidden: 0 }),
    },
    f.service.epoch,
  );
  const before = f.control.view(s => s);
  const cursor = f.control.activity.head();
  const snapshot = await observer.snapshot('/repo/.git');
  assert.equal(snapshot.agents.length, 2);
  await observer.read('/repo/.git', {
    kind: 'thread',
    id: f.thread,
    commit: await f.content.head(snapshot.project!.id),
  });
  await observer.wait('/repo/.git', cursor, 1);
  assert.deepEqual(
    f.control.view(s => s),
    before,
  );
  f.service.heartbeat(f.a.agentHandle);
  assert.equal(f.control.activity.head(), cursor);
  assert.equal((await observer.snapshot('/unknown/.git')).status, 'empty');
  assert.equal(
    f.control.view(s => Object.keys(s.projects).length),
    1,
  );
  const waiting = observer.wait('/repo/.git', cursor, 1000);
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  assert.notEqual((await waiting).cursor, cursor);
  f.service.releaseTurn(f.a.agentHandle, turn.turn.id, turn.turn.fencingToken);
});

test('presence activity tracks a shared identity cohort rather than physical adapters', async t => {
  const f = await fixture();
  t.after(f.close);
  const projectId = f.control.view(s => Object.keys(s.projects)[0]!);
  const first = await f.service.open(
    '/repo/.git',
    undefined,
    { host: 'codex' },
    '/repo/.git',
    'shared-session',
  );
  const afterFirst = f.control.activity.head();
  const second = await f.service.open(
    '/repo/.git',
    undefined,
    { host: 'codex' },
    '/repo/.git',
    'shared-session',
  );
  assert.equal(f.control.activity.head(), afterFirst);
  f.service.disconnect(first.agentHandle);
  assert.equal(f.control.activity.head(), afterFirst);
  f.service.disconnect(second.agentHandle);
  const latest = f.control.activity.page({ projectId }).events[0]!;
  assert.equal(latest.kind, 'agent.disconnected');
  assert.equal(latest.identityId, (first.session as { identityId: string }).identityId);
});

test('journal captures brief reservations, precise release causes, and committed writes once', async t => {
  const f = await fixture();
  t.after(f.close);
  const projectId = f.control.view(s => Object.keys(s.projects)[0]!);
  const acquire = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'files', paths: [{ path: 'test.ts', kind: 'file' }] },
    timeoutMs: 0,
  })) as { turnToken: string };
  const request = f.control.view(s =>
    Object.values(s.requests).find(r => r.resourceType === 'files')!,
  );
  assert.equal(request.claimedAt, f.clock.now());
  f.service.forceRelease(acquire.turnToken);
  const fileEvents = f.control.activity
    .page({ projectId })
    .events.filter(e => e.resourceType === 'files');
  assert.ok(fileEvents.some(e => e.kind === 'files.claimed'));
  assert.ok(fileEvents.some(e => e.details.reason === 'force_released'));
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  f.content.fail = 'after_commit';
  await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'Never duplicate me or store my body in the journal' },
  );
  const events = f.control.activity.page({ projectId }).events;
  assert.equal(events.filter(e => e.kind === 'thread.appendMessage').length, 1);
  assert.equal(JSON.stringify(events).includes('Never duplicate'), false);
  const before = f.control.activity.head();
  assert.throws(() =>
    f.control.update(s => {
      (s.observationEvents ??= []).push({
        id: 'rollback',
        projectId,
        kind: 'test',
        at: Date.now(),
        resourceType: 'project',
        resourceId: projectId,
        details: {},
      });
      throw new Error('rollback');
    }),
  );
  assert.equal(f.control.activity.head(), before);
});

test('schema 10 migration preserves identities and refuses future schemas unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-sonar-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  const control = new SqliteControl(path);
  control.update(s => {
    s.projects.p = { id: 'p', commonDir: '/repo/.git', recovering: false };
    s.identities.a = { id: 'a', projectId: 'p', name: 'Alice' };
  });
  control.close();
  const old = new DatabaseSync(path);
  old.exec(
    `ALTER TABLE turnRequests DROP COLUMN claimedAt;
     ALTER TABLE turnRequests DROP COLUMN terminalReason;
     ALTER TABLE pendingCommits DROP COLUMN observationJson;
     ALTER TABLE notifications RENAME COLUMN lastDeliveredWakeKey TO lastPushedRunId;
     CREATE TABLE wakeDispatches (
       id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL,
       runId TEXT NOT NULL, createdAt INTEGER NOT NULL
     );
     CREATE TABLE nativeHostPreferences (
       projectId TEXT NOT NULL, identityId TEXT NOT NULL,
       host TEXT NOT NULL CHECK(host IN ('claude','opencode')), clientId TEXT NOT NULL,
       updatedAt INTEGER NOT NULL, PRIMARY KEY(projectId,host,clientId)
     );
     DROP TABLE activityEvents;
     DROP TABLE activityProjects;
     PRAGMA user_version=10`,
  );
  old.close();
  const migrated = new SqliteControl(path);
  assert.equal(
    migrated.view(s => s.identities.a!.name),
    'Alice',
  );
  assert.equal(migrated.activity.head(), '0');
  migrated.close();
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 13);
  assert.equal(
    inspect
      .prepare("SELECT COUNT(*) AS count FROM pragma_table_info('notifications') WHERE name=?")
      .get('lastDeliveredWakeKey')!.count,
    1,
  );
  assert.equal(
    inspect
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
      .get('wakeDispatches')!.count,
    0,
  );
  assert.equal(
    inspect
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
      .get('nativeHostPreferences')!.count,
    0,
  );
  inspect.exec('PRAGMA user_version=999');
  inspect.close();
  assert.throws(() => new SqliteControl(path), /SCHEMA_MISMATCH|incompatible/);
  const final = new DatabaseSync(path);
  assert.equal(final.prepare('PRAGMA user_version').get()!.user_version, 999);
  final.close();
});

test('activity retention reports gaps and groups actual events into minute buckets', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE controlMeta(key TEXT PRIMARY KEY,value TEXT)');
  const journal = new ActivityJournal(db);
  journal.initialize();
  const event = (id: string, at: number): ActivityDraft => ({
    id,
    projectId: 'p',
    kind: 'files.claimed',
    at,
    resourceType: 'files',
    resourceId: id,
    details: {},
  });
  journal.append([event('old', Date.now() - activityRetentionMs - 1), event('new', Date.now())]);
  const page = journal.page({ projectId: 'p' });
  assert.deepEqual(
    page.events.map(e => e.id),
    ['new'],
  );
  assert.equal(
    page.buckets.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(journal.gap('p', '0'), true);
  assert.equal(activityLimit, 100_000);
  db.close();
});

test('dependency layout retains exact diamond edges, selection paths and stable positions', () => {
  const tickets = demo().content!.tickets;
  const layout = layoutTickets(tickets);
  assert.deepEqual(layout.edges.map(e => `${e.from}>${e.to}`).sort(), ['a>b', 'a>c', 'b>d', 'c>d']);
  for (const edge of layout.edges)
    assert.ok(
      layout.nodes.find(n => n.id === edge.from)!.x < layout.nodes.find(n => n.id === edge.to)!.x,
    );
  assert.deepEqual([...graphRelations(tickets, 'd').prerequisites].sort(), ['a', 'b', 'c']);
  assert.equal(
    graphNeighbor(layout, 'a', 1, 0) === 'b' || graphNeighbor(layout, 'a', 1, 0) === 'c',
    true,
  );
  assert.deepEqual(layoutTickets(tickets.map(t => ({ ...t, state: 'done' }))).nodes, layout.nodes);
});

test('observer bounds large reservation and event pages with explicit continuations', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'files', paths: [{ path: 'test.ts', kind: 'file' }] },
    timeoutMs: 0,
  });
  const request = f.control.view(s =>
    Object.values(s.requests).find(r => r.resourceType === 'files')!,
  );
  const paths = Array.from({ length: 256 }, (_, i) => ({
    kind: 'file' as const,
    path: `/repo/${i}/${'x'.repeat(3900)}`,
  }));
  f.control.update(s => {
    const turn = s.requests[request.id]!;
    if (turn.resourceType === 'files') turn.paths = paths;
    for (let i = 0; i < 105; i++)
      s.identities[`extra-${i}`] = {
        id: `extra-${i}`,
        name: `Extra${i}`,
        projectId: request.projectId,
      };
    (s.observationEvents ??= []).push(
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `large-${i}`,
        projectId: request.projectId,
        resourceType: 'files' as const,
        resourceId: request.id,
        kind: 'files.claimed',
        at: Date.now(),
        details: { paths },
      })),
    );
  });
  const observer = new ProjectObserver(
    f.control,
    {
      head: f.content.head.bind(f.content),
      snapshot: f.content.snapshot.bind(f.content),
      ticketSnapshot: f.content.ticketSnapshot.bind(f.content),
      observeContent: async () => demo().content!,
      observeGraph: async () => ({ commit: 'abcdef', tickets: [], hidden: 0 }),
    },
    f.service.epoch,
  );
  const snapshot = await observer.snapshot('/repo/.git');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 500_000);
  assert.equal(snapshot.agents.length, 100);
  assert.equal(snapshot.nextAgentOffset, 100);
  assert.equal((await observer.snapshot('/repo/.git', { agentOffset: 100 })).agents.length, 7);
  const turn = snapshot.turns.find(r => r.id === request.id)!;
  assert.equal(turn.paths!.length, 8);
  assert.equal(turn.pathCount, 256);
  const next = (await observer.read('/repo/.git', {
    kind: 'files',
    id: request.id,
    pathOffset: 8,
  })) as typeof turn;
  assert.equal(next.paths![0]!.path, paths[8]!.path);
  const event = f.control.activity.event(request.projectId, 'large-1', 248)!;
  assert.equal(event.details.nextPathOffset, null);
  assert.equal((event.details.paths as typeof paths)[7]!.path, paths[255]!.path);
  assert.equal(f.control.activity.event('another-project', 'large-1'), undefined);
  assert.ok(snapshot.activity!.nextBefore);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.activity)) < 240_000);
  const abort = new AbortController();
  const waiting = observer.wait('/repo/.git', f.control.activity.head(), 20_000, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
});

test('terminal canvas clips graphemes, neutralizes control sequences and renders every supported size', () => {
  assert.equal(safeText('\x1b[2JHello\x1b]52;c;secret\x07\u202eWorld'), 'HelloWorld');
  assert.equal(clip('魚🐟abc', 4), '魚🐟');
  const canvas = new Canvas(6, 2);
  canvas.text(0, 0, '魚🐟abc');
  assert.equal(canvas.plain().split('\n')[0], '魚🐟ab');
  const snapshot = demo();
  if (process.env.SONAR_VISUAL) {
    for (const view of ['monitor', 'threads', 'tickets'] as const) {
      const ui = {
        ...initialScreen(view),
        thread: threadDetail(snapshot),
        graph: { commit: 'abcdef', tickets: snapshot.content!.tickets, hidden: 0 },
        layout: layoutTickets(snapshot.content!.tickets),
        selected: { tickets: 'd', threads: 'thread' },
      };
      process.stdout.write(
        paintScreen({ phase: 'live', snapshot, gap: false }, ui, 120, 32).plain() + '\n',
      );
    }
  }
  for (const [width, height] of [
    [80, 24],
    [120, 36],
    [160, 48],
  ]) {
    for (const view of ['monitor', 'threads', 'files', 'tickets', 'activity'] as const) {
      const ui = {
        ...initialScreen(view),
        thread: threadDetail(snapshot),
        graph: { commit: 'abcdef', tickets: snapshot.content!.tickets, hidden: 0 },
        layout: layoutTickets(snapshot.content!.tickets),
        selected: { tickets: 'd', threads: 'thread' },
      };
      const frame = paintScreen({ phase: 'live', snapshot, gap: false }, ui, width!, height!);
      assert.equal(frame.rows.length, height);
      assert.ok(frame.rows.every(r => r.length === width));
      assert.ok(frame.rows.every(r => stringWidth(r.map(c => c.text).join('')) === width));
      assert.match(frame.plain(), /bassfish sonar/);
      const ascii = paintScreen(
        { phase: 'live', snapshot, gap: false },
        ui,
        width!,
        height!,
        true,
      ).plain();
      assert.doesNotMatch(ascii, /[╭╮╰╯│─▶]/);
    }
  }
  assert.match(
    conversationLines(threadDetail(snapshot), 40, 0)
      .map(r => r.text)
      .join('\n'),
    /Alice[\s\S]*const emoji/,
  );
});

test('interactive Sonar navigates chat and graph, pauses updates, filters and exits', async () => {
  let snapshot = demo();
  const client = new SonarClient('/not-used', '/repo');
  client.state = { phase: 'live', snapshot, gap: false };
  client.read = async <T>(request: Parameters<SonarClient['read']>[0]) => {
    const value =
      request.kind === 'snapshot'
        ? snapshot
        : request.kind === 'thread'
          ? threadDetail(snapshot)
          : request.kind === 'graph'
            ? { commit: snapshot.content!.commit, tickets: snapshot.content!.tickets, hidden: 0 }
            : {
                resourceType: 'ticket',
                ticket: snapshot.content!.tickets.find(
                  t => t.id === ('id' in request ? request.id : 'a'),
                ),
                commit: snapshot.content!.commit,
                page: { text: '# Ticket body', nextCursor: null },
              };
    return value as T;
  };
  const app = render(
    createElement(SonarApp, { client, dimensions: { columns: 120, rows: 32 }, color: false }),
  );
  try {
    await delay(50);
    assert.match(app.lastFrame()!, /Auth implementation/);
    app.stdin.write('2');
    await delay(60);
    assert.match(app.lastFrame()!, /Hello from agents/);
    app.stdin.write('4');
    await delay(60);
    assert.match(app.lastFrame()!, /prerequisite/);
    app.stdin.write(' ');
    await delay(30);
    snapshot = {
      ...snapshot,
      cursor: '5',
      content: {
        ...snapshot.content!,
        threads: [{ ...snapshot.content!.threads[0]!, title: 'Changed while paused' }],
      },
    };
    await client.refresh();
    await delay(30);
    assert.match(app.lastFrame()!, /PAUSED/);
    assert.doesNotMatch(app.lastFrame()!, /Changed while paused/);
    app.stdin.write(' ');
    app.stdin.write('m');
    await delay(50);
    assert.match(app.lastFrame()!, /Changed while paused/);
    app.stdin.write('?');
    await delay(30);
    assert.match(app.lastFrame()!, /read-only project observability/);
    app.stdin.write('\x1b');
    app.stdin.write('q');
    await delay(20);
  } finally {
    app.unmount();
    app.cleanup();
    client.close();
  }
});
