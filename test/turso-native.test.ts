import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadBinding } from '../src/storage/native.js';

test('patched native registry prunes expired handles and preserves live statements through close', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      'tsx',
      fileURLToPath(new URL('fixtures/native-registry.ts', import.meta.url)),
    ],
    { timeout: 30_000 },
  );
  assert.ok(JSON.parse(stdout).retainedReferences < 512);
});

test('loader rejects missing, incompatible and hash-mismatched artifacts with no dependency fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-native-loader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = pathToFileURL(dir + '/');
  assert.throws(() => loadBinding(url), { code: 'STORAGE_UNAVAILABLE' });
  const platform = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  const binary = `turso.${platform}.node`;
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ identity: 'unpatched', artifacts: {} }),
  );
  assert.throws(() => loadBinding(url), { code: 'STORAGE_UNAVAILABLE' });
  await writeFile(join(dir, binary), 'corrupt native artifact');
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      identity: '0.7.2-bassfish.1',
      artifacts: {
        [platform]: {
          identity: '0.7.2-bassfish.1',
          revision: '046e9cbf67d22491e8ecc941ec2891b02a9f3cad',
          binary,
          sha256: 'bad',
        },
      },
    }),
  );
  assert.throws(() => loadBinding(url), { code: 'STORAGE_UNAVAILABLE' });
});
