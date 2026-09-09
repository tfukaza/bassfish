import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireSupportedPlatform } from '../src/storage/platform.js';

test('published native targets define the supported platforms', () => {
  assert.doesNotThrow(() => requireSupportedPlatform('darwin', 'arm64', undefined));
  assert.doesNotThrow(() => requireSupportedPlatform('linux', 'x64', '2.39'));
  assert.doesNotThrow(() => requireSupportedPlatform('linux', 'arm64', '2.39'));
  assert.throws(() => requireSupportedPlatform('darwin', 'x64', undefined), /Intel Mac/);
  assert.throws(() => requireSupportedPlatform('linux', 'x64', undefined), /musl Linux/);
  assert.throws(() => requireSupportedPlatform('win32', 'x64', undefined), /Windows/);
});
