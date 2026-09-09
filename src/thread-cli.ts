import { BassfishError, requireThat } from './domain.js';
import {
  acquire,
  booleanFlag,
  boundedIntegerOption,
  comparablePreview,
  credential,
  mutation,
  release,
  take,
} from './cli-helpers.js';
import type { Call, CliInteraction, Turn } from './cli-helpers.js';
import { cancelledResult } from './cli-output.js';

function threadState(args: string[]): 'active' | 'archived' | 'deleted' {
  const archived = booleanFlag(args, '--archived');
  const deleted = booleanFlag(args, '--deleted');
  requireThat(
    !(archived && deleted),
    'INVALID_ARGUMENT',
    'Choose at most one of --archived or --deleted.',
  );
  return archived ? 'archived' : deleted ? 'deleted' : 'active';
}
function limit(args: string[]): number | undefined {
  return boundedIntegerOption(args, '--limit', { min: 1 });
}

export async function runThreadCli(
  action: string | undefined,
  args: string[],
  call: Call,
  interaction?: CliInteraction,
): Promise<unknown> {
  if (action === 'list') {
    const state = threadState(args);
    const input = {
      state,
      limit: limit(args),
      cursor: take(args, '--cursor'),
      creatorIdentityId: take(args, '--creator'),
      titlePrefix: take(args, '--title-prefix'),
    };
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown thread list argument.');
    return call('listThreads', input);
  }
  if (action === 'create') {
    const description = take(args, '--description') ?? '';
    const title = args.shift();
    requireThat(title && args.length === 0, 'INVALID_ARGUMENT', 'Pass one quoted thread title.');
    return call('createThread', { title, description });
  }
  if (action === 'search') {
    const query = args.shift();
    const state = threadState(args);
    const input = { query, state, limit: limit(args) };
    requireThat(
      query && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread search QUERY [--archived|--deleted] [--limit N].',
    );
    return call('searchThreads', input);
  }
  const id = args.shift();
  requireThat(id, 'INVALID_ARGUMENT', 'Pass a thread ID.');
  if (action === 'get') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown thread get argument.');
    return call('getThread', { threadId: id });
  }
  if (action === 'show') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown thread show argument.');
    const turn = await acquire(call, 'thread', id);
    try {
      return turn;
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'rename') {
    const title = args.shift();
    requireThat(
      title && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread rename THREAD_ID TITLE.',
    );
    return mutation(call, 'thread', id, { kind: 'renameThread', title });
  }
  if (action === 'describe') {
    const description = take(args, '--description');
    const clear = booleanFlag(args, '--clear');
    requireThat(
      (description !== undefined) !== clear && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread describe THREAD_ID (--description TEXT | --clear).',
    );
    return mutation(call, 'thread', id, {
      kind: 'setThreadDescription',
      description: description ?? '',
    });
  }
  if (action === 'follow' || action === 'unfollow') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', `Unknown thread ${action} argument.`);
    return call(action === 'follow' ? 'followThread' : 'unfollowThread', { threadId: id });
  }
  if (action === 'archive' || action === 'activate') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', `Unknown thread ${action} argument.`);
    return mutation(call, 'thread', id, {
      kind: action === 'archive' ? 'archiveThread' : 'activateThread',
    });
  }
  if (action === 'delete') {
    const confirmed = booleanFlag(args, '--yes');
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Use thread delete THREAD_ID [--yes].');
    requireThat(
      confirmed || interaction?.interactive,
      'CONFIRMATION_REQUIRED',
      'Use thread delete THREAD_ID --yes outside an interactive terminal.',
    );
    if (!confirmed) {
      const current = await call('getThread', { threadId: id });
      if (
        !(await interaction!.confirm('Delete this thread?', {
          request: { command: 'thread', action: 'get' },
          value: current,
        }))
      )
        return cancelledResult;
    }
    return mutation(call, 'thread', id, { kind: 'deleteThread' });
  }
  if (action === 'retract' || action === 'reinstate') {
    const messageId = args.shift();
    requireThat(
      messageId && args.length === 0,
      'INVALID_ARGUMENT',
      `Use thread ${action} THREAD_ID MESSAGE_ID.`,
    );
    return mutation(call, 'thread', id, {
      kind: action === 'retract' ? 'retractMessage' : 'reinstateMessage',
      messageId,
    });
  }
  if (action === 'history') {
    requireThat(args.length === 0, 'INVALID_ARGUMENT', 'Unknown thread history argument.');
    const turn = await acquire(call, 'thread', id);
    try {
      return await call('listHistory', { turn: credential(turn), limit: 100, offset: 0 });
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'revision') {
    const revision = args.shift();
    requireThat(
      revision && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread revision THREAD_ID REVISION.',
    );
    const turn = await acquire(call, 'thread', id);
    try {
      const messages: unknown[] = [];
      let cursor: string | undefined;
      let thread: unknown;
      do {
        const result = await call<{
          page: { messages: unknown[]; thread?: unknown };
          nextCursor?: string | null;
        }>('readRevision', { turn: credential(turn), revision, ...(cursor ? { cursor } : {}) });
        messages.push(...result.page.messages);
        thread ??= result.page.thread;
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      return { thread, messages, revision };
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'diff') {
    const revision = args.shift();
    requireThat(
      revision && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread diff THREAD_ID REVISION.',
    );
    const turn = await acquire(call, 'thread', id);
    try {
      return await call('diffRevision', { turn: credential(turn), revision });
    } finally {
      await release(call, turn);
    }
  }
  if (action === 'restore') {
    const revision = args.shift();
    const confirmed = booleanFlag(args, '--yes');
    requireThat(
      revision && args.length === 0,
      'INVALID_ARGUMENT',
      'Use thread restore THREAD_ID REVISION [--yes].',
    );
    const preview = async (turn: Turn) =>
      call<Record<string, unknown>>('previewRestore', {
        turn: credential(turn),
        revision,
      });
    const previewAndRelease = async () => {
      const turn = await acquire(call, 'thread', id);
      try {
        return await preview(turn);
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
            ? 'The thread changed while you reviewed it. Apply this updated restore preview?'
            : 'Apply this thread restore?',
          { request: { command: 'thread', action: 'restore' }, value: reviewed },
        );
        if (!accepted) return cancelledResult;
        const turn = await acquire(call, 'thread', id);
        let consumed = false;
        try {
          const current = await preview(turn);
          if (comparablePreview(current) !== comparablePreview(reviewed)) {
            reviewed = current;
            changed = true;
            continue;
          }
          const result = await call('restoreRevision', {
            turn: credential(turn),
            previewToken: current.previewToken,
          });
          consumed = true;
          return result;
        } finally {
          if (!consumed) await release(call, turn).catch(() => {});
        }
      }
    }
    const turn = await acquire(call, 'thread', id);
    let consumed = false;
    try {
      const current = await preview(turn);
      if (!confirmed) return current;
      const result = await call('restoreRevision', {
        turn: credential(turn),
        previewToken: current.previewToken,
      });
      consumed = true;
      return result;
    } finally {
      if (!consumed) await release(call, turn).catch(() => {});
    }
  }
  throw new BassfishError('INVALID_ARGUMENT', 'Unknown thread command.');
}
