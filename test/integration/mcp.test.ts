import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectDaemon, ensureDaemon } from '../../src/daemon.js';
import { doltBinary, packageRoot, socketPath } from '../../src/config.js';
import { createTaskResult, tasksExtensionId } from '../../src/tasks.js';
import type { Floor, Session, Ticket } from '../support.js';
const exec = promisify(execFile);

test('two actual stdio MCP clients: lazy shared daemon, FIFO, durable content, SIGKILL recovery and CLI parity', { timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bf-mcp-')); const data = join(dir, 'data'), repo = join(dir, 'repo');
  await exec('git', ['init', repo]);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.close()));
    try {
      const rpc = await connectDaemon(data); const health = await rpc.call<{ pid: number }>('getHealth');
      await rpc.call('stopDaemon'); rpc.close();
      const until = performance.now() + 10_000;
      while (performance.now() < until) { try { process.kill(health.pid, 0); } catch { break; } await delay(50); }
    } catch { /* Startup may have failed; no daemon to stop. */ }
    await rm(dir, { recursive: true, force: true });
  });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BASSFISH_DATA_DIR: data, BASSFISH_DOLT_BIN: doltBinary() };
  async function client(name: string): Promise<Client> {
    const c = new Client({ name: 'bassfish-integration', version: '1.0.0' }); clients.push(c);
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, 'dist/cli.js'), 'mcp', '--workspace', repo, '--name', name], env, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await c.connect(transport); return c;
  }
  const [alice, bob] = await Promise.all([client('Alice'), client('Bob')]);
  const listed = await alice.listTools(); assert.equal(listed.tools.length, 30);
  await assert.rejects(lstat(socketPath(data)), { code: 'ENOENT' }); // initialize/list do not start the daemon.
  async function call<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await c.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent as T;
  }
  const [a, b] = await Promise.all([call<Session>(alice, 'getSession'), call<Session>(bob, 'getSession')]);
  assert.equal(a.projectId, b.projectId); assert.notEqual(a.identityId, b.identityId);
  assert.equal((await lstat(socketPath(data))).mode & 0o777, 0o600);
  const created = await call<{ threadId: string }>(alice, 'createThread', { title: 'MCP roundtrip', description: 'Protected content' });
  const offered = await call<Ticket>(alice, 'requestFloor', { target: { type: 'thread', id: created.threadId } });
  const queued = await call<Ticket>(bob, 'requestFloor', { target: { type: 'thread', id: created.threadId } });
  assert.equal(queued.state, 'queued'); assert.ok(!JSON.stringify(offered).includes('Protected'));
  const floor = await call<Floor>(alice, 'claimFloor', { offerId: offered.offerId });
  const denied = await bob.callTool({ name: 'readFloor', arguments: { floor: { id: floor.floor.id, fencingToken: floor.floor.fencingToken } } });
  assert.equal(denied.isError, true); assert.ok(!JSON.stringify(denied).includes('Protected'));
  const waiter = call<Ticket>(bob, 'waitForFloor', { requestId: queued.requestId, timeoutMs: 3000 });
  await call(alice, 'commitFloor', { floor: { id: floor.floor.id, fencingToken: floor.floor.fencingToken }, baseRevision: floor.snapshot.revision,
    mutation: { kind: 'appendMessage', body: 'Hello from real MCP' } });
  const ready = await waiter; assert.equal(ready.state, 'offered');
  const read = await call<Floor>(bob, 'claimFloor', { offerId: ready.offerId });
  assert.equal(read.page.messages[0]!.body, 'Hello from real MCP');
  const modern = new Client({ name: 'bassfish-tasks-integration', version: '1.0.0' }, { capabilities: { extensions: { [tasksExtensionId]: {} } } as never,
    versionNegotiation: { mode: { pin: '2026-07-28' } } }); clients.push(modern);
  const modernTransport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot,'dist/cli.js'),'mcp','--workspace',repo,'--name','Charlie'], env, stderr: 'pipe' });
  modernTransport.stderr?.on('data',() => {}); await modern.connect(modernTransport);
  // The pinned SDK client does not yet decode this external extension's open
  // resultType, so its typed client rejects after receiving the valid task wire
  // result. The transport conformance test validates that complete shape.
  await assert.rejects(modern.request({ method: 'tools/call', params: { name: 'requestFloor', arguments: { target: { type: 'thread', id: created.threadId } } } } as never,createTaskResult),
    (error: unknown) => (error as { code?: string; data?: { resultType?: string } }).code === 'UNSUPPORTED_RESULT_TYPE' && (error as { data?: { resultType?: string } }).data?.resultType === 'task');
  const taskAdmin = await connectDaemon(data); const inspected = await taskAdmin.call<{ floors: { requestId: string; state: string }[] }>('inspectDaemon'); taskAdmin.close();
  const taskId = inspected.floors.find(value => value.state === 'queued')!.requestId;
  await call(bob,'releaseFloor',{ floor: { id: read.floor.id, fencingToken: read.floor.fencingToken } });
  // Ticket polling remains the compatibility path for SDKs/hosts that have not
  // registered the extension methods even if their envelope can advertise it.
  const completedTicket = await call<Ticket>(modern,'getFloorRequest',{ requestId: taskId }); assert.equal(completedTicket.state,'offered');
  const taskFloor = await call<Floor>(modern,'claimFloor',{ offerId: completedTicket.offerId });
  await call(modern,'releaseFloor',{ floor: { id: taskFloor.floor.id, fencingToken: taskFloor.floor.fencingToken } });
  const crashOffer = await call<Ticket>(bob,'requestFloor',{ target: { type: 'thread', id: created.threadId } });
  const crashHolder = await call<Floor>(bob,'claimFloor',{ offerId: crashOffer.offerId });
  const pending = await call<Ticket>(alice, 'requestFloor', { target: { type: 'thread', id: created.threadId } });
  const admin = await connectDaemon(data); const health = await admin.call<{ pid: number; epoch: string }>('getHealth');
  const disconnected = once(admin.socket, 'close'); process.kill(health.pid, 'SIGKILL'); await disconnected;
  // New daemon waits on SQL guardian ownership; no old SQL writer can survive into recovery.
  await ensureDaemon(data, doltBinary());
  const resumed = await call<Session>(alice, 'getSession'); assert.equal(resumed.identityId, a.identityId); assert.notEqual(resumed.adapterInstanceId, a.adapterInstanceId);
  const retained = await call<Ticket>(alice, 'getFloorRequest', { requestId: pending.requestId }); assert.equal(retained.state, 'offered');
  const stale = await bob.callTool({ name: 'readFloor', arguments: { floor: { id: crashHolder.floor.id, fencingToken: crashHolder.floor.fencingToken } } });
  assert.equal(stale.isError, true);
  const final = await call<Floor>(alice, 'claimFloor', { offerId: retained.offerId }); assert.equal(final.page.messages.length, 1);
  await call(alice, 'releaseFloor', { floor: { id: final.floor.id, fencingToken: final.floor.fencingToken } });
  const cli = await exec(process.execPath, [join(packageRoot, 'dist/cli.js'), 'thread', 'show', created.threadId, '--workspace', repo], { env });
  const shown = JSON.parse(cli.stdout) as Floor; assert.equal(shown.page.messages[0]!.body, 'Hello from real MCP');
  const bodyFile = join(dir,'note.md'); await writeFile(bodyFile,'CLI body\n');
  const cliCreated = await exec(process.execPath,[join(packageRoot,'dist/cli.js'),'note','create','plans/cli','--title','CLI','--file',bodyFile,'--workspace',repo,'--name','Human'],{ env });
  const noteId = (JSON.parse(cliCreated.stdout) as { noteId: string }).noteId;
  const cliShown = await exec(process.execPath,[join(packageRoot,'dist/cli.js'),'note','show',noteId,'--workspace',repo,'--name','Human'],{ env }); assert.equal(cliShown.stdout,'CLI body\n');
  const editor = join(dir,'editor.sh'); await writeFile(editor,'#!/bin/sh\nprintf "Edited safely\\n" > "$1"\n',{ mode: 0o700 }); await chmod(editor,0o700);
  await exec(process.execPath,[join(packageRoot,'dist/cli.js'),'note','edit',noteId,'--editor','--workspace',repo,'--name','Human'],{ env: { ...env, VISUAL: editor } });
  const edited = await exec(process.execPath,[join(packageRoot,'dist/cli.js'),'note','show',noteId,'--workspace',repo,'--name','Human'],{ env }); assert.equal(edited.stdout,'Edited safely\n');
  const status = await exec('git', ['-C', repo, 'status', '--porcelain']); assert.equal(status.stdout, '');
});
