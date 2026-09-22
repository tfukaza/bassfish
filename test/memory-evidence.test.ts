import test from 'node:test';
import assert from 'node:assert/strict';
import { MiB, measureMemoryWindow, verifyMemoryWindow } from '../scripts/memory-evidence.mjs';

const window = (values: number[]) => values.map(physicalBytes => ({ physicalBytes }));
const ramp = (start: number, totalGrowth: number, count = 10) =>
  window(Array.from({ length: count }, (_, i) => (start + (totalGrowth * i) / (count - 1)) * MiB));
const trendMiB = (samples: { physicalBytes: number }[]) =>
  verifyMemoryWindow(samples, 'probe', Infinity).growthBytes / MiB;

test('memory trend ignores recycling oscillation regardless of its phase or amplitude', () => {
  const phases: [number, number][] = [
    [20, -20],
    [-20, 20],
    [64, -64],
  ];
  for (const [high, low] of phases)
    assert.equal(
      trendMiB(window(Array.from({ length: 10 }, (_, i) => (200 + (i % 2 ? high : low)) * MiB))),
      0,
      'a pure sawtooth must contribute no trend',
    );
  assert.equal(trendMiB(window(Array.from({ length: 10 }, () => 200 * MiB))), 0);
  // A single depressed sample at the window boundary previously set the baseline for the run.
  assert.equal(
    trendMiB(window([150 * MiB, ...Array.from({ length: 9 }, () => 205 * MiB)])),
    0,
    'one outlier must not establish the baseline',
  );
});

test('memory trend reports the drift a real leak projects across the window', () => {
  // Drift under the bound is reported exactly, so evidence records the real number.
  assert.equal(trendMiB(ramp(180, 18)), 18);
  assert.equal(trendMiB(ramp(180, 30)), 30);
  for (const growth of [36, 54])
    assert.throws(() => verifyMemoryWindow(ramp(180, growth), 'daemon soak', Infinity), {
      message: new RegExp(`daemon soak: final-window memory trend ${growth}\\.00 MiB exceeds 32`),
    });
  // A leak must still be found, at its true magnitude, under heavy recycling oscillation.
  const buried = Array.from(
    { length: 10 },
    (_, i) => (180 + (40 * i) / 9 + (i % 2 ? 15 : -15)) * MiB,
  );
  assert.throws(() => verifyMemoryWindow(window(buried), 'daemon soak', Infinity), {
    message: /daemon soak: final-window memory trend 40\.00 MiB exceeds 32/,
  });
});

test('memory window still enforces the absolute ceiling and a minimum sample count', () => {
  assert.throws(() => verifyMemoryWindow(window([1, 2, 3].map(n => n * MiB)), 'short'), {
    message: /short: too few memory samples/,
  });
  assert.throws(() => verifyMemoryWindow(ramp(600, 0), 'huge', 512 * MiB), {
    message: /huge: memory safety ceiling exceeded/,
  });
});

test('the real sample window that failed release qualification now passes', () => {
  // Verbatim final-window RSS from qualify (ubuntu-24.04-arm) on 3e7cfc7, which the previous
  // extreme-based check rejected at 32.34 MiB while the same commit passed in ci.yml.
  const observed = window([
    181800960, 203784192, 206270464, 212447232, 213073920, 208420864, 208982016, 214355968,
    211259392, 215711744,
  ]);
  const result = verifyMemoryWindow(observed, 'daemon soak', Infinity);
  assert.ok(result.growthBytes < 32 * MiB, 'observed healthy run must pass');
  assert.ok(result.growthBytes / MiB < 16, 'and must keep meaningful headroom');
});

test('measurement reports the same trend the gate uses, without gating on it', () => {
  // A short soak window is still daemon warm-up, so the release smoke run records drift
  // instead of failing on it; the nightly full-length soak keeps the assertion.
  const healthy = ramp(180, 18);
  assert.equal(measureMemoryWindow(healthy, 'probe', Infinity).growthBytes, 18 * MiB);
  assert.equal(
    measureMemoryWindow(healthy, 'probe', Infinity).growthBytes,
    verifyMemoryWindow(healthy, 'probe', Infinity).growthBytes,
  );
  const drifting = ramp(180, 54);
  assert.throws(() => verifyMemoryWindow(drifting, 'daemon soak', Infinity), /exceeds 32 MiB/);
  assert.equal(
    measureMemoryWindow(drifting, 'daemon soak', Infinity).growthBytes,
    54 * MiB,
    'measurement must report drift the gate would reject',
  );
  // Structural problems still fail, because they are not a function of window length.
  assert.throws(() => measureMemoryWindow(window([1, 2, 3].map(n => n * MiB)), 'short'), {
    message: /short: too few memory samples/,
  });
  assert.throws(() => measureMemoryWindow(ramp(600, 0), 'huge', 512 * MiB), {
    message: /huge: memory safety ceiling exceeded/,
  });
});
