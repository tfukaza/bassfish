import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { RuntimeDiagnostics } from '../../dist/runtime-diagnostics.js';
import { DiagnosticOperation, withDiagnostics } from '../../dist/diagnostic-events.js';
import { TursoStore } from '../../dist/storage/turso.js';

const [mode, dir] = process.argv.slice(2);
const diagnostics =
  mode === 'baseline'
    ? undefined
    : new RuntimeDiagnostics(dir, { epoch: 'fixture', bassfishVersion: 'fixture' });
if (mode === 'stall') {
  await delay(1500);
  process.stdout.write('ready\n');
  process.stdin.once('data', async () => {
    await withDiagnostics(diagnostics.emit, { method: 'fixture' }, async () => {
      const operation = new DiagnosticOperation('storage');
      operation.phase('statement', { statementKind: 'get', statementOrdinal: 1 });
      const until = performance.now() + 5000;
      while (performance.now() < until) {
        /* deliberately block only this child */
      }
      operation.finish();
    });
    process.stdout.write('resumed\n');
    await delay(2000);
    await diagnostics.close();
    process.stdin.destroy();
  });
} else {
  const store = await TursoStore.open(
    join(dir, 'test.db'),
    'CREATE TABLE IF NOT EXISTS test(value INTEGER)',
  );
  await delay(1500);
  const cpu = process.cpuUsage(),
    start = performance.now();
  for (let batch = 0; batch < 125; batch++)
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withDiagnostics(diagnostics?.emit, { method: 'load' }, () =>
          store.read(tx => tx.get('SELECT 1 AS value')),
        ),
      ),
    );
  const durationMs = performance.now() - start,
    used = process.cpuUsage(cpu);
  await delay(1200);
  console.log(
    JSON.stringify({
      mode,
      operations: 1000,
      durationMs,
      cpuMs: (used.user + used.system) / 1000,
      rssBytes: process.memoryUsage.rss(),
      diagnostics: diagnostics?.summary(),
    }),
  );
  await store.close();
  await diagnostics?.close();
}
