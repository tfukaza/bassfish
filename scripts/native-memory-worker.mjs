import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { TursoStore } from '../dist/storage/turso.js';
import { connect as officialConnect } from '@tursodatabase/database';
import { collectRetainedMemory } from './memory-evidence.mjs';

assert.equal(typeof global.gc, 'function', 'memory qualification requires --expose-gc');
const mode = process.argv[2];
const official = mode.startsWith('official-');
const recycling = mode.endsWith('-recycling');
const dir = await mkdtemp(join(tmpdir(), 'bf-native-memory-'));
const path = join(dir, 'bassfish.db');
let store;
const checkpoint = async (phase, operations) => {
  const memory = await collectRetainedMemory();
  const diagnostics = store.diagnostics();
  for (const slot of diagnostics.connections) {
    if (recycling) assert.ok(slot.prepares < 4096 + 256, 'prepare count not bounded');
    if (!official && slot.registry)
      assert.ok(
        slot.registry.retainedReferences <= 256 + 2048,
        `registry is unbounded: ${slot.registry.retainedReferences}`,
      );
  }
  assert.ok(process.memoryUsage().rss < 512 * 1048576, 'RSS safety ceiling exceeded');
  process.send({ phase, operations, memory, diagnostics });
  await new Promise(resolve => process.once('message', resolve));
};
try {
  store = await TursoStore.open(
    path,
    "CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL, payload TEXT NOT NULL); INSERT INTO counter VALUES(1,0,'fixed-size-data');",
    1,
    {
      prepareLimit: recycling ? 4096 : Infinity,
      ...(official ? { connect: officialConnect, bindingIdentity: 'official-0.7.2' } : {}),
    },
  );
  for (const phase of ['reads', 'updates']) {
    for (let offset = 0; offset < 100_000; offset += 256) {
      const count = Math.min(256, 100_000 - offset);
      await store[phase === 'reads' ? 'read' : 'write'](async tx => {
        for (let i = 0; i < count; i++) {
          if (phase === 'reads')
            assert.deepEqual(await tx.get('SELECT n,payload FROM counter WHERE id=1'), {
              n: 0,
              payload: 'fixed-size-data',
            });
          else assert.equal(await tx.run('UPDATE counter SET n=n+1 WHERE id=1'), 1);
        }
      });
      if ((offset + count) % 2048 === 0 || offset + count === 100_000)
        await checkpoint(phase, offset + count);
      else await yieldTurn();
    }
  }
  const generations = store.diagnostics().replacementSuccesses;
  if (recycling) assert.ok(generations >= 40, `not enough recycling cycles: ${generations}`);
  const started = performance.now();
  process.send({ closing: true });
  await store.close();
  assert.ok(performance.now() - started < 10_000, 'shutdown exceeded 10 seconds');
  store = await TursoStore.open(
    path,
    '',
    1,
    official ? { connect: officialConnect, bindingIdentity: 'official-0.7.2' } : {},
  );
  assert.deepEqual(await store.read(tx => tx.get('SELECT n,payload FROM counter WHERE id=1')), {
    n: 100_000,
    payload: 'fixed-size-data',
  });
  assert.deepEqual(await store.read(tx => tx.get('SELECT COUNT(*) AS count FROM counter')), {
    count: 1,
  });
  await store.close();
  process.send({ done: true, mode, generations, shutdownMs: performance.now() - started });
} finally {
  await store?.close();
  await rm(dir, { recursive: true, force: true });
  process.disconnect();
}
