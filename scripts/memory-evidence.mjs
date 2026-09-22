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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Theil-Sen: the median pairwise slope, which ignores oscillation and tolerates outliers. */
function trendBytesPerSample(values) {
  const slopes = [];
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++) slopes.push((values[j] - values[i]) / (j - i));
  return median(slopes);
}

/**
 * Connection recycling makes daemon RSS sawtooth by tens of MiB, so an extreme measured
 * against whichever sample opens the window reports amplitude rather than growth, and the
 * boundary it happens to land on decides whether a healthy run passes. Fit a robust trend
 * instead and report the drift it projects across the window: oscillation of any phase or
 * amplitude contributes no slope, while a genuine leak does.
 */
export function measureMemoryWindow(samples, label, ceilingBytes = 512 * MiB) {
  assert.ok(samples.length >= 4, `${label}: too few memory samples`);
  for (const sample of samples)
    assert.ok(sample.physicalBytes < ceilingBytes, `${label}: memory safety ceiling exceeded`);
  const bytes = samples.map(s => s.physicalBytes);
  return {
    growthBytes: trendBytesPerSample(bytes) * (bytes.length - 1),
    samples: samples.length,
    finalBytes: samples.at(-1).physicalBytes,
  };
}

/** Gate on the measured trend. Only meaningful once the window is past daemon warm-up. */
export function verifyMemoryWindow(samples, label, ceilingBytes = 512 * MiB) {
  const result = measureMemoryWindow(samples, label, ceilingBytes);
  assert.ok(
    result.growthBytes < 32 * MiB,
    `${label}: final-window memory trend ${(result.growthBytes / MiB).toFixed(2)} MiB exceeds 32 MiB`,
  );
  return result;
}
