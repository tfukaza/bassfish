import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { errorCode, fixture, hold } from './support.js';
import { exportProject } from '../src/export.js';

test('a durable project drain waits for holders and blocks new resource claims', async t => {
  const f = await fixture();
  t.after(f.close);
  const claimed = await hold(f.service, f.a.agentHandle, f.thread);
  const draining = (await f.service.call(f.b.agentHandle, 'requestTurn', {
    target: { type: 'project', purpose: 'snapshot' },
  })) as { state: string; requestId: string };
  assert.equal(draining.state, 'queued');
  await f.service.call(f.a.agentHandle, 'releaseTurn', {
    turn: { id: claimed.turn.id, fencingToken: claimed.turn.fencingToken },
  });
  const offered = (await f.service.call(f.b.agentHandle, 'getTurnRequest', {
    requestId: draining.requestId,
  })) as { state: string; offerId: string };
  assert.equal(offered.state, 'offered');
  const project = (await f.service.call(f.b.agentHandle, 'claimTurn', {
    offerId: offered.offerId,
  })) as { turn: { id: string; fencingToken: string } };
  const resource = (await f.service.call(f.a.agentHandle, 'requestTurn', {
    target: { type: 'thread', id: f.thread },
  })) as { state: string; requestId: string };
  assert.equal(resource.state, 'queued');
  await f.service.call(f.b.agentHandle, 'releaseTurn', {
    turn: { id: project.turn.id, fencingToken: project.turn.fencingToken },
  });
  assert.equal(
    (
      (await f.service.call(f.a.agentHandle, 'getTurnRequest', {
        requestId: resource.requestId,
      })) as { state: string }
    ).state,
    'offered',
  );
});

test('a queued project turn also blocks resource creation without a turn', async t => {
  const f = await fixture();
  t.after(f.close);
  const claimed = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.call(f.b.agentHandle, 'requestTurn', {
    target: { type: 'project', purpose: 'restore' },
  });
  await assert.rejects(
    f.service.call(f.a.agentHandle, 'createThread', { title: 'Blocked' }),
    errorCode('PROJECT_TURN_PENDING'),
  );
  await f.service.call(f.a.agentHandle, 'releaseTurn', {
    turn: { id: claimed.turn.id, fencingToken: claimed.turn.fencingToken },
  });
});

test('project exports are byte deterministic', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot = {
    commit: 'abcdef0123456789',
    threads: [],
    messages: [],
    visibility: [],
    tickets: [
      {
        id: 't1',
        title: 'API',
        description: 'Implement API',
        body: '# API\n',
        owner: 'a',
        ownerName: 'A',
        dependsOn: [],
        state: 'todo' as const,
        revision: '1',
        creator: 'a',
        creatorName: 'A',
        lastEditor: 'a',
        lastEditorName: 'A',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
  };
  const first = await exportProject(dir, 'p_test', snapshot);
  const bytes = await readFile(first.path);
  const second = await exportProject(dir, 'p_test', snapshot);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(bytes, await readFile(second.path));
});

test('whole-project restore recreates target-visible content with fresh monotonic counters', async t => {
  const f = await fixture();
  t.after(f.close);
  const projectId = (f.a.session as { projectId: string }).projectId;
  const created = (await f.service.createTicket(f.a.agentHandle, {
    title: 'Original',
    description: 'Work',
    owner: 'Alice',
    state: 'todo',
    body: 'first body',
    dependsOn: [],
  })) as { ticketId: string };
  const targetCommit = await f.content.head(projectId);
  const ticketRequest = (await f.service.requestResourceTurn(
    f.a.agentHandle,
    'ticket',
    created.ticketId,
  )) as { offerId: string };
  const claimed = (await f.service.call(f.a.agentHandle, 'claimTurn', {
    offerId: ticketRequest.offerId,
  })) as { turn: { id: string; fencingToken: string }; snapshot: { revision: string } };
  await f.service.commitTurn(
    f.a.agentHandle,
    claimed.turn.id,
    claimed.turn.fencingToken,
    claimed.snapshot.revision,
    { kind: 'replaceTicketBody', body: 'later body' },
  );
  const later = (await f.service.createTicket(f.a.agentHandle, {
    title: 'Later',
    description: 'Work',
    owner: 'Alice',
    state: 'todo',
    body: 'remove me',
    dependsOn: [],
  })) as { ticketId: string };
  const threadTurn = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.call(f.a.agentHandle, 'commitTurn', {
    turn: { id: threadTurn.turn.id, fencingToken: threadTurn.turn.fencingToken },
    baseRevision: threadTurn.snapshot.revision,
    mutation: { kind: 'appendMessage', body: 'later message' },
  });
  const request = (await f.service.call(f.a.agentHandle, 'requestTurn', {
    target: { type: 'project', purpose: 'restore' },
  })) as { offerId: string };
  const turn = (await f.service.call(f.a.agentHandle, 'claimTurn', {
    offerId: request.offerId,
  })) as { turn: { id: string; fencingToken: string } };
  const credential = { id: turn.turn.id, fencingToken: turn.turn.fencingToken };
  const preview = (await f.service.call(f.a.agentHandle, 'previewSnapshotRestore', {
    turn: credential,
    targetCommit,
  })) as { previewToken: string };
  const restored = (await f.service.call(f.a.agentHandle, 'restoreSnapshot', {
    turn: credential,
    previewToken: preview.previewToken,
  })) as { changes: unknown[] };
  assert.ok(restored.changes.length >= 2);
  const snapshot = await f.content.projectSnapshot(projectId);
  assert.equal(snapshot.tickets.find(ticket => ticket.id === created.ticketId)?.body, 'first body');
  assert.equal(
    snapshot.tickets.some(ticket => ticket.id === later.ticketId),
    false,
  );
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.threads[0]!.headSequence, '1');
  assert.ok(BigInt(snapshot.tickets[0]!.revision) > 2n);
});

test('whole-project restore to a pre-deletion commit reactivates a deleted thread', async t => {
  const f = await fixture();
  t.after(f.close);
  const projectId = (f.a.session as { projectId: string }).projectId;
  const targetCommit = await f.content.head(projectId);
  const threadTurn = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.call(f.a.agentHandle, 'commitTurn', {
    turn: { id: threadTurn.turn.id, fencingToken: threadTurn.turn.fencingToken },
    baseRevision: threadTurn.snapshot.revision,
    mutation: { kind: 'deleteThread' },
  });
  assert.equal(
    (
      (await f.service.call(f.a.agentHandle, 'getThread', { threadId: f.thread })) as {
        state: string;
      }
    ).state,
    'deleted',
  );
  const request = (await f.service.call(f.a.agentHandle, 'requestTurn', {
    target: { type: 'project', purpose: 'restore' },
  })) as { offerId: string };
  const turn = (await f.service.call(f.a.agentHandle, 'claimTurn', {
    offerId: request.offerId,
  })) as { turn: { id: string; fencingToken: string } };
  const credential = { id: turn.turn.id, fencingToken: turn.turn.fencingToken };
  const preview = (await f.service.call(f.a.agentHandle, 'previewSnapshotRestore', {
    turn: credential,
    targetCommit,
  })) as { previewToken: string };
  const restored = (await f.service.call(f.a.agentHandle, 'restoreSnapshot', {
    turn: credential,
    previewToken: preview.previewToken,
  })) as { changes: { resourceType: string; resourceId: string; action: string }[] };
  assert.deepEqual(
    restored.changes.map(change => [change.resourceType, change.resourceId, change.action]),
    [['thread', f.thread, 'update']],
  );
  const after = (await f.service.call(f.a.agentHandle, 'getThread', { threadId: f.thread })) as {
    state: string;
    revision: string;
  };
  assert.equal(after.state, 'active');
  assert.ok(BigInt(after.revision) > 2n);
});
