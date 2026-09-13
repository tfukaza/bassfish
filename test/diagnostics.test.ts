import { diagnosticCode } from '../src/diagnostic-events.js';
import { daemonError } from '../src/daemon-diagnostics.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database, Transaction } from '@tursodatabase/database';
import { DiagnosticOperation, diagnosticHash, withDiagnostics } from '../src/diagnostic-events.js';
import type { DiagnosticFields, DiagnosticSink } from '../src/diagnostic-events.js';
import {
  DiagnosticLog,
  diagnosticLine,
  diagnosticRotationBytes,
  rotateDiagnosticLog,
} from '../src/diagnostic-log.js';
import { RuntimeSampler } from '../src/runtime-sampler.js';
import { RpcClient, listenRpc } from '../src/ipc.js';
import { TursoStore } from '../src/storage/turso.js';
import { BassfishError } from '../src/domain.js';
import { exclusiveLock } from '../src/lock.js';
import { fixture } from './support.js';

async function directory(t: { after: (callback: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-diagnostics-'),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function capture() {
  const events: Array<{ event: string; fields: DiagnosticFields }> = [];
  const emit: DiagnosticSink = (event, fields) => events.push({ event, fields });
  return { events, emit };
}
test('runtime sampler distinguishes main-loop stalls, scheduling gaps and clock shifts', () => {
  const sampler = new RuntimeSampler();
  assert.deepEqual(sampler.sample(10000, 1000, 0), []);
  assert.deepEqual(sampler.sample(11000, 2000, 2000), []);
  assert.deepEqual(
    sampler.sample(12000, 3000, 3000).map(e => e.event),
    ['runtime.stall_started'],
  );
  assert.deepEqual(
    sampler.sample(13000, 4000, 4000).map(e => e.event),
    ['runtime.stall_ongoing'],
  );
  const recovery = sampler.sample(14000, 5000, 0);
  assert.equal(recovery[0]?.event, 'runtime.stall_recovered');
  assert.equal(recovery[0]?.fields.maxGapMs, 4000);
  const gap = sampler.sample(24000, 15000, 0);
  assert.deepEqual(
    gap.map(e => e.event),
    ['runtime.sampler_gap'],
  );
  assert.equal(gap[0]?.fields.cause, 'unknown');
  assert.equal(sampler.sample(50000, 16000, 0)[0]?.event, 'runtime.clock_changed');
  assert.equal(sampler.sample(10000, 17000, 0)[0]?.event, 'runtime.clock_changed');
});
test('diagnostic operations correlate phases without exposing error messages', () => {
  const { events, emit } = capture();
  withDiagnostics(emit, { ipcRequestId: 'request-1', method: 'callMcpTool' }, () => {
    const op = new DiagnosticOperation('storage', { writable: true });
    op.phase('pool_wait', { poolQueued: 2 });
    op.phase('commit');
    op.finish(new Error('BODY_SECRET SQL_SECRET TOKEN_SECRET'));
  });
  const failure = events.find(e => e.event === 'storage.failed')!;
  assert.equal(failure.fields.ipcRequestId, 'request-1');
  assert.equal(failure.fields.code, 'INTERNAL_ERROR');
  assert.ok((failure.fields.phasesMs as DiagnosticFields).commit !== undefined);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
  assert.equal(diagnosticCode(Object.assign(new Error('OS_SECRET'), { code: 'ENOMEM' })), 'ENOMEM');
  assert.equal(diagnosticCode({ code: 'GenericFailure' }), 'NATIVE_FAILURE');
  assert.doesNotMatch(JSON.stringify(daemonError(new Error('SQL_SECRET\nBODY_SECRET'))), /SECRET/);
  assert.equal(new Set(events.map(e => e.fields.operationId)).size, 1);
  assert.doesNotThrow(() =>
    withDiagnostics(
      () => {
        throw Error('logger failed');
      },
      {},
      () => {
        const op = new DiagnosticOperation('request');
        op.phase('waiting');
        op.finish();
      },
    ),
  );
});
test('records, rotation and suppressed incidents preserve permissions and bounded sizes', async t => {
  const dir = await directory(t),
    path = join(dir, 'runtime.log');
  assert.equal(diagnosticRotationBytes, 8 * 1024 * 1024);
  const log = new DiagnosticLog(path);
  t.after(() => log.close());
  log.emit('request.failed', { method: 'callTool', durationMs: 100 });
  log.emit('request.failed', { method: 'callTool', durationMs: 300 });
  log.emit('request.failed', { method: 'callTool', durationMs: 200 });
  log.emit('runtime.summary', { status: 'responsive' });
  log.emit('runtime.summary', { status: 'responsive' });
  log.close();
  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.event === 'request.failed').length, 1);
  assert.equal(records.filter(r => r.event === 'runtime.summary').length, 2);
  const suppression = records.find(r => r.event === 'logging.suppressed');
  assert.equal(suppression.count, 2);
  assert.equal(suppression.maxDurationMs, 300);
  const big = diagnosticLine('test', { giant: 'x'.repeat(10000), ipcRequestId: 'r' });
  assert.ok(Buffer.byteLength(big) <= 4096);
  assert.equal(JSON.parse(big).truncated, true);
  for (let i = 0; i < 5; i++) {
    await writeFile(path, `generation ${i}`);
    rotateDiagnosticLog(path, 1);
  }
  assert.equal(await readFile(`${path}.3`, 'utf8'), 'generation 2');
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'generation 4');
  assert.equal((await stat(`${path}.3`)).mode & 0o777, 0o600);
});
test('logging contention and an unavailable path cannot change an RPC result', async t => {
  const dir = await directory(t),
    blocked = join(dir, 'not-a-directory');
  await writeFile(blocked, 'file');
  const broken = new DiagnosticLog(join(blocked, 'clients.log'), true);
  t.after(() => broken.close());
  const server = await listenRpc(
    join(dir, 'daemon.sock'),
    async () => {
      throw new BassfishError('EXPECTED', 'unchanged');
    },
    () => {},
    broken.emit,
  );
  const client = await RpcClient.connect(join(dir, 'daemon.sock'), broken.emit);
  t.after(async () => {
    client.socket.destroy();
    await server.close();
  });
  await assert.rejects(client.call('test'), { code: 'EXPECTED', message: 'unchanged' });
  const shared = new DiagnosticLog(join(dir, 'clients.log'), true);
  t.after(() => shared.close());
  const unlock = exclusiveLock(join(dir, 'diagnostic-clients.lock'));
  try {
    for (let i = 0; i < 1100; i++) shared.emit('client.connected', { sequence: i });
  } finally {
    unlock();
  }
  shared.flush();
  const records = (await readFile(join(dir, 'clients.log'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(records.find(r => r.event === 'logging.dropped').count, 76);
  assert.equal(records.length, 1025);
});
test('client deadline and late response correlate without replaying a mutation or leaking payloads', async t => {
  const dir = await directory(t),
    { events, emit } = capture();
  let writes = 0;
  const server = await listenRpc(
    join(dir, 'daemon.sock'),
    async () => {
      await delay(100);
      writes++;
      return { body: 'RESPONSE_SECRET', revision: '1' };
    },
    () => {},
    emit,
  );
  const client = await RpcClient.connect(join(dir, 'daemon.sock'), emit);
  t.after(async () => {
    client.socket.destroy();
    await server.close();
  });
  const token = 'AUTH_TOKEN_SECRET';
  await assert.rejects(
    client.call(
      'callMcpTool',
      {
        name: 'commitTurn',
        hostSessionId: 'HOST_SECRET',
        args: { turnToken: token, mutation: { body: 'BODY_SECRET' } },
      },
      undefined,
      20,
    ),
    { code: 'OUTCOME_UNKNOWN' },
  );
  await delay(150);
  assert.equal(writes, 1);
  const deadline = events.find(e => e.event === 'client.deadline')!;
  const late = events.find(e => e.event === 'client.late_reply')!;
  const serverOp = events.find(
    e => e.event === 'operation.finished' && e.fields.kind === 'request',
  )!;
  assert.equal(deadline.fields.ipcRequestId, late.fields.ipcRequestId);
  assert.equal(deadline.fields.ipcRequestId, serverOp.fields.ipcRequestId);
  assert.equal(deadline.fields.tokenHash, diagnosticHash(token));
  assert.equal(deadline.fields.tool, 'commitTurn');
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});
test('a deliberate IPC long poll is excluded from slow-call incidents', async t => {
  const dir = await directory(t),
    { events, emit } = capture();
  const server = await listenRpc(
    join(dir, 'daemon.sock'),
    async () => {
      await delay(1100);
      return {};
    },
    () => {},
    emit,
  );
  const client = await RpcClient.connect(join(dir, 'daemon.sock'), emit);
  t.after(async () => {
    client.socket.destroy();
    await server.close();
  });
  await client.call('callMcpTool', { name: 'acquireTurn', args: { timeoutMs: 1200 } });
  assert.equal(events.filter(e => e.event === 'request.slow').length, 0);
  await client.call('callMcpTool', { name: 'getContext', args: { timeoutMs: 1200 } });
  assert.equal(events.filter(e => e.event === 'request.slow').length, 1);
});
test('storage pool exhaustion and slow native statements identify their phases without SQL', async t => {
  const dir = await directory(t),
    { events, emit } = capture();
  const store = await TursoStore.open(join(dir, 'test.db'), 'CREATE TABLE test(value TEXT)', 1);
  t.after(() => store.close());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  const occupied = store.read(async () => {
    entered();
    await gate;
  });
  await ready;
  const queued = withDiagnostics(emit, { ipcRequestId: 'pooled' }, () =>
    store.read(tx => tx.get('SELECT 1')),
  );
  await delay(1100);
  release();
  await Promise.all([occupied, queued]);
  const slow = events.find(e => e.event === 'storage.slow')!;
  assert.ok(Number(slow.fields.poolWaitMs) >= 1000);
  assert.ok((slow.fields.phasesMs as Record<string, number>).pool_wait! >= 1000);
  await withDiagnostics(emit, { ipcRequestId: 'statement' }, () =>
    store.read(async tx => {
      const native = (tx as unknown as { transaction: Transaction }).transaction;
      const original = native.prepare.bind(native);
      native.prepare = async (...args) => {
        await delay(1100);
        return original(...args);
      };
      try {
        return await tx.get('SELECT ? AS value /* SQL_SECRET */', 'ARG_SECRET');
      } finally {
        native.prepare = original;
      }
    }),
  );
  const statement = events.find(e => e.event === 'storage.statement_slow')!;
  assert.equal(statement.fields.ipcRequestId, 'statement');
  assert.equal(statement.fields.statementKind, 'get');
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});
test('storage retries known conflicts and diagnoses rollback without changing transactions', async t => {
  const dir = await directory(t),
    { events, emit } = capture();
  const store = await TursoStore.open(
    join(dir, 'test.db'),
    'CREATE TABLE test(value INTEGER); INSERT INTO test VALUES(0)',
  );
  t.after(() => store.close());
  let calls = 0;
  await withDiagnostics(emit, { ipcRequestId: 'retry' }, () =>
    store.write(async tx => {
      await tx.run('UPDATE test SET value=value+1');
      if (++calls < 3) throw Error('Write-write conflict');
    }),
  );
  assert.equal(calls, 3);
  assert.deepEqual(await store.read(tx => tx.get('SELECT value FROM test')), { value: 1 });
  const finished = events.find(e => e.event === 'operation.finished')!;
  assert.equal(finished.fields.conflicts, 2);
  assert.equal(finished.fields.attempts, 3);
  assert.ok(Number(finished.fields.backoffMs) > 0);
  await assert.rejects(
    withDiagnostics(emit, {}, () =>
      store.write(async () => {
        throw Error('database is busy');
      }),
    ),
    { code: 'STORAGE_BUSY' },
  );
  assert.equal(events.filter(e => e.event === 'storage.attempt_failed').length, 7);
  assert.equal(events.find(e => e.event === 'storage.failed')?.fields.code, 'STORAGE_BUSY');
});
test('session expiry records heartbeat age and reservations only after commit', async () => {
  const f = await fixture(),
    { events, emit } = capture();
  try {
    f.service.diagnostics = emit;
    f.service.limits.instanceMs = 5000;
    await assert.rejects(
      f.control.transaction(async () => {
        await f.service.heartbeat(f.a.agentHandle);
        throw Error('rollback');
      }),
    );
    assert.equal(events.filter(e => e.event === 'session.heartbeat').length, 0);
    await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
      target: { type: 'files', paths: [{ path: join(f.dir, 'source'), kind: 'file' }] },
      timeoutMs: 0,
    });
    f.clock.advance(6000);
    await f.service.sweep();
    const expiry = events.find(
      e =>
        e.event === 'session.disconnected' &&
        e.fields.identityId === (f.a.session as { identityId: string }).identityId,
    )!;
    assert.equal(expiry.fields.reason, 'heartbeat_expired');
    assert.equal(expiry.fields.heartbeatAgeMs, 6000);
    assert.equal(expiry.fields.instanceTimeoutMs, 5000);
    assert.equal(expiry.fields.affectedReservationCount, 1);
    assert.equal(
      events.find(e => e.event === 'reservation.expired')?.fields.reason,
      'session_lost',
    );
    await assert.rejects(f.service.heartbeat(f.a.agentHandle), { code: 'SESSION_EXPIRED' });
    assert.equal(events.filter(e => e.event === 'session.disconnected').length, 2);
  } finally {
    await f.close();
  }
});

test('uncertain native commit and rollback outcomes retain phase evidence without replay', async t => {
  const dir = await directory(t);
  for (const fault of ['commit', 'rollback'] as const) {
    const { events, emit } = capture();
    const store = await TursoStore.open(
      join(dir, `${fault}.db`),
      'CREATE TABLE test(value INTEGER); INSERT INTO test VALUES(0)',
      1,
    );
    const db = (store as unknown as { connections: Database[] }).connections[0]!;
    const transactionAsync = db.transactionAsync.bind(db);
    let calls = 0;
    const mocked = t.mock.method(
      db,
      'transactionAsync',
      (callback: (tx: Transaction) => Promise<unknown>) =>
        transactionAsync(async tx => {
          const exec = tx.exec.bind(tx);
          tx.exec = async (sql, options) => {
            if (fault === 'commit' && sql.trim().toUpperCase() === 'COMMIT') {
              await exec(sql, options);
              throw Error('NATIVE_COMMIT_SECRET');
            }
            if (fault === 'rollback' && sql.trim().toUpperCase() === 'ROLLBACK')
              throw Error('NATIVE_ROLLBACK_SECRET');
            return exec(sql, options);
          };
          return callback(tx);
        }),
    );
    try {
      await assert.rejects(
        withDiagnostics(emit, { ipcRequestId: fault }, () =>
          store.write(async tx => {
            calls++;
            await tx.run('UPDATE test SET value=1');
            if (fault === 'rollback') throw Error('CALLBACK_SECRET');
          }),
        ),
        { code: 'OUTCOME_UNKNOWN' },
      );
      assert.equal(calls, 1);
      const failure = events.find(e => e.event === 'storage.failed')!;
      assert.equal(failure.fields.code, 'OUTCOME_UNKNOWN');
      assert.ok((failure.fields.phasesMs as DiagnosticFields)[fault] !== undefined);
      const attempt = events.find(e => e.event === 'storage.attempt_failed')!;
      assert.equal(attempt.fields.commitFailed, fault === 'commit');
      assert.equal(attempt.fields.rollbackConfirmed, false);
      assert.equal(attempt.fields.commitUnresolved, fault === 'commit');
      assert.equal(attempt.fields.rollbackUnresolved, fault === 'rollback');
      assert.doesNotMatch(JSON.stringify(events), /SECRET/);
      mocked.mock.restore();
      if (fault === 'commit')
        assert.deepEqual(await store.read(tx => tx.get('SELECT value FROM test')), { value: 1 });
    } finally {
      mocked.mock.restore();
      await store.close();
    }
  }
});
