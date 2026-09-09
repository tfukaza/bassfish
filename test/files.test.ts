import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bassfish } from '../src/service.js';
import { fileSetsOverlap, resolveFileTargets } from '../src/files.js';
import type { FileTarget, FileTurnRequest } from '../src/domain.js';
import { fixture, errorCode, hold } from './support.js';
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Claim = {
  state: string;
  requestToken: string;
  turnToken: string;
  lifetime: string;
  target: {
    type: 'files';
    paths: FileTarget[];
  };
};
const file = (path: string): FileTarget => ({ path, kind: 'file' });
const directory = (path: string): FileTarget => ({ path, kind: 'directory' });
const acquire = (f: Fixture, handle: string, paths: FileTarget[]) =>
  f.service.callMcp(handle, 'acquireTurn', {
    target: { type: 'files', paths },
    timeoutMs: 0,
  }) as Promise<Claim>;
const resume = (f: Fixture, handle: string, requestToken: string) =>
  f.service.callMcp(handle, 'acquireTurn', { requestToken, timeoutMs: 0 }) as Promise<Claim>;
const release = (f: Fixture, handle: string, turnToken: string) =>
  f.service.callMcp(handle, 'releaseTurn', { turnToken });
test('file overlap is symmetric for parent directories without matching path prefixes', () => {
  const parent = [directory('/repo/src')];
  const childFile = [file('/repo/src/lib/component.ts')];
  const childDirectory = [directory('/repo/src/lib')];
  assert.equal(fileSetsOverlap(parent, childFile), true);
  assert.equal(fileSetsOverlap(childFile, parent), true);
  assert.equal(fileSetsOverlap(parent, childDirectory), true);
  assert.equal(fileSetsOverlap(childDirectory, parent), true);
  assert.equal(fileSetsOverlap([file('/repo/src/index.ts')], [file('/repo/src/index.ts')]), true);
  assert.equal(fileSetsOverlap(parent, [file('/repo/src-old/component.ts')]), false);
  assert.equal(fileSetsOverlap([directory('/repo/src/a')], [directory('/repo/src/b')]), false);
});
test('a held parent directory queues descendant targets until release', async t => {
  const f = await fixture();
  t.after(f.close);
  const parent = await acquire(f, f.a.agentHandle, [directory('src')]);
  const child = await acquire(f, f.b.agentHandle, [file('src/lib/component.ts')]);
  assert.equal(parent.state, 'claimed');
  assert.equal(child.state, 'queued');
  await release(f, f.a.agentHandle, parent.turnToken);
  assert.equal((await resume(f, f.b.agentHandle, child.requestToken)).state, 'claimed');
});
test('file turns coordinate native edits without storing or returning file content', async t => {
  const f = await fixture();
  t.after(f.close);
  const path = join(f.dir, 'handoff.md');
  await writeFile(path, 'private original');
  const writes = f.content.writes;
  const claimed = await acquire(f, f.a.agentHandle, [file('handoff.md')]);
  assert.deepEqual(Object.keys(claimed).sort(), [
    'lifetime',
    'requestToken',
    'state',
    'target',
    'turnToken',
  ]);
  assert.equal(claimed.lifetime, 'session');
  assert.deepEqual(claimed.target.paths, [file(await realpath(path))]);
  const queued = await acquire(f, f.b.agentHandle, [file(path)]);
  assert.equal(queued.state, 'queued');
  assert.equal(await readFile(path, 'utf8'), 'private original');
  await writeFile(path, 'native edit');
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'readTurn', { view: 'page', turnToken: claimed.turnToken }),
    errorCode('RESOURCE_TYPE_MISMATCH'),
  );
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'commitTurn', {
      turnToken: claimed.turnToken,
      mutation: { kind: 'appendMessage', body: 'invalid' },
    }),
    errorCode('RESOURCE_TYPE_MISMATCH'),
  );
  assert.equal(
    (await resume(f, f.a.agentHandle, claimed.requestToken)).turnToken,
    claimed.turnToken,
  );
  await release(f, f.a.agentHandle, claimed.turnToken);
  assert.equal((await resume(f, f.b.agentHandle, queued.requestToken)).state, 'claimed');
  assert.equal(await readFile(path, 'utf8'), 'native edit');
  assert.equal(f.content.writes, writes);
  assert.equal(JSON.stringify(await f.control.view(s => s)).includes('native edit'), false);
});
test('file sets acquire atomically with FIFO overlap ordering and independent paths proceeding', async t => {
  const f = await fixture();
  t.after(f.close);
  const c = await f.service.open('/repo/.git', 'Charlie', undefined, f.dir);
  const d = await f.service.open('/repo/.git', 'Dolphin', undefined, f.dir);
  const first = await acquire(f, f.a.agentHandle, [file('src/a.ts')]);
  const second = await acquire(f, f.b.agentHandle, [directory('src'), file('README.md')]);
  const third = await acquire(f, c.agentHandle, [file('README.md')]);
  const unrelated = await acquire(f, d.agentHandle, [file('src-old/a.ts')]);
  assert.equal(second.state, 'queued');
  assert.equal(third.state, 'queued');
  assert.equal(unrelated.state, 'claimed');
  const held = await f.control.view(async s =>
    (await s.all('requests')).filter(r => r.resourceType === 'files' && r.state === 'CLAIMED'),
  );
  assert.equal(held.length, 2);
  await release(f, f.a.agentHandle, first.turnToken);
  const all = await resume(f, f.b.agentHandle, second.requestToken);
  assert.equal(all.state, 'claimed');
  assert.equal(all.target.paths.length, 2);
  assert.equal((await resume(f, c.agentHandle, third.requestToken)).state, 'queued');
  await release(f, f.b.agentHandle, all.turnToken);
  assert.equal((await resume(f, c.agentHandle, third.requestToken)).state, 'claimed');
});
test('file turns coexist with chat and ticket turns and ignore project content barriers', async t => {
  const f = await fixture();
  t.after(f.close);
  const files = await acquire(f, f.a.agentHandle, [file('src.ts')]);
  const chat = await hold(f.service, f.a.agentHandle, f.thread);
  const context = (await f.service.callMcp(f.a.agentHandle, 'getContext', {})) as {
    pendingTurns: {
      turnToken: string;
    }[];
  };
  assert.equal(context.pendingTurns.length, 2);
  await assert.rejects(
    acquire(f, f.a.agentHandle, [file('extra.ts')]),
    errorCode('TURN_REQUEST_EXISTS'),
  );
  await f.service.commitTurn(
    f.a.agentHandle,
    chat.turn.id,
    chat.turn.fencingToken,
    chat.snapshot.revision,
    { kind: 'appendMessage', body: 'Editing src.ts' },
  );
  const ticket = (await f.service.callMcp(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'Edit source',
    description: 'work',
    owner: 'Alice',
  })) as {
    ticketId: string;
  };
  const ticketTurn = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
  })) as {
    turnToken: string;
  };
  await release(f, f.a.agentHandle, ticketTurn.turnToken);
  await f.service.call(f.b.agentHandle, 'inspectProject', {});
  await release(f, f.a.agentHandle, files.turnToken);
  assert.equal((await acquire(f, f.a.agentHandle, [directory('src')])).state, 'claimed');
  assert.equal((await acquire(f, f.b.agentHandle, [file('unrelated.ts')])).state, 'claimed');
});
test('healthy sessions keep file locks past content deadlines and release rejects stale or foreign tokens', async t => {
  const f = await fixture();
  t.after(f.close);
  const claimed = await acquire(f, f.a.agentHandle, [file('long-edit.ts')]);
  const chat = await hold(f.service, f.a.agentHandle, f.thread);
  f.clock.advance(61000);
  await f.service.heartbeat(f.a.agentHandle);
  assert.equal(
    (await resume(f, f.a.agentHandle, claimed.requestToken)).turnToken,
    claimed.turnToken,
  );
  await assert.rejects(
    f.service.read(f.a.agentHandle, chat.turn.id, chat.turn.fencingToken, 20),
    errorCode('TURN_EXPIRED'),
  );
  await assert.rejects(release(f, f.b.agentHandle, claimed.turnToken), errorCode('NOT_TURN_OWNER'));
  const queued = await acquire(f, f.b.agentHandle, [file('long-edit.ts')]);
  await f.service.forceRelease(claimed.turnToken);
  const next = await resume(f, f.b.agentHandle, queued.requestToken);
  assert.equal(next.state, 'claimed');
  await assert.rejects(release(f, f.a.agentHandle, claimed.turnToken), errorCode('STALE_TURN'));
  assert.equal((await resume(f, f.b.agentHandle, queued.requestToken)).turnToken, next.turnToken);
});
test('disconnect, heartbeat failure, and restart invalidate file ownership and queued requests', async t => {
  const f = await fixture();
  t.after(f.close);
  const a = await acquire(f, f.a.agentHandle, [file('edit.ts')]);
  const queued = await acquire(f, f.b.agentHandle, [file('edit.ts')]);
  await f.service.disconnect(f.a.agentHandle, false);
  const next = await resume(f, f.b.agentHandle, queued.requestToken);
  assert.equal(next.state, 'claimed');
  const reconnect = await f.service.open('/repo/.git', 'Alice', undefined, f.dir);
  await assert.rejects(release(f, reconnect.agentHandle, a.turnToken), errorCode('NOT_TURN_OWNER'));
  const waiting = await acquire(f, reconnect.agentHandle, [file('edit.ts')]);
  await f.service.disconnect(reconnect.agentHandle);
  assert.equal(
    await f.control.view(async s => (await s.get('requests', waiting.requestToken))!.state),
    'CANCELLED',
  );
  f.clock.advance(f.service.limits.instanceMs + 1);
  await f.service.sweep();
  assert.equal(
    await f.control.view(async s => (await s.get('requests', next.requestToken))!.state),
    'EXPIRED',
  );
  const bob = await f.service.open('/repo/.git', 'Bob', undefined, f.dir);
  const live = await acquire(f, bob.agentHandle, [file('restart.ts')]);
  const alice = await f.service.open('/repo/.git', 'Alice', undefined, f.dir);
  const restartQueue = await acquire(f, alice.agentHandle, [file('restart.ts')]);
  await new Bassfish(f.control, f.content, f.clock).initialize();
  assert.equal(
    await f.control.view(async s => (await s.get('requests', live.requestToken))!.state),
    'EXPIRED',
  );
  assert.equal(
    await f.control.view(async s => (await s.get('requests', restartQueue.requestToken))!.state),
    'EXPIRED',
  );
});
test('MCP Tasks claim file sets without snapshots and never resurrect released ownership', async t => {
  const f = await fixture();
  t.after(f.close);
  const a = await acquire(f, f.a.agentHandle, [file('task.ts')]);
  const result = (await f.service.callMcp(
    f.b.agentHandle,
    'acquireTurn',
    { target: { type: 'files', paths: [file('task.ts')] } },
    undefined,
    { taskCapable: true },
  )) as {
    task: {
      taskId: string;
    };
  };
  const taskId = result.task.taskId;
  assert.equal((await f.service.getTask(f.b.agentHandle, taskId, false)).status, 'working');
  await release(f, f.a.agentHandle, a.turnToken);
  assert.equal(await f.control.view(async s => (await s.get('requests', taskId))!.state), 'READY');
  const completed = (await f.service.getTask(f.b.agentHandle, taskId)) as {
    result: {
      turn: {
        id: string;
      };
      target: {
        type: string;
      };
    };
  };
  assert.equal(completed.result.target.type, 'files');
  await release(f, f.b.agentHandle, completed.result.turn.id);
  const again = (await f.service.getTask(f.b.agentHandle, taskId)) as {
    result: {
      state: string;
      turn?: unknown;
    };
  };
  assert.equal(again.result.state, 'released');
  assert.equal(again.result.turn, undefined);
  assert.equal((await acquire(f, f.a.agentHandle, [file('task.ts')])).state, 'claimed');
});
test('path identity respects workspace copies, cross-project shared files, symlinks, and native renames', async t => {
  const f = await fixture();
  t.after(f.close);
  const worktree = join(f.dir, 'worktree');
  await mkdir(worktree);
  const c = await f.service.open('/repo/.git', 'Charlie', undefined, worktree);
  const a = await acquire(f, f.a.agentHandle, [file('same.ts')]);
  const separate = await acquire(f, c.agentHandle, [file('same.ts')]);
  assert.equal(separate.state, 'claimed');
  const other = await f.service.open('/other/.git', 'Alice', undefined, worktree);
  assert.equal(
    (await acquire(f, other.agentHandle, [file(join(f.dir, 'same.ts'))])).state,
    'queued',
  );
  await release(f, f.a.agentHandle, a.turnToken);
  const actual = join(f.dir, 'actual');
  await mkdir(actual);
  await symlink(actual, join(f.dir, 'alias'));
  const aliased = await acquire(f, f.a.agentHandle, [file('alias/old.ts'), file('actual/new.ts')]);
  const blocked = await acquire(f, f.b.agentHandle, [directory('actual')]);
  assert.equal(blocked.state, 'queued');
  await writeFile(join(actual, 'old.ts'), 'content');
  await rename(join(actual, 'old.ts'), join(actual, 'new.ts'));
  assert.equal((await resume(f, f.b.agentHandle, blocked.requestToken)).state, 'queued');
  await release(f, f.a.agentHandle, aliased.turnToken);
  assert.equal((await resume(f, f.b.agentHandle, blocked.requestToken)).state, 'claimed');
});
test('target normalization supports missing paths without creating them and rejects ambiguous kinds', async t => {
  const f = await fixture();
  t.after(f.close);
  const targets = await resolveFileTargets(f.dir, [
    directory('future'),
    file('future/new.ts'),
    directory('./future'),
    file('separate.ts'),
  ]);
  assert.deepEqual(targets, [
    directory(join(await realpath(f.dir), 'future')),
    file(join(await realpath(f.dir), 'separate.ts')),
  ]);
  await assert.rejects(readFile(join(f.dir, 'separate.ts')), { code: 'ENOENT' });
  await writeFile(join(f.dir, 'exists.ts'), 'x');
  await assert.rejects(
    resolveFileTargets(f.dir, [directory('exists.ts')]),
    errorCode('PATH_KIND_MISMATCH'),
  );
  await assert.rejects(
    resolveFileTargets(f.dir, [file('exists.ts/child')]),
    errorCode('INVALID_PATH'),
  );
  await assert.rejects(
    resolveFileTargets(f.dir, [file('future'), directory('future')]),
    errorCode('PATH_KIND_MISMATCH'),
  );
  await symlink(join(f.dir, 'missing'), join(f.dir, 'dangling'));
  await assert.rejects(resolveFileTargets(f.dir, [file('dangling')]), errorCode('INVALID_PATH'));
});
test('Turso transactions reject overlapping ownership across projects and roll back the grant', async t => {
  const f = await fixture();
  t.after(f.close);
  const other = await f.service.open('/other/.git', 'Charlie', undefined, f.dir);
  const claimed = await acquire(f, f.a.agentHandle, [directory('src')]);
  const queued = await acquire(f, other.agentHandle, [file('src/mcp-api.ts')]);
  await assert.rejects(
    async () =>
      await f.control.update(async state => {
        const request = (await state.get('requests', queued.requestToken)) as FileTurnRequest;
        request.state = 'CLAIMED';
        request.turnId = 'illicit-token';
      }),
    errorCode('FILE_LOCK_CONFLICT'),
  );
  assert.equal(
    await f.control.view(async s => (await s.get('requests', queued.requestToken))!.state),
    'QUEUED',
  );
  await release(f, f.a.agentHandle, claimed.turnToken);
  assert.equal((await resume(f, other.agentHandle, queued.requestToken)).state, 'claimed');
});
