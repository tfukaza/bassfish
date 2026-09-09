import test from 'node:test';
import assert from 'node:assert/strict';
import { MentionTaskRegistry } from '../src/mention-tasks.js';

test('mention listener tasks are one-shot, coalesced, and observable', async () => {
  let deliver!: (value: {
    notifications: Record<string, unknown>[];
    moreAvailable: boolean;
  }) => void;
  const registry = new MentionTaskRegistry(
    () =>
      new Promise(resolve => {
        deliver = resolve;
      }),
  );
  const first = registry.create();
  const duplicate = registry.create();
  assert.equal(first.taskId, duplicate.taskId);
  assert.equal(first.status, 'working');
  const changed = registry.waitForUpdate(
    String(first.taskId),
    Date.parse(String(first.lastUpdatedAt)),
    1_000,
  );
  deliver({ notifications: [{ notificationId: 'notice-1' }], moreAvailable: false });
  const completed = await changed;
  assert.equal(completed.status, 'completed');
  assert.deepEqual((completed.result as { notifications: unknown[] }).notifications, [
    { notificationId: 'notice-1' },
  ]);
  assert.notEqual(registry.create().taskId, first.taskId);
  registry.stop();
});

test('cancelling a mention listener aborts its wait without consuming work', async () => {
  let aborted = false;
  const registry = new MentionTaskRegistry(
    (_routeKey, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        ),
      ),
  );
  const task = registry.create();
  registry.cancel(String(task.taskId));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(registry.get(String(task.taskId)).status, 'cancelled');
});

test('mention listeners coalesce within a host session but remain independent across sessions', () => {
  const registry = new MentionTaskRegistry(
    (_routeKey, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      ),
  );
  const rootOne = registry.create('root-one');
  const sameRoot = registry.create('root-one');
  const rootTwo = registry.create('root-two');
  assert.equal(rootOne.taskId, sameRoot.taskId);
  assert.notEqual(rootOne.taskId, rootTwo.taskId);
  assert.equal(registry.route(String(rootOne.taskId)), 'root-one');
  assert.equal(registry.route(String(rootTwo.taskId)), 'root-two');
  registry.stop();
});
