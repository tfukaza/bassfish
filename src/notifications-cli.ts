import { resolve } from 'node:path';
import { requireThat } from './domain.js';
import { connectDaemon, ensureDaemon } from './daemon.js';
import { processAncestry, readOrCreateClaudeClientId } from './agents/claude-native.js';
import { formatDeliveryContext, type DeliveryBatch } from './notification-delivery.js';

export function formatClaudeDeliveryNotification(batch: DeliveryBatch): Record<string, unknown> {
  return {
    type: 'bassfish_notifications',
    message: formatDeliveryContext(batch),
    ...batch,
  };
}

/** Claude plugin Monitor entrypoint. Each stdout line is one native Claude notification. */
export async function runNotificationWatcher(
  args: string[],
  dataDir: string,
  binary: string,
): Promise<void> {
  requireThat(
    args.shift() === '--native-claude',
    'INVALID_ARGUMENT',
    'notifications watch is an internal Claude plugin command.',
  );
  const index = args.indexOf('--workspace');
  requireThat(
    index >= 0 && args[index + 1] && !args[index + 1]!.startsWith('--'),
    'INVALID_ARGUMENT',
    'notifications watch requires --workspace PATH.',
  );
  const workspace = resolve(args[index + 1]!);
  args.splice(index, 2);
  const dataIndex = args.indexOf('--plugin-data');
  requireThat(
    dataIndex >= 0 && args[dataIndex + 1] && !args[dataIndex + 1]!.startsWith('--'),
    'INVALID_ARGUMENT',
    'notifications watch requires --plugin-data PATH.',
  );
  const pluginData = resolve(args[dataIndex + 1]!);
  args.splice(dataIndex, 2);
  requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown notifications watch argument.');
  const clientId = await readOrCreateClaudeClientId(pluginData);
  const processAncestors = await processAncestry();
  await ensureDaemon(dataDir, binary);
  const client = await connectDaemon(dataDir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    try {
      while (!controller.signal.aborted) {
        const batch = await client.call<DeliveryBatch>(
          'waitNativeDelivery',
          { workspace, host: 'claude', clientId, processAncestors, timeoutMs: 20_000 },
          controller.signal,
        );
        if (batch.count === 0) continue;
        const notification = formatClaudeDeliveryNotification(batch);
        process.stdout.write(`${JSON.stringify(notification)}\n`);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  } finally {
    client.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
