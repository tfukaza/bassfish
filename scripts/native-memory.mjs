import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { processMemory, verifyMemoryWindow, MiB } from './memory-evidence.mjs';

const selected = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
const modes = ['patched-only', 'official-recycling', 'patched-recycling', 'official-only'];
if (selected && !modes.includes(selected)) throw new Error('Unknown memory regression mode');
for (const mode of selected ? [selected] : modes.slice(0, 3)) {
  const child = fork(fileURLToPath(new URL('native-memory-worker.mjs', import.meta.url)), [mode], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const samples = { reads: [], updates: [] };
  const allSamples = [];
  let completed, failure;
  let shutdownTimeout;
  const timeout = setTimeout(() => {
    failure = new Error('memory regression timed out');
    child.kill('SIGKILL');
  }, 10 * 60_000);
  child.on('message', async message => {
    if (message.closing) {
      shutdownTimeout = setTimeout(() => {
        failure = new Error('shutdown exceeded 10 seconds');
        child.kill('SIGKILL');
      }, 10_000);
      return;
    }
    if (message.done) {
      clearTimeout(shutdownTimeout);
      completed = message;
      return;
    }
    try {
      const sample = { ...(await processMemory(child.pid)), operations: message.operations };
      assert.ok(
        sample.physicalBytes < 512 * MiB,
        `${mode}: physical memory safety ceiling exceeded`,
      );
      allSamples.push({
        ...sample,
        phase: message.phase,
        rssBytes: message.memory.rss,
        heapUsedBytes: message.memory.heapUsed,
      });
      if (message.operations >= 80_000) samples[message.phase].push(sample);
      child.send({ resume: true });
    } catch (error) {
      failure = error;
      child.kill('SIGKILL');
    }
  });
  try {
    const [code] = await once(child, 'exit');
    if (failure) throw failure;
    assert.equal(code, 0, `${mode} child failed`);
    assert.ok(completed, `${mode} child did not complete`);
    process.stdout.write(
      JSON.stringify({
        ...completed,
        reads:
          mode === 'official-only'
            ? samples.reads
            : verifyMemoryWindow(samples.reads, `${mode} reads`),
        updates:
          mode === 'official-only'
            ? samples.updates
            : verifyMemoryWindow(samples.updates, `${mode} updates`),
        ...(mode === 'official-only' ? { reproductionSamples: allSamples } : {}),
      }) + '\n',
    );
  } finally {
    clearTimeout(timeout);
    clearTimeout(shutdownTimeout);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
