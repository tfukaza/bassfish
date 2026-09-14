import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { listenRpc, RpcClient } from '../src/ipc.js';
import { BassfishError } from '../src/domain.js';

test('RPC shutdown drains in-flight requests before asynchronous disconnect cleanup', async t => {
  const dir = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-ipc-'),
  );
  let releaseRequest!: () => void, requestEntered!: () => void;
  let releaseDisconnect!: () => void, disconnectEntered!: () => void;
  const requestGate = new Promise<void>(resolve => {
    releaseRequest = resolve;
  });
  const requestReady = new Promise<void>(resolve => {
    requestEntered = resolve;
  });
  const disconnectGate = new Promise<void>(resolve => {
    releaseDisconnect = resolve;
  });
  const disconnectReady = new Promise<void>(resolve => {
    disconnectEntered = resolve;
  });
  let disconnected = false,
    closed = false;
  const rpc = await listenRpc(
    join(dir, 'daemon.sock'),
    async () => {
      requestEntered();
      await requestGate;
      return { completed: true };
    },
    async () => {
      disconnected = true;
      disconnectEntered();
      await disconnectGate;
    },
  );
  const client = await RpcClient.connect(join(dir, 'daemon.sock'));
  t.after(async () => {
    releaseRequest();
    releaseDisconnect();
    client.close();
    await rpc.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = client.call('hold').catch(error => error);
  await requestReady;
  const closing = rpc.close().then(() => {
    closed = true;
  });
  await delay(20);
  assert.equal(disconnected, false, 'request cancellation must finish before disconnect');
  assert.equal(closed, false);
  releaseRequest();
  await disconnectReady;
  assert.equal(closed, false, 'storage must remain open throughout disconnect cleanup');
  releaseDisconnect();
  await closing;
  assert.equal(closed, true);
  const outcome = await request;
  assert.ok(outcome instanceof BassfishError);
  assert.equal(outcome.code, 'OUTCOME_UNKNOWN');
});

test('a failed asynchronous disconnect is diagnosed without an unhandled rejection', async t => {
  const dir = await mkdtemp(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-ipc-'),
  );
  const events: Array<{ event: string; fields: unknown }> = [];
  const rpc = await listenRpc(
    join(dir, 'daemon.sock'),
    async () => ({ ok: true }),
    async () => {
      throw new BassfishError('DISCONNECT_FAILED', 'PRIVATE_BODY');
    },
    (event, fields) => {
      events.push({ event, fields });
    },
  );
  const client = await RpcClient.connect(join(dir, 'daemon.sock'));
  t.after(async () => {
    client.close();
    await rpc.close();
    await rm(dir, { recursive: true, force: true });
  });
  await client.call('probe');
  await rpc.close();
  assert.equal(events.filter(e => e.event === 'connection.disconnect_failed').length, 1);
  assert.match(JSON.stringify(events), /DISCONNECT_FAILED/);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_BODY/);
});
