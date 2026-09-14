import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'native/turso/source.json'), 'utf8'));
const hash = async path =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const release = process.argv.includes('--release');
const host = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
const platforms = release ? Object.keys(config.targets) : [host];
const output = join(root, 'dist/native');
await mkdir(output, { recursive: true });
const artifacts = {};
for (const platform of platforms) {
  const path = join(root, 'native/turso/artifacts');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(path, `${platform}.json`), 'utf8'));
  } catch (error) {
    throw new Error(
      `Missing ${platform} patched binary. Run npm run native:build or download CI native artifacts.`,
      { cause: error },
    );
  }
  const binary = `turso.${platform}.node`;
  for (const key of [
    'identity',
    'revision',
    'toolchain',
    'profile',
    'cargoLockSha256',
    'toolchainSha256',
    'sourceSha256',
  ])
    if (metadata[key] !== config[key])
      throw new Error(`Native metadata mismatch: ${platform} ${key}`);
  if (
    metadata.platform !== platform ||
    metadata.target !== config.targets[platform] ||
    metadata.binary !== binary
  )
    throw new Error(`Native target mismatch: ${platform}`);
  if (metadata.patchSha256 !== (await hash(join(root, 'native/turso/statement-registry.patch'))))
    throw new Error(`Native patch mismatch: ${platform}`);
  if (metadata.sha256 !== (await hash(join(path, binary))))
    throw new Error(`Native hash mismatch: ${platform}`);
  await copyFile(join(path, binary), join(output, binary));
  artifacts[platform] = metadata;
}
await copyFile(join(root, 'native/turso/LICENSE.md'), join(output, 'LICENSE.md'));
await copyFile(
  join(root, 'native/turso/statement-registry.patch'),
  join(output, 'statement-registry.patch'),
);
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify({ identity: config.identity, release, artifacts }, null, 2) + '\n',
);
