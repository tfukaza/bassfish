import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@bassfish/cli', 'release package name changed unexpectedly');
assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, `release tag must be v${pkg.version}`);
process.stdout.write(
  `Release tag ${process.env.GITHUB_REF_NAME} matches ${pkg.name}@${pkg.version}.\n`,
);
