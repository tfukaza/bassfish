// A test-only daemon entry point with an IPC GC checkpoint; no public command changes.
import assert from 'node:assert/strict';
import { runDaemon } from '../dist/daemon.js';
import { collectRetainedMemory } from './memory-evidence.mjs';

assert.equal(typeof global.gc, 'function');
const store = await runDaemon(process.argv[2]);
let releaseCheckpoint;
process.on('message', async message => {
  if (message.resume) releaseCheckpoint?.();
  if (message.gc) {
    assert.equal(releaseCheckpoint, undefined, 'overlapping memory checkpoints');
    let release;
    const resumed = new Promise(resolve => (release = resolve));
    releaseCheckpoint = release;
    let arrived = 0;
    let ready;
    const occupied = new Promise(resolve => (ready = resolve));
    const count = store.diagnostics().connections.length;
    // Lease every existing connection through the normal FIFO. Work drains before
    // sampling, and subsequent work waits until the parent finishes footprint capture.
    const leases = Promise.all(
      Array.from({ length: count }, () =>
        store.read(async () => {
          if (++arrived === count) ready();
          await resumed;
        }),
      ),
    );
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('storage checkpoint did not settle')), 10_000);
    });
    try {
      await Promise.race([occupied, leases, deadline]);
      assert.equal(arrived, count);
      const storage = store.diagnostics();
      assert.equal(storage.active, count);
      assert.equal(storage.openConnections, count);
      assert.equal(storage.replacementsPending, 0);
      process.send({ gc: true, memory: await collectRetainedMemory(), connections: count });
      await Promise.race([resumed, deadline]);
    } catch (error) {
      process.send({ gc: false, error: String(error) });
    } finally {
      release();
      clearTimeout(timer);
      await leases;
      releaseCheckpoint = undefined;
    }
  }
});
process.on('disconnect', () => {
  releaseCheckpoint?.();
  process.emit('SIGTERM');
});
process.send({ ready: true });
process.channel.unref();
