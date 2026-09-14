// A test-only daemon entry point with an IPC GC checkpoint; no public command changes.
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { runDaemon } from '../dist/daemon.js';

assert.equal(typeof global.gc, 'function');
await runDaemon(process.argv[2]);
process.on('message', async message => {
  if (message.gc) {
    global.gc();
    await yieldTurn();
    global.gc();
    await yieldTurn();
    process.send({ gc: true, memory: process.memoryUsage() });
  }
});
process.on('disconnect', () => process.emit('SIGTERM'));
process.send({ ready: true });
process.channel.unref();
