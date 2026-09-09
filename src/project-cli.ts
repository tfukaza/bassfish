import { BassfishError, requireThat } from './domain.js';
import {
  acquire,
  booleanFlag,
  boundedIntegerOption,
  comparablePreview,
  credential,
  release,
  take,
} from './cli-helpers.js';
import type { Call, CliInteraction, Turn } from './cli-helpers.js';
import { cancelledResult } from './cli-output.js';

function limit(args: string[], fallback: number): number {
  return boundedIntegerOption(args, '--limit', { min: 1, max: 100 }) ?? fallback;
}

/** Give human operators storage-neutral snapshot names without changing the private store contract. */
export function presentProjectCli(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentProjectCli);
  if (!value || typeof value !== 'object') return value;
  const renamed: Record<string, unknown> = {};
  const names: Record<string, string> = {
    commit: 'snapshotId',
    doltCommit: 'snapshotId',
    snapshotCommit: 'snapshotId',
    targetCommit: 'targetSnapshotId',
    currentCommit: 'currentSnapshotId',
    previousCommit: 'previousSnapshotId',
    fromCommit: 'fromSnapshotId',
    toCommit: 'toSnapshotId',
  };
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    renamed[names[key] ?? key] = presentProjectCli(item);
  return renamed;
}

export async function runProjectCli(
  action: string | undefined,
  args: string[],
  call: Call,
  interaction?: CliInteraction,
): Promise<unknown> {
  if (action === 'inspect') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Project inspect takes no arguments.');
    const turn = await acquire(call, 'project', 'snapshot');
    try {
      return presentProjectCli(await call('inspectSnapshot', { turn: credential(turn) }));
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'export') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Project export takes no arguments.');
    const turn = await acquire(call, 'project', 'export');
    let consumed = false;
    try {
      const result = await call('exportSnapshot', { turn: credential(turn) });
      consumed = true;
      return presentProjectCli(result);
    } finally {
      if (!consumed) await release(call, turn).catch(() => {});
    }
  }
  if (action === 'history') {
    const selectedLimit = limit(args, 50);
    const cursor = take(args, '--cursor');
    requireThat(
      args.length === 0,
      'INVALID_ARGUMENT',
      'Use project history [--limit N] [--cursor C].',
    );
    const turn = await acquire(call, 'project', 'restore');
    try {
      return presentProjectCli(
        await call('listSnapshotHistory', {
          turn: credential(turn),
          limit: selectedLimit,
          ...(cursor ? { cursor } : {}),
        }),
      );
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'restore') {
    const snapshotId = args.shift();
    const confirmed = booleanFlag(args, '--yes');
    const selectedLimit = limit(args, 100);
    const cursor = take(args, '--cursor');
    requireThat(
      snapshotId && args.length === 0,
      'INVALID_ARGUMENT',
      'Use project restore SNAPSHOT_ID [--limit N] [--cursor C] [--yes].',
    );
    requireThat(
      !(confirmed && cursor),
      'INVALID_ARGUMENT',
      'Do not combine --cursor with --yes; confirmation always applies the complete preview.',
    );
    requireThat(
      !(interaction?.interactive && cursor),
      'INVALID_ARGUMENT',
      'Interactive restore starts at the first preview page; omit --cursor.',
    );
    const preview = async (turn: Turn, all: boolean) => {
      let nextCursor = cursor;
      let first: Record<string, unknown> | undefined;
      const changes: unknown[] = [];
      do {
        const page = await call<Record<string, unknown>>('previewSnapshotRestore', {
          turn: credential(turn),
          targetCommit: snapshotId,
          limit: selectedLimit,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        first ??= page;
        changes.push(...(Array.isArray(page.changes) ? page.changes : []));
        nextCursor = all && typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (nextCursor);
      return all ? { ...first, changes, nextCursor: null } : first!;
    };
    const previewAndRelease = async () => {
      const turn = await acquire(call, 'project', 'restore');
      try {
        return presentProjectCli(await preview(turn, true));
      } finally {
        await release(call, turn).catch(() => {});
      }
    };
    if (!confirmed && interaction?.interactive) {
      let reviewed = await previewAndRelease();
      let changed = false;
      while (true) {
        const accepted = await interaction.confirm(
          changed
            ? 'The project changed while you reviewed it. Apply this updated restore preview?'
            : 'Apply this project restore?',
          { request: { command: 'project', action: 'restore' }, value: reviewed },
        );
        if (!accepted) return cancelledResult;
        const turn = await acquire(call, 'project', 'restore');
        let consumed = false;
        try {
          const current = presentProjectCli(await preview(turn, true)) as Record<string, unknown>;
          if (comparablePreview(current) !== comparablePreview(reviewed)) {
            reviewed = current;
            changed = true;
            continue;
          }
          const result = await call('restoreSnapshot', {
            turn: credential(turn),
            previewToken: current.previewToken,
          });
          consumed = true;
          return presentProjectCli(result);
        } finally {
          if (!consumed) await release(call, turn).catch(() => {});
        }
      }
    }
    const turn = await acquire(call, 'project', 'restore');
    let consumed = false;
    try {
      const current = await preview(turn, false);
      if (!confirmed) return presentProjectCli(current);
      const result = await call('restoreSnapshot', {
        turn: credential(turn),
        previewToken: current.previewToken,
      });
      consumed = true;
      return presentProjectCli(result);
    } finally {
      if (!consumed) await release(call, turn).catch(() => {});
    }
  }
  throw new BassfishError('INVALID_ARGUMENT', 'Unknown project command.');
}
