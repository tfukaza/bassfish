import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BassfishError } from '../src/domain.js';
import {
  DOLT_VERSION,
  managedDoltBinary,
  normalizedArchitecture,
  setupDolt,
  verifyDoltArchive,
} from '../src/setup.js';

async function fakeDolt(path: string, version = DOLT_VERSION): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "dolt version ${version}"\n`);
  await chmod(path, 0o755);
}

test('managed Dolt paths are versioned and normalize x64', () => {
  assert.equal(
    managedDoltBinary('/data', 'linux', 'x64'),
    `/data/tools/dolt/${DOLT_VERSION}/linux-amd64/bin/dolt`,
  );
  assert.equal(normalizedArchitecture('arm64'), 'arm64');
});

test('setup accepts an explicit exact-version Dolt and rejects other versions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'external-dolt');
  await fakeDolt(binary);
  assert.deepEqual(await setupDolt(join(dir, 'data'), { overrideBinary: binary }), {
    version: DOLT_VERSION,
    path: binary,
    source: 'override',
    installed: false,
  });
  await fakeDolt(binary, '2.3.1');
  await assert.rejects(
    setupDolt(join(dir, 'data'), { overrideBinary: binary }),
    (error: unknown) => error instanceof BassfishError && error.code === 'DOLT_VERSION',
  );
});

test('setup is idempotent when the managed binary is already valid', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = managedDoltBinary(dir);
  await fakeDolt(binary);
  let fetched = false;
  const result = await setupDolt(dir, {
    overrideBinary: null,
    fetcher: async () => {
      fetched = true;
      throw new Error('unexpected fetch');
    },
  });
  assert.equal(result.installed, false);
  assert.equal(result.path, binary);
  assert.equal(fetched, false);
});

test('a checksum failure leaves no managed installation or temporary directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const response = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  await assert.rejects(
    setupDolt(dir, { overrideBinary: null, fetcher: async () => response }),
    (error: unknown) => error instanceof BassfishError && error.code === 'DOLT_CHECKSUM',
  );
  const parent = join(dir, 'tools', 'dolt', DOLT_VERSION);
  assert.deepEqual(await readdir(parent), []);
});

test('unknown archives fail closed', () => {
  assert.throws(
    () => verifyDoltArchive('unknown.tar.gz', new Uint8Array()),
    (error: unknown) => error instanceof BassfishError && error.code === 'UNSUPPORTED_PLATFORM',
  );
});
