import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BassfishError, requireThat } from './domain.js';

export type Call = <T = unknown>(name: string, args?: unknown) => Promise<T>;
export type Turn = { turn: { id: string; fencingToken: string }; snapshot: { revision: string }; page: { text?: string; note?: unknown }; nextCursor?: string | null };
export const credential = (turn: Turn) => ({ id: turn.turn.id, fencingToken: turn.turn.fencingToken });

export function take(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index+1];
  requireThat(value !== undefined && !value.startsWith('--'),'INVALID_ARGUMENT',`${name} requires a value.`); args.splice(index,2); return value;
}
function takeAll(args: string[], name: string): string[] { const output: string[] = []; let value: string | undefined; while ((value = take(args,name)) !== undefined) output.push(value); return output; }
export function booleanFlag(args: string[], name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index,1); return true; }
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
async function edit(dataDir: string, initial: string): Promise<string> {
  const editor = process.env.VISUAL ?? process.env.EDITOR; requireThat(editor,'EDITOR_UNAVAILABLE','Set VISUAL or EDITOR to an executable path.');
  const directory = await mkdtemp(join(dataDir,'editor-')); const path = join(directory,'note.md');
  try {
    await chmod(directory,0o700); await writeFile(path,initial,{ mode: 0o600 });
    const code = await new Promise<number | null>((resolve,reject) => { const child = spawn(editor,[path],{ stdio: 'inherit' }); child.once('error',reject); child.once('exit',resolve); });
    requireThat(code === 0,'EDITOR_FAILED','The editor exited without saving successfully.'); return await readFile(path,'utf8');
  } finally { await rm(directory,{ recursive: true, force: true }); }
}
async function source(args: string[], dataDir: string, initial = ''): Promise<string> {
  const file = take(args,'--file'); const useEditor = booleanFlag(args,'--editor');
  requireThat((file === undefined ? 0 : 1) + (useEditor ? 1 : 0) === 1,'INVALID_ARGUMENT','Choose exactly one of --file PATH, --file -, or --editor.');
  if (useEditor) return edit(dataDir,initial); return file === '-' ? stdin() : readFile(file!,'utf8');
}
export async function acquire(call: Call, type: 'note'|'thread', id: string): Promise<Turn> {
  const ticket = await call<{ state: string; requestId: string; offerId?: string }>('requestTurn',{ target: { type, id } });
  if (ticket.state !== 'offered') { await call('cancelTurnRequest',{ requestId: ticket.requestId }); throw new BassfishError('TURN_BUSY',`${type === 'note' ? 'Note' : 'Thread'} is busy. This request was cancelled, not retried.`); }
  return call<Turn>('claimTurn',{ offerId: ticket.offerId });
}
export async function release(call: Call, turn: Turn): Promise<void> { await call('releaseTurn',{ turn: credential(turn) }); }
async function fullNote(call: Call, turn: Turn): Promise<{ text: string; note: unknown }> {
  let text = turn.page.text ?? ''; let cursor = turn.nextCursor; const note = turn.page.note;
  while (cursor) { const page = await call<Turn>('readTurn',{ turn: credential(turn), cursor }); text += page.page.text ?? ''; cursor = page.nextCursor; }
  return { text, note };
}
export async function mutation(call: Call, type: 'note'|'thread', id: string, value: Record<string,unknown>): Promise<unknown> {
  const turn = await acquire(call,type,id); let consumed = false;
  try { const result = await call('commitTurn',{ turn: credential(turn), baseRevision: turn.snapshot.revision, mutation: value }); consumed = true; return result; }
  finally { if (!consumed) await release(call,turn).catch(() => {}); }
}

export async function runNoteCli(action: string | undefined, args: string[], call: Call, dataDir: string): Promise<{ value?: unknown; raw?: string }> {
  await mkdir(dataDir,{ recursive: true, mode: 0o700 });
  if (action === 'list') {
    const state = booleanFlag(args,'--archived') ? 'archived' : booleanFlag(args,'--deleted') ? 'deleted' : 'active';
    const input = { state, pathPrefix: take(args,'--path-prefix'), label: take(args,'--label'), noteKind: take(args,'--kind') };
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note list argument.'); return { value: await call('listNotes',input) };
  }
  if (action === 'create') {
    const path = args.shift(); const title = take(args,'--title'); requireThat(path && title,'INVALID_ARGUMENT','Use note create PATH --title TITLE with a body source.');
    const body = await source(args,dataDir); const labels = (take(args,'--labels') ?? '').split(',').filter(Boolean); const noteKind = take(args,'--kind') ?? null;
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note create argument.'); return { value: await call('createNote',{ path,title,body,labels,noteKind,links: [] }) };
  }
  const id = args.shift(); requireThat(id,'INVALID_ARGUMENT','Pass a note ID.');
  if (action === 'show') {
    const json = booleanFlag(args,'--json'); requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note show argument.'); const turn = await acquire(call,'note',id);
    try { const note = await fullNote(call,turn); return json ? { value: note } : { raw: note.text }; } finally { await release(call,turn); }
  }
  if (action === 'edit' && args.includes('--editor')) {
    const first = await acquire(call,'note',id); const original = await fullNote(call,first); await release(call,first);
    const body = await source(args,dataDir,original.text); requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note edit argument.');
    const second = await acquire(call,'note',id); let consumed = false;
    try {
      const latest = await fullNote(call,second); requireThat(latest.text === original.text,'EDIT_CONFLICT','The note changed while the editor was open; no write was attempted.');
      const value = await call('commitTurn',{ turn: credential(second), baseRevision: second.snapshot.revision, mutation: { kind: 'replaceNoteBody', body } }); consumed = true; return { value };
    } finally { if (!consumed) await release(call,second).catch(() => {}); }
  }
  if (['edit','append','prepend','patch'].includes(action ?? '')) {
    const body = await source(args,dataDir); requireThat(args.length === 0,'INVALID_ARGUMENT',`Unknown note ${action} argument.`);
    const kind = action === 'edit' ? 'replaceNoteBody' : action === 'append' ? 'appendNoteBody' : action === 'prepend' ? 'prependNoteBody' : 'patchNoteBody';
    return { value: await mutation(call,'note',id,{ kind, [action === 'patch' ? 'patch' : 'body']: body }) };
  }
  if (action === 'move') { const path = args.shift(); requireThat(path && args.length === 0,'INVALID_ARGUMENT','Use note move NOTE_ID PATH.'); return { value: await mutation(call,'note',id,{ kind: 'moveNote', path }) }; }
  if (action === 'metadata') {
    const title = take(args,'--title'); const labelsValue = take(args,'--labels'); const kindValue = take(args,'--kind'); const clearKind = booleanFlag(args,'--clear-kind');
    requireThat(!(kindValue && clearKind) && args.length === 0,'INVALID_ARGUMENT','Invalid note metadata arguments.'); const value = { kind: 'setNoteMetadata', ...(title ? { title } : {}), ...(labelsValue !== undefined ? { labels: labelsValue.split(',').filter(Boolean) } : {}), ...(kindValue ? { noteKind: kindValue } : clearKind ? { noteKind: null } : {}) };
    requireThat(Object.keys(value).length > 1,'INVALID_ARGUMENT','Provide metadata to change.'); return { value: await mutation(call,'note',id,value) };
  }
  if (action === 'links') {
    const links = takeAll(args,'--link').map(value => { const at = value.indexOf(':'); requireThat(at > 0,'INVALID_ARGUMENT','Links use TYPE:ID.'); return { targetType: value.slice(0,at), targetId: value.slice(at+1) }; });
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note links argument.'); return { value: await mutation(call,'note',id,{ kind: 'setLinks', links }) };
  }
  if (action === 'replace-text') {
    const find = take(args,'--find'); const replace = take(args,'--replace') ?? ''; const expectedOccurrences = Number(take(args,'--expect'));
    requireThat(find && Number.isInteger(expectedOccurrences) && args.length === 0,'INVALID_ARGUMENT','Use --find, --replace, and --expect N.'); return { value: await mutation(call,'note',id,{ kind: 'replaceNoteText', find, replace, expectedOccurrences }) };
  }
  if (action === 'section') {
    const heading = take(args,'--heading'); const occurrenceRaw = take(args,'--occurrence'); const createIfMissing = booleanFlag(args,'--create'); requireThat(heading,'INVALID_ARGUMENT','Use --heading A/B.');
    const body = await source(args,dataDir); requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note section argument.'); return { value: await mutation(call,'note',id,{ kind: 'upsertNoteSection', headingPath: heading.split('/').filter(Boolean), body, ...(occurrenceRaw ? { occurrence: Number(occurrenceRaw) } : {}), createIfMissing }) };
  }
  if (['archive','delete','activate'].includes(action ?? '')) { requireThat(args.length === 0,'INVALID_ARGUMENT',`Unknown note ${action} argument.`); return { value: await mutation(call,'note',id,{ kind: `${action}Note` }) }; }
  if (action === 'history') {
    requireThat(args.length === 0,'INVALID_ARGUMENT','Unknown note history argument.'); const turn = await acquire(call,'note',id); try { return { value: await call('listHistory',{ turn: credential(turn), limit: 100, offset: 0 }) }; } finally { await release(call,turn); }
  }
  if (action === 'restore') {
    const revision = args.shift(); requireThat(revision && booleanFlag(args,'--yes') && args.length === 0,'INVALID_ARGUMENT','Use note restore NOTE_ID REVISION --yes.'); const turn = await acquire(call,'note',id); let consumed = false;
    try { const preview = await call<{ previewToken: string }>('previewRestore',{ turn: credential(turn), revision }); const value = await call('restoreRevision',{ turn: credential(turn), previewToken: preview.previewToken }); consumed = true; return { value }; }
    finally { if (!consumed) await release(call,turn).catch(() => {}); }
  }
  throw new BassfishError('INVALID_ARGUMENT','Unknown note command.');
}
