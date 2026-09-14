import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { connect, nativeIdentity } from '../../src/storage/native.js';
import type { NativeDatabase } from '@tursodatabase/database-common';

assert.equal(typeof global.gc, 'function');
assert.equal(nativeIdentity(), '0.7.2-bassfish.1');
const db = await connect(':memory:');
try {
  const live = await db.prepare('SELECT 42 AS value');
  const native = (db as unknown as { native: NativeDatabase }).native;
  const rawLive = native.prepare('SELECT 43 AS value');
  for (let index = 0; index < 10_000; index++) {
    const stmt = await db.prepare('SELECT 1');
    await stmt.get();
    stmt.close();
    if (index % 128 === 0) {
      global.gc!();
      await yieldTurn();
    }
  }
  global.gc!();
  await yieldTurn();
  const stats = db.registryStats();
  assert.equal(stats.prepareCount, 10_002);
  assert.equal(stats.pruneCount, Math.floor(10_002 / 256));
  assert.ok(
    stats.retainedReferences < 512,
    `dead references retained: ${stats.retainedReferences}`,
  );
  assert.deepEqual(await live.get(), { value: 42 });
  assert.equal(rawLive.stepSync(), 1);
  assert.deepEqual(rawLive.row(), { value: 43 });
  await db.close();
  assert.throws(() => rawLive.stepSync(), /statement has been finalized/);
  await assert.rejects(live.get(), /closed|open|finalized/);
  process.stdout.write(JSON.stringify(stats) + '\n');
} finally {
  await db.close();
}
