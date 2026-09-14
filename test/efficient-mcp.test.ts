import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, hold, errorCode } from './support.js';
import { Bassfish } from '../src/service.js';
import { bytes, pageBytes } from '../src/bounded.js';
import { formatDeliveryContext } from '../src/notification-delivery.js';
import type { DeliveryBatch } from '../src/notification-delivery.js';

test('versioned acknowledgements preserve a newer coalesced event and are idempotent', async t => {
  const f = await fixture();
  t.after(f.close);
  const post = async (body: string) => {
    const turn = await hold(f.service, f.a.agentHandle, f.thread);
    return f.service.commitTurn(
      f.a.agentHandle,
      turn.turn.id,
      turn.turn.fencingToken,
      turn.snapshot.revision,
      { kind: 'appendMessage', body },
    );
  };
  await post('first');
  const old = await f.service.inbox.capture(f.b.agentHandle);
  await post('second');
  assert.deepEqual(await f.service.inbox.acknowledge(f.b.agentHandle, old.batchToken!), {
    acknowledged: 1,
    remaining: 1,
  });
  assert.deepEqual(await f.service.inbox.acknowledge(f.b.agentHandle, old.batchToken!), {
    acknowledged: 0,
    remaining: 1,
  });
  const next = await f.service.inbox.capture(f.b.agentHandle);
  assert.equal(next.notifications[0]!.content?.kind, 'thread_message');
  assert.match(formatDeliveryContext(next), /second/);
});

test('oversized notification text stays bounded and expands without rereading a thread', async t => {
  const f = await fixture();
  t.after(f.close);
  const body = '🙂\\\"\n'.repeat(2000);
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body, mentions: { agents: ['Bob'], here: false } },
  );
  const batch = await f.service.inbox.capture(f.b.agentHandle);
  assert.ok(bytes(batch) <= pageBytes);
  assert.ok(Buffer.byteLength(formatDeliveryContext(batch)) <= pageBytes);
  assert.equal(batch.notifications[0]!.truncated, true);
  let cursor: string | null = null;
  let expanded = '';
  do {
    const page = (await f.service.inbox.read(f.b.agentHandle, {
      batchToken: batch.batchToken,
      item: 0,
      ...(cursor ? { cursor } : {}),
    })) as { text: string; nextCursor: string | null };
    assert.ok(bytes(page) <= pageBytes);
    expanded += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(expanded, body);
  assert.equal((await f.service.inbox.capture(f.b.agentHandle)).count, 0);
});

test('checkpoints omit unchanged metadata and include dependency readiness and removals', async t => {
  const f = await fixture();
  t.after(f.close);
  const call = async (name: string, args: unknown = {}) =>
    f.service.callMcp(f.a.agentHandle, name, args) as Promise<Record<string, unknown>>;
  const bootstrap = await call('getUpdates');
  await f.service.heartbeat(f.b.agentHandle);
  assert.deepEqual(await call('getUpdates', { cursor: bootstrap.cursor }), { changed: false });
  const prerequisite = await call('createResource', {
    resourceType: 'ticket',
    title: 'Prerequisite',
    description: '',
    owner: 'Bob',
  });
  const dependent = await call('createResource', {
    resourceType: 'ticket',
    title: 'Dependent',
    description: '',
    owner: 'Alice',
    dependsOn: [prerequisite.ticketId],
  });
  const before = await call('getUpdates', { cursor: bootstrap.cursor });
  const claim = (await f.service.callMcp(f.b.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: prerequisite.ticketId },
  })) as { turnToken: string };
  await f.service.callMcp(f.b.agentHandle, 'commitTurn', {
    turnToken: claim.turnToken,
    mutation: { kind: 'updateTicket', state: 'done' },
  });
  const after = await call('getUpdates', { cursor: before.cursor });
  assert.ok((after.removed as string[]).includes(`ticket:${prerequisite.ticketId}`));
  const ticket = (after.tickets as Array<{ ticketId: string; ready: boolean }>).find(
    t => t.ticketId === dependent.ticketId,
  );
  assert.equal(ticket?.ready, true);
  assert.ok(bytes(after) <= pageBytes);
});

test('readers do not join the writer queue; deltas include old-message visibility changes', async t => {
  const f = await fixture();
  t.after(f.close);
  const writer = await hold(f.service, f.a.agentHandle, f.thread);
  const read = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    resourceId: f.thread,
  })) as { revision: string };
  assert.equal(read.revision, writer.snapshot.revision);
  assert.equal(
    ((await f.service.info(f.b.agentHandle)) as { pendingRequests: unknown[] }).pendingRequests
      .length,
    0,
  );
  const added = await f.service.commitTurn(
    f.a.agentHandle,
    writer.turn.id,
    writer.turn.fencingToken,
    writer.snapshot.revision,
    { kind: 'appendMessage', body: 'Original' },
  );
  const retract = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.commitTurn(
    f.a.agentHandle,
    retract.turn.id,
    retract.turn.fencingToken,
    retract.snapshot.revision,
    { kind: 'retractMessage', messageId: added.messageId! },
  );
  const delta = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    resourceId: f.thread,
    view: 'delta',
    fromRevision: added.revision,
  })) as { messages: Array<{ retracted: boolean; text: string }> };
  assert.equal(delta.messages[0]!.retracted, true);
  assert.equal(delta.messages[0]!.text, '');
  const hiddenRevision = (
    (await f.service.callMcp(f.b.agentHandle, 'readResource', { resourceId: f.thread })) as {
      revision: string;
    }
  ).revision;
  const reinstate = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.commitTurn(
    f.a.agentHandle,
    reinstate.turn.id,
    reinstate.turn.fencingToken,
    reinstate.snapshot.revision,
    { kind: 'reinstateMessage', messageId: added.messageId! },
  );
  const restored = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    resourceId: f.thread,
    view: 'delta',
    fromRevision: hiddenRevision,
  })) as { messages: Array<{ retracted: boolean; text: string }> };
  assert.equal(restored.messages[0]!.retracted, false);
  assert.equal(restored.messages[0]!.text, 'Original');
});

test('a reserved queue batch excludes concurrent delivery; restart retains uncertain unread work', async t => {
  const f = await fixture();
  t.after(f.close);
  const turn = await hold(f.service, f.a.agentHandle, f.thread);
  await f.service.commitTurn(
    f.a.agentHandle,
    turn.turn.id,
    turn.turn.fencingToken,
    turn.snapshot.revision,
    { kind: 'appendMessage', body: 'Review', mentions: { agents: ['Bob'], here: false } },
  );
  const results = await Promise.all([
    f.service.inbox.capture(f.b.agentHandle, 'actionable', 'session'),
    f.service.inbox.capture(f.b.agentHandle),
  ]);
  assert.equal(
    results.reduce((n, b) => n + b.count, 0),
    1,
  );
  const batch = results.find(b => b.count)!;
  await f.service.inbox.transition(f.b.agentHandle, batch.batchToken!, 'submitting');
  const restarted = new Bassfish(f.control, f.content, f.clock, { instanceMs: 3600000 });
  await restarted.initialize();
  const bob = await restarted.open('/repo/.git', 'Bob', undefined, f.dir);
  const summary = (await restarted.inbox.summary(bob.agentHandle)) as {
    unread: number;
    unhandled: Array<{ status: string }>;
  };
  assert.equal(summary.unread, 1);
  assert.equal(summary.unhandled[0]!.status, 'uncertain');
  assert.equal(await restarted.inbox.hasActionable(bob.agentHandle), false);
  const replay = (await restarted.inbox.read(bob.agentHandle, {
    batchToken: batch.batchToken,
  })) as DeliveryBatch;
  assert.match(formatDeliveryContext(replay), /Review/);
});

test('resource pages are replayable, revision pinned, and scoped to the reader', async t => {
  const f = await fixture();
  t.after(f.close);
  const body = 'A🙂\\\"\n'.repeat(4000);
  const ticket = (await f.service.callMcp(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'Paged body',
    description: '',
    body,
    owner: 'Alice',
  })) as { ticketId: string };
  let page = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    resourceId: ticket.ticketId,
  })) as Record<string, unknown>;
  assert.ok(page.nextCursor);
  const pinned = page.revision;
  const claim = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'ticket', ticketId: ticket.ticketId },
  })) as { turnToken: string };
  await f.service.callMcp(f.a.agentHandle, 'commitTurn', {
    turnToken: claim.turnToken,
    mutation: { kind: 'replaceTicketBody', body: 'New body' },
  });
  const cursor = page.nextCursor;
  const replay = (await f.service.callMcp(f.b.agentHandle, 'readResource', { cursor })) as Record<
    string,
    unknown
  >;
  assert.deepEqual(await f.service.callMcp(f.b.agentHandle, 'readResource', { cursor }), replay);
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'readResource', { cursor }),
    errorCode('INVALID_CURSOR'),
  );
  let read = '';
  do {
    assert.ok(bytes(page) <= pageBytes);
    assert.equal(page.revision, pinned);
    read += (page.body as Array<{ text: string }>).map(p => p.text).join('');
    page = page.nextCursor
      ? ((await f.service.callMcp(f.b.agentHandle, 'readResource', {
          cursor: page.nextCursor,
        })) as Record<string, unknown>)
      : {};
  } while (page.revision);
  assert.equal(read, body);
});

test('bootstrap continuation commits its checkpoint only after every bounded metadata page', async t => {
  const f = await fixture();
  t.after(f.close);
  for (let i = 0; i < 30; i++)
    await f.service.callMcp(f.a.agentHandle, 'createResource', {
      resourceType: 'ticket',
      title: `Task ${i}`,
      description: 'x'.repeat(300),
      body: 'Large body '.repeat(2000),
      owner: 'Alice',
    });
  let page = (await f.service.callMcp(f.a.agentHandle, 'getUpdates', {})) as Record<
    string,
    unknown
  >;
  assert.ok(page.nextCursor);
  assert.equal(page.cursor, undefined);
  const firstCursor = page.nextCursor;
  const second = await f.service.callMcp(f.a.agentHandle, 'getUpdates', { cursor: firstCursor });
  assert.deepEqual(
    await f.service.callMcp(f.a.agentHandle, 'getUpdates', { cursor: firstCursor }),
    second,
  );
  let count = 0;
  let checkpoint: unknown;
  do {
    assert.ok(bytes(page) <= pageBytes);
    const tickets = (page.tickets ?? []) as Array<Record<string, unknown>>;
    count += tickets.length;
    assert.ok(tickets.every(t => !('body' in t)));
    checkpoint = page.cursor;
    page = page.nextCursor
      ? ((await f.service.callMcp(f.a.agentHandle, 'getUpdates', {
          cursor: page.nextCursor,
        })) as Record<string, unknown>)
      : {};
  } while (page.changed);
  assert.equal(count, 30);
  assert.ok(checkpoint);
  assert.deepEqual(await f.service.callMcp(f.a.agentHandle, 'getUpdates', { cursor: checkpoint }), {
    changed: false,
  });
});

test('partial acknowledgements retain unhandled entries and completed batch retention is bounded', async t => {
  const f = await fixture();
  t.after(f.close);
  f.service.limits.retentionMs = 1000;
  await f.service.callMcp(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'One',
    description: '',
    owner: 'Bob',
  });
  await f.service.callMcp(f.a.agentHandle, 'createResource', {
    resourceType: 'ticket',
    title: 'Two',
    description: '',
    owner: 'Bob',
  });
  const batch = await f.service.inbox.capture(f.b.agentHandle);
  assert.equal(batch.count, 2);
  await f.service.inbox.acknowledge(f.b.agentHandle, batch.batchToken!, [0]);
  f.clock.advance(f.service.limits.retentionMs + 1);
  await f.service.heartbeat(f.a.agentHandle);
  await f.service.heartbeat(f.b.agentHandle);
  await f.service.sweep();
  assert.equal(
    (
      (await f.service.inbox.read(f.b.agentHandle, {
        batchToken: batch.batchToken,
      })) as DeliveryBatch
    ).count,
    2,
  );
  assert.deepEqual(await f.service.inbox.acknowledge(f.b.agentHandle, batch.batchToken!, [1]), {
    acknowledged: 1,
    remaining: 0,
  });
  f.clock.advance(f.service.limits.retentionMs + 1);
  await f.service.heartbeat(f.a.agentHandle);
  await f.service.heartbeat(f.b.agentHandle);
  await f.service.sweep();
  await assert.rejects(
    f.service.inbox.read(f.b.agentHandle, { batchToken: batch.batchToken }),
    errorCode('BATCH_NOT_FOUND'),
  );
});

test('a held snapshot cannot be used after the turn expires during the read', async t => {
  const f = await fixture();
  t.after(f.close);
  const turn = (await f.service.callMcp(f.a.agentHandle, 'acquireTurn', {
    target: { type: 'thread', threadId: f.thread },
  })) as { turnToken: string };
  f.content.afterSnapshot = () => f.clock.advance(f.service.limits.turnTimeoutMs + 1);
  await assert.rejects(
    f.service.callMcp(f.a.agentHandle, 'readResource', { turnToken: turn.turnToken }),
    errorCode('TURN_EXPIRED'),
  );
});

test('older thread pages retain the first revision when a newer message arrives', async t => {
  const f = await fixture();
  t.after(f.close);
  const post = async (body: string) => {
    const turn = await hold(f.service, f.a.agentHandle, f.thread);
    return f.service.commitTurn(
      f.a.agentHandle,
      turn.turn.id,
      turn.turn.fencingToken,
      turn.snapshot.revision,
      { kind: 'appendMessage', body },
    );
  };
  for (let i = 0; i < 23; i++) await post(`Message ${i}`);
  const first = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    resourceId: f.thread,
    query: 'unused'.repeat(150),
  })) as { revision: string; messages: Array<{ text: string }>; nextCursor: string };
  assert.ok(bytes(first) <= pageBytes);
  assert.ok(first.nextCursor);
  assert.equal(first.messages.length, 20);
  await post('Newer than the pinned page');
  const older = (await f.service.callMcp(f.b.agentHandle, 'readResource', {
    cursor: first.nextCursor,
  })) as typeof first;
  assert.equal(older.revision, first.revision);
  assert.deepEqual(
    older.messages.map(m => m.text),
    ['Message 0', 'Message 1', 'Message 2'],
  );
  assert.equal(older.nextCursor, null);
});
