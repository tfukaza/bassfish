import { chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A breaking release must not package compiled modules removed from src.
const root = new URL('../', import.meta.url);
await rm(new URL('dist/', root), { recursive: true, force: true });
const result = spawnSync(
  fileURLToPath(new URL('node_modules/.bin/tsc', root)),
  ['-p', 'tsconfig.build.json'],
  {
    cwd: fileURLToPath(root),
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status === 0) {
  await chmod(new URL('dist/cli.js', root), 0o755);
  const native = spawnSync(
    process.execPath,
    [
      'scripts/native-package.mjs',
      ...(process.argv.includes('--release') || process.env.BASSFISH_RELEASE_BUILD === '1'
        ? ['--release']
        : []),
    ],
    { cwd: fileURLToPath(root), stdio: 'inherit' },
  );
  if (native.error) throw native.error;
  if (native.status !== 0) process.exit(native.status ?? 1);
}
process.exitCode = result.status ?? 1;
