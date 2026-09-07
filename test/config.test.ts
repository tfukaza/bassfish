import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRuntimeConfig, parseTurnTimeout, runtimeConfigSchema } from '../src/config.js';
import { BassfishError } from '../src/domain.js';

test('turn timeout defaults to one minute with a clean configuration key', () => {
  assert.equal(defaultRuntimeConfig.turnTimeoutMs, 60_000);
  assert.equal(runtimeConfigSchema.safeParse({ leaseMs: 60_000 }).success, false);
});

test('daemon turn timeout accepts explicit millisecond, second, and minute durations', () => {
  assert.equal(parseTurnTimeout('30000ms'), 30_000);
  assert.equal(parseTurnTimeout('90s'), 90_000);
  assert.equal(parseTurnTimeout('1m'), 60_000);
  for (const value of ['30', '1.5m', '4s', '6m']) {
    assert.throws(() => parseTurnTimeout(value), (error: unknown) => error instanceof BassfishError && error.code === 'INVALID_ARGUMENT');
  }
});
