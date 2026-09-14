// A test-only daemon entry point with an IPC GC checkpoint; no public command changes.
import assert from 'node:assert/strict';
import { runDaemon } from '../dist/daemon.js';
import { collectRetainedMemory } from './memory-evidence.mjs';

assert.equal(typeof global.gc, 'function');
await runDaemon(process.argv[2]);
process.on('message', async message => {
  if (message.gc) {
    process.send({ gc: true, memory: await collectRetainedMemory() });
  }
});
process.on('disconnect', () => process.emit('SIGTERM'));
process.send({ ready: true });
process.channel.unref();
