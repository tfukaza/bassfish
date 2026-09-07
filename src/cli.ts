#!/usr/bin/env node
import { resolve } from 'node:path';
import { access, rename } from 'node:fs/promises';
import { BassfishError, requireThat } from './domain.js';
import { dataDirectory, defaultRuntimeConfig, doltBinary, loadRuntimeConfig, packageVersion, runtimeConfigSchema, saveRuntimeConfig } from './config.js';
import { connectDaemon, ensureDaemon, runDaemon } from './daemon.js';
import { runSqlWorker } from './sql-worker.js';
import { runMcp } from './mcp.js';
import { runNoteCli } from './note-cli.js';
import { runThreadCli } from './thread-cli.js';
import { setupDolt } from './setup.js';
import { requireDolt } from './supervisor.js';

const help = `Bassfish — Headless inter-agent communication for agent teams

bassfish mcp [--workspace PATH] [--name NAME]     Agent-facing stdio MCP server
bassfish setup                                    Install checksum-verified Dolt
bassfish --version                                Print the installed version
bassfish daemon start|status|stop|run             Shared per-user backend
bassfish config show|reset
bassfish config set KEY MILLISECONDS              Validate config; applies after restart
bassfish data reset --yes                         Move preview data to a timestamped backup
bassfish doctor                                 Current state and recovery diagnostics
bassfish turn list                             List current turn/control metadata
bassfish turn release TURN_ID --force          Revoke CLAIMED, never COMMITTING
bassfish thread list [--archived|--deleted] [--limit N] [--cursor C] [--creator ID] [--title-prefix TEXT]
bassfish thread create TITLE [--description TEXT]
bassfish thread get THREAD_ID                   Thread metadata without a turn
bassfish thread show THREAD_ID                  Acquire once, read messages, then release
bassfish thread search QUERY [--archived|--deleted] [--limit N]
bassfish thread describe THREAD_ID (--description TEXT | --clear)
bassfish thread delete THREAD_ID
bassfish note list [--archived|--deleted] [filters]
bassfish note create PATH --title TITLE (--file PATH|-|--editor)
bassfish note show NOTE_ID [--json]
bassfish note edit|append|prepend|patch NOTE_ID (--file PATH|-|--editor)
bassfish note move|metadata|links|replace-text|section NOTE_ID [options]
bassfish note archive|delete|activate|history NOTE_ID
bassfish note restore NOTE_ID REVISION --yes

Human CLI commands use the same turn checks as MCP. A busy show cancels its
ticket and reports TURN_BUSY; it never retries. Agents should use MCP.
Environment: BASSFISH_DATA_DIR, BASSFISH_DOLT_BIN (Dolt 2.3.2).
`;
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1]; requireThat(value && !value.startsWith('--'), 'INVALID_ARGUMENT', `${name} requires a value.`);
  args.splice(index, 2); return value;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') { process.stdout.write(help); return; }
  if (command === '--version' || command === 'version') { requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Version takes no arguments.'); process.stdout.write(`${packageVersion}\n`); return; }
  const data = dataDirectory(), binary = doltBinary(data);
  if (command === 'setup') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Setup takes no arguments.');
    process.stdout.write(JSON.stringify(await setupDolt(data), null, 2) + '\n'); return;
  }
  if (command === 'sql-worker') { requireThat(args.length === 2, 'INVALID_ARGUMENT', 'Internal SQL worker arguments missing.'); await runSqlWorker(args[0]!, args[1]!); return; }
  if (command === 'daemon' && args[0] === 'run') { await runDaemon(data, binary); return; }
  if (command === 'config') {
    const action = args.shift();
    if (action === 'show' && args.length === 0) { process.stdout.write(JSON.stringify(await loadRuntimeConfig(data), null, 2) + '\n'); return; }
    if (action === 'reset' && args.length === 0) { await saveRuntimeConfig(data, defaultRuntimeConfig); process.stdout.write(JSON.stringify(defaultRuntimeConfig, null, 2) + '\n'); return; }
    if (action === 'set' && args.length === 2) {
      const [key, raw] = args; requireThat(Object.hasOwn(defaultRuntimeConfig, key!), 'INVALID_ARGUMENT', 'Unknown configuration key.');
      requireThat(/^[0-9]+$/.test(raw!), 'INVALID_ARGUMENT', 'Configuration values are integer milliseconds.');
      const next = runtimeConfigSchema.parse({ ...await loadRuntimeConfig(data), [key!]: Number(raw) }); await saveRuntimeConfig(data, next);
      process.stdout.write(JSON.stringify(next, null, 2) + '\n'); return;
    }
    throw new BassfishError('INVALID_ARGUMENT', 'Use config show, config reset, or config set KEY MILLISECONDS.');
  }
  if (command === 'data') {
    requireThat(args.length === 2 && args[0] === 'reset' && args[1] === '--yes', 'INVALID_ARGUMENT', 'Use data reset --yes.');
    let live = false; let probe;
    try { probe = await connectDaemon(data); await probe.call('getHealth'); live = true; } catch {} finally { probe?.close(); }
    requireThat(!live, 'DAEMON_RUNNING', 'Stop the Bassfish daemon before resetting preview data.');
    try { await access(data); } catch { process.stdout.write(JSON.stringify({ reset: false, reason: 'no_data' }) + '\n'); return; }
    const stamp = new Date().toISOString().replaceAll(':','-'); const backup = `${data}.backup-${stamp}`; await rename(data, backup);
    process.stdout.write(JSON.stringify({ reset: true, backup }, null, 2) + '\n'); return;
  }
  const workspace = resolve(flag(args, '--workspace') ?? process.cwd());
  const name = flag(args, '--name');
  if (command === 'mcp') { requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown MCP argument.'); await runMcp(workspace, data, binary, name); return; }
  const action = args.shift();
  const valid = (command === 'daemon' && ['start', 'status', 'stop'].includes(action ?? '')) || command === 'doctor' ||
    (command === 'turn' && ['list', 'release'].includes(action ?? '')) || (command === 'thread' && ['list', 'create', 'get', 'show', 'search', 'describe', 'delete'].includes(action ?? '')) ||
    (command === 'note' && ['list','create','show','edit','append','prepend','patch','move','metadata','links','replace-text','section','archive','delete','activate','history','restore'].includes(action ?? ''));
  requireThat(valid, 'INVALID_ARGUMENT', help);
  if (command === 'doctor') {
    requireThat(action === undefined && args.length === 0, 'INVALID_ARGUMENT', 'Doctor takes no arguments.');
    let dolt: Record<string, unknown>;
    try { dolt = { state: 'ready', version: await requireDolt(binary), path: binary }; }
    catch (error) { dolt = { state: 'unavailable', path: binary, error: error instanceof Error ? error.message : String(error) }; }
    let daemon: unknown = { state: 'stopped' }; let probe;
    try { probe = await connectDaemon(data); daemon = await probe.call('getHealth'); } catch {} finally { probe?.close(); }
    const result = { version: packageVersion, node: process.versions.node, platform: `${process.platform}-${process.arch}`, dataDir: data, dolt, daemon };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (dolt.state !== 'ready') process.exitCode = 1;
    return;
  }
  if (command !== 'turn' && !(command === 'daemon' && action !== 'start')) await ensureDaemon(data, binary);
  const client = await connectDaemon(data);
  let opened = false;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    let result: unknown;
    if (command === 'daemon') result = await client.call(action === 'stop' ? 'stopDaemon' : 'getHealth');
    else if (command === 'turn' && action === 'list') result = await client.call('getHealth');
    else if (command === 'turn') {
      requireThat(args.length === 2 && args[1] === '--force', 'INVALID_ARGUMENT', 'Use turn release TURN_ID --force.');
      result = await client.call('forceRelease', { turnId: args[0], force: true });
    } else {
      await client.call('openSession', { workspace, name }); opened = true;
      heartbeat = setInterval(() => { void client.call('heartbeatSession').catch(() => {}); }, 5000); heartbeat.unref();
      const call = <T = unknown>(name: string, args: unknown = {}) => client.call<T>('callTool', { name, args });
      if (command === 'note') {
        const output = await runNoteCli(action,args,call,data); if (output.raw !== undefined) { process.stdout.write(output.raw); return; } result = output.value;
      } else if (command === 'thread') result = await runThreadCli(action, args, call);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { if (opened && !client.socket.destroyed) await client.call('closeSession'); } finally { client.close(); }
  }
}
void main().catch(error => {
  const code = error instanceof BassfishError ? error.code : (error as NodeJS.ErrnoException).code ?? 'STARTUP_ERROR';
  process.stderr.write(`${code}: ${error instanceof Error ? error.message : 'Bassfish failed.'}\n`); process.exitCode = 1;
});
