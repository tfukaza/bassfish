import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepository } from '../src/repository.js';
import { errorCode } from './support.js';
const exec = promisify(execFile);
test('worktrees and symlinks share canonical project identity; clones and nonrepos do not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-git-'));
  t.after(async () => await rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'),
    tree = join(dir, 'tree'),
    clone = join(dir, 'clone'),
    link = join(dir, 'link');
  await exec('git', ['init', repo]);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  await exec('git', ['-C', repo, 'worktree', 'add', tree, '-b', 'linked']);
  await exec('git', ['clone', repo, clone]);
  await symlink(repo, link);
  const key = await resolveRepository(repo);
  assert.equal(await resolveRepository(tree), key);
  assert.equal(await resolveRepository(link), key);
  assert.notEqual(await resolveRepository(clone), key);
  await assert.rejects(resolveRepository(dir), errorCode('NOT_A_REPOSITORY'));
});
