import { z } from 'zod';

const id = z.string().min(1).max(200);
const counter = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const turn = z.object({ id, fencingToken: counter }).strict();
const withTurn = { turn };
const title = z.string().trim().min(1).max(200);
const threadDescription = z.string().max(2000);
const threadState = z.enum(['active','archived','deleted']);
export const notePathSchema = z.string().max(240).regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?){0,15}$/);
const noteToken = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const noteBody = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024, 'Note body exceeds 256 KiB.');
const links = z.array(z.object({ targetType: z.enum(['note', 'thread', 'message']), targetId: id }).strict()).max(64);
const noteMutationBase = [
  z.object({ kind: z.literal('replaceNoteBody'), body: noteBody }).strict(),
  z.object({ kind: z.literal('patchNoteBody'), patch: z.string().min(1).max(512 * 1024) }).strict(),
  z.object({ kind: z.literal('appendNoteBody'), body: z.string().min(1).max(256 * 1024) }).strict(),
  z.object({ kind: z.literal('prependNoteBody'), body: z.string().min(1).max(256 * 1024) }).strict(),
  z.object({ kind: z.literal('moveNote'), path: notePathSchema }).strict(),
  z.object({ kind: z.literal('setNoteMetadata'), title: title.optional(), labels: z.array(noteToken).max(16).optional(), noteKind: noteToken.nullable().optional() }).strict(),
  z.object({ kind: z.literal('setLinks'), links }).strict(),
  z.object({ kind: z.literal('archiveNote') }).strict(),
  z.object({ kind: z.literal('deleteNote') }).strict(),
  z.object({ kind: z.literal('activateNote') }).strict(),
  z.object({ kind: z.literal('replaceNoteText'), find: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal('upsertNoteSection'), headingPath: z.array(z.string().trim().min(1).max(200)).min(1).max(6), body: noteBody, occurrence: z.number().int().min(1).optional(), createIfMissing: z.boolean().default(false) }).strict(),
] as const;
const mutation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('appendMessage'), body: z.string().min(1).max(16_000) }).strict(),
  z.object({ kind: z.literal('renameThread'), title }).strict(),
  z.object({ kind: z.literal('setThreadDescription'), description: threadDescription }).strict(),
  z.object({ kind: z.literal('archiveThread') }).strict(),
  z.object({ kind: z.literal('activateThread') }).strict(),
  z.object({ kind: z.literal('deleteThread') }).strict(),
  z.object({ kind: z.literal('retractMessage'), messageId: id }).strict(),
  z.object({ kind: z.literal('reinstateMessage'), messageId: id }).strict(),
  ...noteMutationBase,
  z.object({ kind: z.literal('batchNote'), mutations: z.array(z.discriminatedUnion('kind', noteMutationBase)).min(1).max(32) }).strict(),
]);
const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread'), id }).strict(),
  z.object({ type: z.literal('note'), id }).strict(),
  z.object({ type: z.literal('project'), purpose: z.enum(['snapshot','export','search','restore']) }).strict(),
]);

export const schemas = {
  getSession: z.object({}).strict(),
  setAgentName: z.object({ name: nameSchema }).strict(),
  listAgents: z.object({}).strict(),
  createThread: z.object({ title, description: threadDescription.default('') }).strict(),
  listThreads: z.object({ state: threadState.default('active'), creatorIdentityId: id.optional(), titlePrefix: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(500).optional() }).strict(),
  getThread: z.object({ threadId: id }).strict(),
  searchThreads: z.object({ query: z.string().trim().min(1).max(200), state: threadState.default('active'), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  createNote: z.object({ path: notePathSchema, title, body: noteBody.default(''), labels: z.array(noteToken).max(16).default([]), noteKind: noteToken.nullable().default(null), links: links.default([]) }).strict(),
  listNotes: z.object({ pathPrefix: z.string().max(240).optional(), label: noteToken.optional(), noteKind: noteToken.optional(), state: z.enum(['active','archived','deleted']).default('active'), creatorIdentityId: id.optional(), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(500).optional() }).strict(),
  searchNotes: z.object({ query: z.string().trim().min(1).max(200), state: z.enum(['active','archived','deleted']).default('active'), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  requestTurn: z.object({ target }).strict(),
  getTurnRequest: z.object({ requestId: id }).strict(),
  waitForTurn: z.object({ requestId: id, timeoutMs: z.number().int().min(0).max(20_000).default(20_000) }).strict(),
  cancelTurnRequest: z.object({ requestId: id }).strict(),
  claimTurn: z.object({ offerId: id }).strict(),
  readTurn: z.object({ ...withTurn, cursor: z.string().max(500).optional() }).strict(),
  releaseTurn: z.object(withTurn).strict(),
  commitTurn: z.object({ ...withTurn, baseRevision: counter, mutation }).strict(),
  listHistory: z.object({ ...withTurn, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  readRevision: z.object({ ...withTurn, revision: counter, cursor: z.string().max(500).optional() }).strict(),
  diffRevision: z.object({ ...withTurn, revision: counter }).strict(),
  previewRestore: z.object({ ...withTurn, revision: counter }).strict(),
  restoreRevision: z.object({ ...withTurn, previewToken: z.string().min(1).max(4096) }).strict(),
  getNoteOutline: z.object(withTurn).strict(),
  findInNote: z.object({ ...withTurn, query: z.string().min(1).max(1024), mode: z.enum(['literal','regex']).default('literal'), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  inspectSnapshot: z.object(withTurn).strict(),
  searchProjectNotes: z.object({ ...withTurn, query: z.string().min(1).max(1024), states: z.array(z.enum(['active','archived','deleted'])).min(1).max(3).default(['active']), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  searchProjectNoteHistory: z.object({ ...withTurn, query: z.string().min(1).max(1024), noteId: id.optional(), states: z.array(z.enum(['active','archived','deleted'])).min(1).max(3).default(['active','archived','deleted']), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  exportSnapshot: z.object(withTurn).strict(),
  listSnapshotHistory: z.object({ ...withTurn, limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(4096).optional() }).strict(),
  previewSnapshotRestore: z.object({ ...withTurn, targetCommit: z.string().min(8).max(128), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  restoreSnapshot: z.object({ ...withTurn, previewToken: z.string().min(1).max(4096) }).strict(),
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof schemas;
export const descriptions: Record<ToolName, string> = {
  getSession: 'Get the current repository-scoped Bassfish session and pending requests.',
  setAgentName: 'Choose or reclaim an inactive repository-scoped agent identity.',
  listAgents: 'List repository-scoped agent identities and current liveness.',
  createThread: 'Create a thread in one semantic Dolt commit.',
  listThreads: 'List thread metadata, including descriptions, without message bodies.',
  getThread: 'Get one thread\'s metadata, including its description, without message bodies.',
  searchThreads: 'Search thread titles and descriptions without message bodies.',
  createNote: 'Create a uniquely addressed note; never upserts.',
  listNotes: 'List note metadata without bodies or snippets.',
  searchNotes: 'Search note metadata without bodies or snippets.',
  requestTurn: 'Request FIFO access to a thread, note, or drained project operation.',
  getTurnRequest: 'Inspect one durable turn request without retrying it.',
  waitForTurn: 'Wait briefly for an existing request while preserving FIFO position.',
  cancelTurnRequest: 'Cancel a queued request or unclaimed offer.',
  claimTurn: 'Claim an offer, read a fresh snapshot, and start the hard lease.',
  readTurn: 'Read the next cursor-bounded page from the claimed snapshot.',
  releaseTurn: 'Release a claimed turn without writing.',
  commitTurn: 'Commit one revision-bound mutation and release; never retries.',
  listHistory: 'List semantic operations for the claimed resource.',
  readRevision: 'Read a historical revision under the current turn.',
  diffRevision: 'Compare a historical revision with current claimed content.',
  previewRestore: 'Bind a historical restore preview to the current turn.',
  restoreRevision: 'Apply a validated preview as a new revision and release.',
  getNoteOutline: 'Return Markdown headings and line ranges for the claimed note.',
  findInNote: 'Return bounded literal or RE2-compatible matches in the claimed note.',
  inspectSnapshot: 'Inspect the Dolt snapshot pinned by a project turn.',
  searchProjectNotes: 'Search note bodies under a search project turn.',
  searchProjectNoteHistory: 'Search all semantic note revisions under a search project turn.',
  exportSnapshot: 'Write a deterministic ZIP from an export project turn.',
  listSnapshotHistory: 'List semantic project commits under a restore project turn.',
  previewSnapshotRestore: 'Preview an exact visible-state project restore and bind it to this turn.',
  restoreSnapshot: 'Apply a validated project restore preview in one Dolt commit and release.',
};
