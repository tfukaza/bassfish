import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mysql from 'mysql2/promise';
import { startSql } from '../dist/supervisor.js';
import { doltBinary } from '../dist/config.js';
import { DoltContent } from '../dist/storage/dolt.js';
import { SqliteControl } from '../dist/storage/control.js';
import { Bassfish } from '../dist/service.js';
import { SystemClock } from '../dist/runtime.js';

const durationArg = process.argv.find(value => value.startsWith('--duration-ms='));
const durationMs = durationArg
  ? Number(durationArg.slice('--duration-ms='.length))
  : 30 * 60 * 1000;
if (!Number.isInteger(durationMs) || durationMs < 1000)
  throw new Error('--duration-ms must be an integer of at least 1000.');
const root = await mkdtemp(
  join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-soak-'),
);
let sql, content, control;
let operations = 0;
const startedAt = Date.now();
try {
  sql = await startSql(root, doltBinary());
  content = new DoltContent(sql.endpoint);
  control = new SqliteControl(join(root, 'control.sqlite'));
  const service = new Bassfish(control, content, new SystemClock(), { instanceMs: 300_000 }, root);
  await service.initialize();
  const alice = await service.open('/soak/.git', 'Alice'),
    bob = await service.open('/soak/.git', 'Bob');
  const thread = await service.call(alice.agentHandle, 'createThread', {
    title: 'Soak',
    description: 'qualification',
  });
  const threadId = thread.threadId;
  while (Date.now() - startedAt < durationMs) {
    const handle = operations % 2 ? alice.agentHandle : bob.agentHandle;
    const ticket = await service.call(handle, 'requestTurn', {
      target: { type: 'thread', id: threadId },
    });
    const turn = await service.call(handle, 'claimTurn', { offerId: ticket.offerId });
    await service.call(handle, 'commitTurn', {
      turn: { id: turn.turn.id, fencingToken: turn.turn.fencingToken },
      baseRevision: turn.snapshot.revision,
      mutation: { kind: 'appendMessage', body: `soak-${operations}` },
    });
    if (operations % 25 === 0) {
      const files = await service.callMcp(handle, 'acquireTurn', {
        target: { type: 'files', paths: [{ path: join(root, 'handoff.md'), kind: 'file' }] },
      });
      await writeFile(files.target.paths[0].path, `body ${operations}`);
      await service.callMcp(handle, 'releaseTurn', { turnToken: files.turnToken });
    }
    operations++;
  }
  const projectId = alice.session.projectId;
  const connection = await mysql.createConnection({
    ...sql.endpoint,
    user: 'root',
    database: projectId,
  });
  try {
    const [dirty] = await connection.query('SELECT * FROM dolt_status');
    if (dirty.length) throw new Error('Dolt working set is dirty after soak.');
  } finally {
    await connection.end();
  }
  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      durationMs: Date.now() - startedAt,
      operations,
      platform: `${process.platform}-${process.arch}`,
    }) + '\n',
  );
} finally {
  await content?.close();
  control?.close();
  await sql?.close();
  await rm(root, { recursive: true, force: true });
}
