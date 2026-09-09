import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoControl } from '../dist/storage/coordination.js';
import { TursoContent } from '../dist/storage/content.js';
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
let content, control;
let operations = 0;
const startedAt = Date.now();
try {
  control = await TursoControl.open(join(root, 'bassfish.db'));
  content = new TursoContent(control.store);
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
  await control.activity.publish();
  const snapshot = await content.snapshot(alice.session.projectId, threadId, 1);
  if (snapshot.thread.headSequence !== String(operations))
    throw new Error('Missing committed messages after soak.');
  await control.store.read(async tx => {
    const violations = await tx.all('PRAGMA foreign_key_check');
    if (violations.length) throw new Error('Foreign-key violations after soak.');
    const pending = await tx.get('SELECT COUNT(*) AS count FROM activityOutbox');
    if (pending.count) throw new Error('Activity outbox did not drain.');
  });
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
  await control?.close();
  await rm(root, { recursive: true, force: true });
}
