import { BassfishError, requireThat } from './domain.js';
import { acquire, booleanFlag, mutation, release, take } from './note-cli.js';
import type { Call } from './note-cli.js';

function threadState(args: string[]): 'active' | 'archived' | 'deleted' {
  const archived = booleanFlag(args,'--archived'); const deleted = booleanFlag(args,'--deleted');
  requireThat(!(archived && deleted),'INVALID_ARGUMENT','Choose at most one of --archived or --deleted.');
  return archived ? 'archived' : deleted ? 'deleted' : 'active';
}
function limit(args: string[]): number | undefined {
  const raw = take(args,'--limit'); if (raw === undefined) return undefined;
  requireThat(/^[1-9][0-9]*$/.test(raw),'INVALID_ARGUMENT','--limit takes a positive integer.'); return Number(raw);
}

export async function runThreadCli(action: string | undefined, args: string[], call: Call): Promise<unknown> {
  if (action === 'list') {
    const state = threadState(args); const input = { state, limit: limit(args), cursor: take(args,'--cursor'), creatorIdentityId: take(args,'--creator'), titlePrefix: take(args,'--title-prefix') };
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown thread list argument.'); return call('listThreads',input);
  }
  if (action === 'create') {
    const description = take(args,'--description') ?? ''; const title = args.shift();
    requireThat(title && args.length === 0,'INVALID_ARGUMENT','Pass one quoted thread title.'); return call('createThread',{ title, description });
  }
  if (action === 'search') {
    const query = args.shift(); const state = threadState(args); const input = { query, state, limit: limit(args) };
    requireThat(query && args.length === 0,'INVALID_ARGUMENT','Use thread search QUERY [--archived|--deleted] [--limit N].'); return call('searchThreads',input);
  }
  const id = args.shift(); requireThat(id,'INVALID_ARGUMENT','Pass a thread ID.');
  if (action === 'get') { requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown thread get argument.'); return call('getThread',{ threadId: id }); }
  if (action === 'show') {
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown thread show argument.'); const floor = await acquire(call,'thread',id);
    try { return floor; } finally { await release(call,floor); }
  }
  if (action === 'describe') {
    const description = take(args,'--description'); const clear = booleanFlag(args,'--clear');
    requireThat((description !== undefined) !== clear && args.length === 0,'INVALID_ARGUMENT','Use thread describe THREAD_ID (--description TEXT | --clear).');
    return mutation(call,'thread',id,{ kind: 'setThreadDescription', description: description ?? '' });
  }
  if (action === 'delete') { requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown thread delete argument.'); return mutation(call,'thread',id,{ kind: 'deleteThread' }); }
  throw new BassfishError('INVALID_ARGUMENT','Unknown thread command.');
}
