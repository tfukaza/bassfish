import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSql } from '../../src/supervisor.js';
import { doltBinary } from '../../src/config.js';
import { DoltContent, parseStoredMentions } from '../../src/storage/dolt.js';
import { SqliteControl } from '../../src/storage/control.js';
import { Bassfish } from '../../src/service.js';
import { SystemClock } from '../../src/runtime.js';
import { hold, errorCode } from '../support.js';
import type { Session, Turn } from '../support.js';
import mysql from 'mysql2/promise';

test('an interrupted credential-file write fails closed before SQL starts', async t => {
  const dir = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-auth-'),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'run'));
  await writeFile(join(dir, 'run', 'sql-password'), '', { mode: 0o600 });
  await assert.rejects(startSql(dir, doltBinary()), /SQL_CREDENTIALS/);
});

test(
  'SQL guardian death aborts an in-flight query and reaps its Dolt process group',
  { timeout: 30_000 },
  async t => {
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-guardian-'),
    );
    const sql = await startSql(dir, doltBinary());
    let connection: mysql.Connection | undefined;
    t.after(async () => {
      await connection?.end().catch(() => {});
      await sql.close();
      await rm(dir, { recursive: true, force: true });
    });
    connection = await mysql.createConnection({ ...sql.endpoint, user: 'root' });
    const inFlight = connection.query('SELECT SLEEP(30)');
    process.kill(sql.guardianPid, 'SIGKILL');
    await sql.ended;
    await assert.rejects(inFlight);
    assert.equal(sql.alive(), false);
    await assert.rejects(
      mysql.createConnection({ ...sql.endpoint, user: 'root', connectTimeout: 500 }),
    );
  },
);

test(
  'real Dolt: credential isolation, semantic commits, rollback, atomicity and restart reconciliation',
  { timeout: 90_000 },
  async t => {
    // Short explicit path: macOS Unix sockets are limited to roughly 104 bytes.
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-dolt-'),
    );
    let sql: Awaited<ReturnType<typeof startSql>> | undefined;
    let content: DoltContent | undefined;
    let control: SqliteControl | undefined;
    t.after(async () => {
      await content?.close();
      control?.close();
      await sql?.close();
      await rm(dir, { recursive: true, force: true });
    });
    sql = await startSql(dir, doltBinary());
    await assert.rejects(
      mysql.createConnection({ socketPath: sql.endpoint.socketPath, user: 'root', password: '' }),
      /Access denied/,
    );
    content = new DoltContent(sql.endpoint);
    control = new SqliteControl(join(dir, 'control.sqlite'));
    let service = new Bassfish(control, content, new SystemClock());
    await service.initialize();
    const a = await service.open('/test/.git', 'Alice');
    const b = await service.open('/test/.git', 'Bob');
    const project = (a.session as Session).projectId;
    const ticket = (await service.callMcp(a.agentHandle, 'createResource', {
      resourceType: 'ticket',
      title: 'Real ticket',
      description: 'Stored in Dolt',
      owner: 'Bob',
      body: '# Detail',
    })) as { ticketId: string };
    const ticketTurn = (await service.callMcp(a.agentHandle, 'acquireTurn', {
      target: { type: 'ticket', ticketId: ticket.ticketId },
      timeoutMs: 0,
    })) as { turnToken: string };
    await service.callMcp(a.agentHandle, 'commitTurn', {
      turnToken: ticketTurn.turnToken,
      mutation: { kind: 'updateTicket', state: 'done' },
    });
    assert.equal((await content.listTickets(project))[0]!.state, 'done');
    const created = (await service.call(a.agentHandle, 'createThread', {
      title: 'Real SQL',
      description: 'Secret description',
    })) as { threadId: string; doltCommit: string };
    const turn = await hold(service, a.agentHandle, created.threadId);
    const queued = await service.requestResourceTurn(b.agentHandle, created.threadId);
    const committed = await service.commitTurn(
      a.agentHandle,
      turn.turn.id,
      turn.turn.fencingToken,
      turn.snapshot.revision,
      {
        kind: 'appendMessage',
        body: "!Bob STOP: Unicode 🎣 and SQL ' ? ; -- body",
        mentions: { agents: ['Bob'], here: false, global: false },
      },
    );
    const next = (await service.claimTurn(
      b.agentHandle,
      service.status(b.agentHandle, queued.requestId as string).offerId as string,
      20,
    )) as Turn;
    assert.equal(next.page.messages[0]!.body, "!Bob STOP: Unicode 🎣 and SQL ' ? ; -- body");
    assert.equal(next.page.messages[0]!.name, 'Alice');
    assert.deepEqual(next.page.messages[0]!.mentions, {
      agents: ['Bob'],
      here: false,
      global: false,
    });
    assert.equal(next.snapshot.revision, '2');
    const raw = await mysql.createConnection({ ...sql.endpoint, user: 'root', database: project });
    try {
      const [logs] = await raw.query<mysql.RowDataPacket[]>(
        'SELECT commit_hash,message FROM dolt_log',
      );
      assert.ok(logs.some(row => row.commit_hash === committed.doltCommit));
      assert.equal(logs.filter(row => String(row.message).includes('appendMessage')).length, 1);
      assert.equal(logs.filter(row => String(row.message).includes('createThread')).length, 1);
      assert.deepEqual((await raw.query('SELECT * FROM dolt_status'))[0], []);
      const [storedMentions] = await raw.query<mysql.RowDataPacket[]>(
        'SELECT mentionsJson FROM messages WHERE id=?',
        [committed.messageId],
      );
      const currentMentions = String(storedMentions[0]!.mentionsJson);
      assert.deepEqual(JSON.parse(currentMentions), { agents: ['Bob'], global: false });
      assert.deepEqual(parseStoredMentions(JSON.stringify(['Bob']), false), {
        agents: ['Bob'],
        here: false,
        global: false,
      });
      await raw.beginTransaction();
      await raw.query('UPDATE threads SET title=? WHERE id=?', ['uncommitted', created.threadId]);
      await raw.rollback();
      assert.equal((await content.snapshot(project, created.threadId, 1)).thread.title, 'Real SQL');
    } finally {
      await raw.end();
    }
    service.releaseTurn(b.agentHandle, next.turn.id, next.turn.fencingToken);
    const describing = await hold(service, a.agentHandle, created.threadId);
    await service.commitTurn(
      a.agentHandle,
      describing.turn.id,
      describing.turn.fencingToken,
      describing.snapshot.revision,
      { kind: 'setThreadDescription', description: 'Updated description' },
    );
    assert.equal(
      (await content.snapshot(project, created.threadId, 1)).thread.description,
      'Updated description',
    );
    const deleting = await hold(service, a.agentHandle, created.threadId);
    await service.commitTurn(
      a.agentHandle,
      deleting.turn.id,
      deleting.turn.fencingToken,
      deleting.snapshot.revision,
      { kind: 'deleteThread' },
    );
    assert.equal((await content.listThreads(project))[0]!.state, 'deleted');
    const activating = await hold(service, a.agentHandle, created.threadId);
    await service.commitTurn(
      a.agentHandle,
      activating.turn.id,
      activating.turn.fencingToken,
      activating.snapshot.revision,
      { kind: 'activateThread' },
    );
    const lost = await hold(service, a.agentHandle, created.threadId);
    // Crash boundary fixture: commit real content, then simulate inability to acknowledge it in SQLite.
    const originalWrite = content.write.bind(content),
      originalResolve = content.resolve.bind(content);
    content.write = async op => {
      await originalWrite(op);
      throw new Error('lost reply');
    };
    content.resolve = async () => ({ state: 'unknown' });
    await assert.rejects(
      service.commitTurn(
        a.agentHandle,
        lost.turn.id,
        lost.turn.fencingToken,
        lost.snapshot.revision,
        { kind: 'appendMessage', body: 'committed but unacknowledged' },
      ),
      errorCode('OUTCOME_UNKNOWN'),
    );
    assert.equal(
      control.view(s => Object.values(s.pending).length),
      1,
    );
    await content.close();
    content = undefined;
    control.close();
    control = undefined;
    await sql.close();
    sql = undefined;
    sql = await startSql(dir, doltBinary());
    content = new DoltContent(sql.endpoint);
    control = new SqliteControl(join(dir, 'control.sqlite'));
    service = new Bassfish(control, content, new SystemClock());
    await service.initialize();
    const resumed = await service.open('/test/.git', 'Alice');
    const after = await hold(service, resumed.agentHandle, created.threadId);
    assert.deepEqual(
      after.page.messages.map(m => m.sequence),
      ['1', '2'],
    );
    assert.equal(after.page.messages[1]!.body, 'committed but unacknowledged');
    assert.equal(after.page.thread.description, 'Updated description');
    assert.equal(after.page.thread.state, 'active');
    assert.equal(
      control.view(s => Object.values(s.pending).length),
      0,
    );
    assert.notEqual(committed.doltCommit, created.doltCommit);
    // Ensure the fixture's monkey patch never leaks into the new content adapter.
    assert.notEqual(content.resolve, originalResolve);
    const dirtyConnection = await mysql.createConnection({
      ...sql.endpoint,
      user: 'root',
      database: project,
    });
    const freshAdapter = new DoltContent(sql.endpoint);
    try {
      await dirtyConnection.query('UPDATE threads SET title=? WHERE id=?', [
        'unexplained working state',
        created.threadId,
      ]);
      await assert.rejects(freshAdapter.ensureProject(project), errorCode('PROJECT_RECOVERING'));
      const [working] = await dirtyConnection.query<mysql.RowDataPacket[]>(
        'SELECT title FROM threads WHERE id=?',
        [created.threadId],
      );
      assert.equal(working[0]!.title, 'unexplained working state'); // No reset, staging, or replay.
    } finally {
      await dirtyConnection.end();
      await freshAdapter.close();
    }
  },
);

test(
  'real Dolt: whole-project restore is one clean commit and ticket history is retained',
  { timeout: 90_000 },
  async t => {
    const dir = await mkdtemp(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-restore-'),
    );
    let sql: Awaited<ReturnType<typeof startSql>> | undefined;
    let content: DoltContent | undefined;
    let control: SqliteControl | undefined;
    t.after(async () => {
      await content?.close();
      control?.close();
      await sql?.close();
      await rm(dir, { recursive: true, force: true });
    });
    sql = await startSql(dir, doltBinary());
    content = new DoltContent(sql.endpoint);
    control = new SqliteControl(join(dir, 'control.sqlite'));
    const service = new Bassfish(control, content, new SystemClock(), {}, dir);
    await service.initialize();
    const opened = await service.open('/restore/.git', 'Restorer');
    const handle = opened.agentHandle;
    const project = (opened.session as Session).projectId;
    const created = (await service.createTicket(handle, {
      title: 'Original',
      description: 'Work',
      owner: 'Restorer',
      state: 'todo',
      body: 'historic swordfish',
      dependsOn: [],
    })) as { ticketId: string };
    const targetCommit = await content.head(project);
    const request = (await service.requestResourceTurn(handle, 'ticket', created.ticketId)) as {
      offerId: string;
    };
    const ticket = (await service.call(handle, 'claimTurn', { offerId: request.offerId })) as Turn;
    await service.commitTurn(
      handle,
      ticket.turn.id,
      ticket.turn.fencingToken,
      ticket.snapshot.revision,
      { kind: 'replaceTicketBody', body: 'current body' },
    );
    const later = (await service.createTicket(handle, {
      title: 'Later',
      description: 'Work',
      owner: 'Restorer',
      state: 'todo',
      body: 'delete on restore',
      dependsOn: [],
    })) as { ticketId: string };
    const restoreRequest = (await service.call(handle, 'requestTurn', {
      target: { type: 'project', purpose: 'restore' },
    })) as { offerId: string };
    const restoreTurn = (await service.call(handle, 'claimTurn', {
      offerId: restoreRequest.offerId,
    })) as Turn;
    const turn = { id: restoreTurn.turn.id, fencingToken: restoreTurn.turn.fencingToken };
    const preview = (await service.call(handle, 'previewSnapshotRestore', {
      turn,
      targetCommit,
    })) as { previewToken: string };
    const restored = (await service.call(handle, 'restoreSnapshot', {
      turn,
      previewToken: preview.previewToken,
    })) as { doltCommit: string; changes: unknown[] };
    const snapshot = await content.projectSnapshot(project);
    assert.equal(
      snapshot.tickets.find(value => value.id === created.ticketId)?.body,
      'historic swordfish',
    );
    assert.equal(
      snapshot.tickets.some(value => value.id === later.ticketId),
      false,
    );
    assert.ok(restored.changes.length >= 2);
    const history = await content.history(project, 'ticket', created.ticketId);
    assert.ok(history.some(value => value.afterRevision === '2'));
    const historic = await content.ticketSnapshot(
      project,
      created.ticketId,
      undefined,
      await content.commitAtRevision(project, 'ticket', created.ticketId, '2'),
    );
    assert.equal(historic.ticket.body, 'current body');
    const raw = await mysql.createConnection({ ...sql.endpoint, user: 'root', database: project });
    try {
      const [logs] = await raw.query<mysql.RowDataPacket[]>(
        'SELECT commit_hash,message FROM dolt_log WHERE message LIKE ?',
        ['%restoreSnapshot%'],
      );
      assert.equal(logs.length, 1);
      assert.equal(logs[0]!.commit_hash, restored.doltCommit);
      assert.deepEqual((await raw.query('SELECT * FROM dolt_status'))[0], []);
    } finally {
      await raw.end();
    }
  },
);
