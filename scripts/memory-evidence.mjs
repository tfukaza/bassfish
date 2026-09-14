import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setImmediate as yieldTurn } from 'node:timers/promises';

const exec = promisify(execFile);
export const MiB = 1048576;
/** Complete native weak finalizers at a clean stack boundary before retained-memory sampling. */
export async function collectRetainedMemory() {
  assert.equal(typeof global.gc, 'function', 'memory qualification requires --expose-gc');
  for (let i = 0; i < 2; i++) {
    await global.gc({ type: 'major', execution: 'async', flavor: 'last-resort' });
    await yieldTurn();
  }
  return process.memoryUsage();
}

export async function processMemory(pid) {
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(join(tmpdir(), 'bf-footprint-'));
    try {
      const path = join(dir, 'footprint.json');
      await exec(
        '/usr/bin/footprint',
        ['-p', String(pid), '-f', 'bytes', '--swapped', '--noCategories', '-j', path],
        { timeout: 10_000 },
      );
      const report = JSON.parse(await readFile(path, 'utf8'));
      const target = report.processes.find(p => p.pid === pid);
      assert.ok(target?.auxiliary?.phys_footprint > 0, 'physical footprint unavailable');
      return {
        physicalBytes: target.auxiliary.phys_footprint,
        swappedBytes: report.summary.total.swapped,
        metric: 'macOS phys_footprint (includes compressed/swapped accounting)',
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const bytes = name =>
    Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0) * 1024;
  return {
    physicalBytes: bytes('VmRSS') + bytes('VmSwap'),
    swappedBytes: bytes('VmSwap'),
    metric: 'Linux VmRSS + VmSwap',
  };
}

export function verifyMemoryWindow(samples, label, ceilingBytes = 512 * MiB) {
  assert.ok(samples.length >= 4, `${label}: too few memory samples`);
  for (const sample of samples)
    assert.ok(sample.physicalBytes < ceilingBytes, `${label}: memory safety ceiling exceeded`);
  const growthBytes = Math.max(...samples.map(s => s.physicalBytes)) - samples[0].physicalBytes;
  assert.ok(
    growthBytes < 32 * MiB,
    `${label}: final-window memory growth ${(growthBytes / MiB).toFixed(2)} MiB exceeds 32 MiB`,
  );
  return { growthBytes, samples: samples.length, finalBytes: samples.at(-1).physicalBytes };
}
