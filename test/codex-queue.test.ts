import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexQueue, type QueueBackend } from '../src/agents/codex-queue.js';
import type { DeliveryBatch } from '../src/notification-delivery.js';

const session = '01a09c00-2542-7393-8317-b9265adc4374';
const batch: DeliveryBatch = {
  kind: 'actionable',
  count: 1,
  batchToken: 'batch',
  moreAvailable: false,
  notifications: [
    {
      index: 0,
      resourceType: 'thread',
      resourceId: 'thread',
      sender: 'Alice',
      reasons: ['direct_mention'],
      content: {
        kind: 'thread_message',
        threadTitle: 'Review',
        body: 'Please review',
        retracted: false,
      },
    },
  ],
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await delay(10);
  assert.ok(check());
}
function harness(failure?: string) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const states: string[] = [];
  let delivered = false;
  const backend: QueueBackend = {
    wait: async (_id, signal) => {
      if (!delivered) return { ready: true };
      await delay(20000, undefined, { signal });
      return { ready: false };
    },
    reserve: async () => {
      delivered = true;
      return batch;
    },
    transition: async (_id, _token, status) => {
      states.push(status);
    },
  };
  const run = (async (_file: string, args: string[], options: { cwd?: string }) => {
    if (args[0] === '--version') return { stdout: 'codex-cli 0.154.0', stderr: '' };
    calls.push({ args, cwd: options.cwd });
    if (failure) throw Object.assign(new Error(failure), { code: failure });
    return { stdout: 'queued', stderr: '' };
  }) as unknown as ConstructorParameters<typeof CodexQueue>[2];
  return { queue: new CodexQueue(backend, () => '/repo', run, 0), calls, states };
}
test('native queue targets the bound UUID and accepted work is not repeatedly submitted', async t => {
  const h = harness();
  t.after(() => h.queue.stop());
  h.queue.bind(session);
  await until(() => h.states.includes('accepted'));
  assert.deepEqual(h.states, ['submitting', 'accepted']);
  assert.equal(h.calls[0]!.args[0], 'queue');
  assert.equal(h.calls[0]!.args[2], session);
  assert.match(h.calls[0]!.args[4]!, /Please review/);
  assert.equal(h.calls[0]!.cwd, '/repo');
  await delay(30);
  assert.equal(h.calls.length, 1);
});
test('executable availability does not claim idle wake readiness before hooks run', async t => {
  const h = harness();
  t.after(() => h.queue.stop());
  h.queue.bind(session);
  await until(() => h.states.includes('accepted'));
  assert.equal(h.queue.readiness, 'hooks-unobserved');
  h.queue.observeHook('prompt');
  assert.equal(h.queue.readiness, 'active');
  h.queue.observeHook('idle');
  assert.equal(h.queue.readiness, 'available');
  h.queue.observeHook('paused');
  assert.equal(h.queue.readiness, 'paused');
  h.queue.bind(session);
  h.queue.observeHook('prompt');
  assert.equal(h.queue.readiness, 'active');
});
test('unknown acceptance is retained and is not blindly queued again', async t => {
  const h = harness('ETIMEDOUT');
  t.after(() => h.queue.stop());
  h.queue.bind(session);
  await until(() => h.states.includes('uncertain'));
  await delay(30);
  assert.deepEqual(h.states, ['submitting', 'uncertain']);
  assert.equal(h.calls.length, 1);
});
test('a known spawn failure releases the reservation and disables that listener', async t => {
  const h = harness('ENOENT');
  t.after(() => h.queue.stop());
  h.queue.bind(session);
  await until(() => h.states.includes('released'));
  assert.equal(h.queue.status, 'unavailable');
  assert.deepEqual(h.states, ['submitting', 'released']);
});

test('an interrupted listener remains paused until the next prompt binding', async t => {
  const h = harness();
  t.after(() => h.queue.stop());
  h.queue.bind(session);
  h.queue.pause();
  await delay(40);
  assert.equal(h.calls.length, 0);
  h.queue.bind(session);
  await until(() => h.states.includes('accepted'));
  assert.equal(h.calls.length, 1);
});

test('interruption during reservation releases the batch before launching Codex', async t => {
  const states: string[] = [];
  let reserved = false;
  let launches = 0;
  const backend: QueueBackend = {
    wait: async (_id, signal) => {
      if (!reserved) return { ready: true };
      await delay(20000, undefined, { signal });
      return { ready: false };
    },
    reserve: async () => {
      reserved = true;
      queue.pause();
      return batch;
    },
    transition: async (_id, _token, status) => {
      states.push(status);
    },
  };
  const run = (async (_file: string, args: string[]) => {
    if (args[0] !== '--version') launches++;
    return { stdout: 'codex-cli 0.154.0', stderr: '' };
  }) as unknown as ConstructorParameters<typeof CodexQueue>[2];
  const queue = new CodexQueue(backend, () => '/repo', run, 0);
  t.after(() => queue.stop());
  queue.bind(session);
  await until(() => states.includes('released'));
  assert.deepEqual(states, ['released']);
  assert.equal(launches, 0);
});

test('a relative SQLite override disables queueing before any submission', async t => {
  const original = process.env.BASSFISH_CODEX_QUEUE_SQLITE_HOME;
  process.env.BASSFISH_CODEX_QUEUE_SQLITE_HOME = 'relative-state';
  const h = harness();
  t.after(() => {
    h.queue.stop();
    if (original === undefined) delete process.env.BASSFISH_CODEX_QUEUE_SQLITE_HOME;
    else process.env.BASSFISH_CODEX_QUEUE_SQLITE_HOME = original;
  });
  h.queue.bind(session);
  await until(() => h.queue.status === 'unavailable');
  assert.equal(h.calls.length, 0);
  assert.equal(h.states.length, 0);
});
