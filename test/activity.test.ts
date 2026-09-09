import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TursoControl } from '../src/storage/coordination.js';
import type { TursoTransaction } from '../src/storage/turso.js';

async function enqueue(tx: TursoTransaction, kind: string, at = Date.now()) {
  const id = randomUUID();
  await tx.run(
    'INSERT INTO activityOutbox(id,batchId,position,projectId,at,eventJson) VALUES(?,?,?,?,?,?)',
    id,
    ...tx.outboxOrder(),
    'p',
    at,
    JSON.stringify({
      id,
      projectId: 'p',
      at,
      kind,
      resourceType: 'thread',
      resourceId: 'r',
      details: {},
    }),
  );
}

test('outbox publication follows committed visibility, preserves transaction order, and drains on reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bassfish.db');
  const control = await TursoControl.open(path);
  t.after(() => control.close());
  let resume!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => {
    resume = resolve;
  });
  const ready = new Promise<void>(resolve => {
    arrived = resolve;
  });
  const early = control.store.write(async tx => {
    await enqueue(tx, 'early.one');
    await enqueue(tx, 'early.two');
    arrived();
    await gate;
  });
  await ready;
  await control.store.write(tx => enqueue(tx, 'late'));
  await control.activity.publish();
  const first = await control.activity.head();
  assert.deepEqual(
    (await control.activity.page({ projectId: 'p' })).events.map(e => e.kind),
    ['late'],
  );
  resume();
  await early;
  await control.close();
  const reopened = await TursoControl.open(path);
  t.after(() => reopened.close());
  const page = await reopened.activity.page({ projectId: 'p' });
  assert.deepEqual(
    page.events.map(e => e.kind),
    ['early.two', 'early.one', 'late'],
  );
  assert.ok(BigInt(page.events[1]!.cursor) > BigInt(first));
  const head = await reopened.activity.head();
  await reopened.activity.publish();
  assert.equal(await reopened.activity.head(), head);
  await reopened.store.write(tx => enqueue(tx, 'expired', Date.now() - 8 * 86400000));
  await reopened.activity.publish();
  assert.equal(
    (await reopened.activity.page({ projectId: 'p' })).events.some(e => e.kind === 'expired'),
    false,
  );
  assert.equal(await reopened.activity.gap('p', '0'), true);
});
