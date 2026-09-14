import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'native/turso/source.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
const target = config.targets[platform];
if (!target) throw new Error(`No native build target for ${platform}`);
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime)
  throw new Error('Native release builds require glibc.');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
const hash = async path =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const work = join(root, '.tmp/native-build');
const source = join(work, config.revision);
await mkdir(work, { recursive: true });
const archive = join(work, 'source.tar.gz');
const patch = join(root, 'native/turso/statement-registry.patch');
const patchSha256 = await hash(patch);
let archiveValid = false;
try {
  archiveValid = (await hash(archive)) === config.sourceSha256;
} catch {
  /* first build */
}
if (!archiveValid) {
  run('curl', [
    '-fL',
    `https://codeload.github.com/tursodatabase/turso/tar.gz/${config.revision}`,
    '-o',
    archive,
  ]);
}
if ((await hash(archive)) !== config.sourceSha256) throw new Error('Source archive hash mismatch');
const cargoTarget = join(work, 'target');
// Move the original development cache once; subsequent builds keep it outside source.
try {
  await rename(join(source, 'target'), cargoTarget);
} catch (error) {
  if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
}
// Always restore verified source. A cache marker must not bless local source edits.
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
run('tar', ['-xzf', archive, '-C', source, '--strip-components=1']);
run('git', ['apply', '--check', patch], source);
run('git', ['apply', patch], source);
process.env.CARGO_TARGET_DIR = cargoTarget;
if ((await hash(join(source, 'Cargo.lock'))) !== config.cargoLockSha256)
  throw new Error('Upstream Cargo.lock hash mismatch');
if ((await hash(join(source, 'rust-toolchain.toml'))) !== config.toolchainSha256)
  throw new Error('Upstream toolchain hash mismatch');
run('rustup', ['toolchain', 'install', config.toolchain, '--profile', 'minimal']);
const rustc = spawnSync('rustup', ['which', '--toolchain', config.toolchain, 'rustc'], {
  encoding: 'utf8',
});
if (rustc.status !== 0) throw new Error('Pinned Rust compiler unavailable');
process.env.PATH = `${dirname(rustc.stdout.trim())}${delimiter}${process.env.PATH}`;
run(
  'rustup',
  [
    'run',
    config.toolchain,
    'cargo',
    'test',
    '--locked',
    '-p',
    'turso_node',
    '--lib',
    'registry_prunes_dead_handles',
  ],
  source,
);
run(
  'rustup',
  [
    'run',
    config.toolchain,
    'cargo',
    'build',
    '--locked',
    '-p',
    'turso_node',
    '--profile',
    config.profile,
    '--target',
    target,
  ],
  source,
);
const output = join(root, 'native/turso/artifacts');
await mkdir(output, { recursive: true });
const binary = `turso.${platform}.node`;
const version = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect ${command} build version`);
  return result.stdout.trim();
};
await copyFile(
  join(
    cargoTarget,
    target,
    config.profile,
    process.platform === 'darwin' ? 'libturso_node.dylib' : 'libturso_node.so',
  ),
  join(output, binary),
);
await writeFile(
  join(output, `${platform}.json`),
  JSON.stringify(
    {
      ...config,
      platform,
      target,
      binary,
      sha256: await hash(join(output, binary)),
      patchSha256,
      builtAt: new Date().toISOString(),
      build: {
        rustVersion: version('rustc', ['--version']),
        compilerVersion: version('cc', ['--version']),
        kernelRelease: release(),
        nodeVersion: process.versions.node,
        glibcVersion:
          process.platform === 'linux'
            ? process.report.getReport().header.glibcVersionRuntime
            : null,
        napiVersion: 6,
      },
    },
    null,
    2,
  ) + '\n',
);
