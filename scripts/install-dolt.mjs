import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const version = '2.3.2';
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const platform = process.platform;
if (!['darwin', 'linux'].includes(platform) || !['amd64', 'arm64'].includes(arch)) throw new Error('Use a macOS/Linux arm64/x64 environment, or provision Dolt 2.3.2 manually.');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)), '.tools');
const name = `dolt-${platform}-${arch}`, archiveName = `${name}.tar.gz`;
const target = join(root, name);
try { await stat(target); console.log(`Local Dolt already exists at ${target}. Startup verifies its version; nothing was overwritten.`); process.exit(0); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(root, { recursive: true });
const temporary = await mkdtemp(join(root, 'install-'));
try {
  const hashes = { 'dolt-darwin-arm64.tar.gz': 'b576072541393579980161e86ac8ff83a447eb3eb47a17d92968bf72be098cad' };
  let expected = hashes[archiveName];
  if (!expected) {
    const release = await fetch(`https://api.github.com/repos/dolthub/dolt/releases/tags/v${version}`, { signal: AbortSignal.timeout(30_000) });
    if (!release.ok) throw new Error(`Release metadata returned HTTP ${release.status}`);
    const asset = (await release.json()).assets.find(asset => asset.name === archiveName);
    if (!asset?.digest?.startsWith('sha256:')) throw new Error('Release asset has no SHA-256 digest. Refusing unverified installation.');
    expected = asset.digest.slice(7);
  }
  let archive;
  try { archive = await readFile(join(root, archiveName)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://github.com/dolthub/dolt/releases/download/v${version}/${archiveName}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download returned HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Dolt checksum mismatch. Nothing was installed.');
  const archivePath = join(temporary, archiveName); await writeFile(archivePath, archive);
  await promisify(execFile)('tar', ['-xzf', archivePath, '-C', temporary]);
  await rename(join(temporary, name), target);
  console.log(`Installed checksum-verified Dolt ${version} at ${join(target, 'bin/dolt')}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
