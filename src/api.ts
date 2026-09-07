import { z } from 'zod';

const id = z.string().min(1).max(200);
const counter = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const floor = z.object({ id, fencingToken: counter }).strict();
const withFloor = { floor };
const title = z.string().trim().min(1).max(200);
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
  z.object({ kind: z.literal('archiveThread') }).strict(),
  z.object({ kind: z.literal('activateThread') }).strict(),
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
  createThread: z.object({ title, description: z.string().max(2000).default('') }).strict(),
  listThreads: z.object({ state: z.enum(['active','archived']).default('active') }).strict(),
  createNote: z.object({ path: notePathSchema, title, body: noteBody.default(''), labels: z.array(noteToken).max(16).default([]), noteKind: noteToken.nullable().default(null), links: links.default([]) }).strict(),
  listNotes: z.object({ pathPrefix: z.string().max(240).optional(), label: noteToken.optional(), noteKind: noteToken.optional(), state: z.enum(['active','archived','deleted']).default('active'), creatorIdentityId: id.optional(), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(500).optional() }).strict(),
  searchNotes: z.object({ query: z.string().trim().min(1).max(200), state: z.enum(['active','archived','deleted']).default('active'), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  requestFloor: z.object({ target }).strict(),
  getFloorRequest: z.object({ requestId: id }).strict(),
  waitForFloor: z.object({ requestId: id, timeoutMs: z.number().int().min(0).max(20_000).default(20_000) }).strict(),
  cancelFloorRequest: z.object({ requestId: id }).strict(),
  claimFloor: z.object({ offerId: id }).strict(),
  readFloor: z.object({ ...withFloor, cursor: z.string().max(500).optional() }).strict(),
  releaseFloor: z.object(withFloor).strict(),
  commitFloor: z.object({ ...withFloor, baseRevision: counter, mutation }).strict(),
  listHistory: z.object({ ...withFloor, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  readRevision: z.object({ ...withFloor, revision: counter, cursor: z.string().max(500).optional() }).strict(),
  diffRevision: z.object({ ...withFloor, revision: counter }).strict(),
  previewRestore: z.object({ ...withFloor, revision: counter }).strict(),
  restoreRevision: z.object({ ...withFloor, previewToken: z.string().min(1).max(4096) }).strict(),
  getNoteOutline: z.object(withFloor).strict(),
  findInNote: z.object({ ...withFloor, query: z.string().min(1).max(1024), mode: z.enum(['literal','regex']).default('literal'), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  inspectSnapshot: z.object(withFloor).strict(),
  searchProjectNotes: z.object({ ...withFloor, query: z.string().min(1).max(1024), states: z.array(z.enum(['active','archived','deleted'])).min(1).max(3).default(['active']), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  searchProjectNoteHistory: z.object({ ...withFloor, query: z.string().min(1).max(1024), noteId: id.optional(), states: z.array(z.enum(['active','archived','deleted'])).min(1).max(3).default(['active','archived','deleted']), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  exportSnapshot: z.object(withFloor).strict(),
  listSnapshotHistory: z.object({ ...withFloor, limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(4096).optional() }).strict(),
  previewSnapshotRestore: z.object({ ...withFloor, targetCommit: z.string().min(8).max(128), limit: z.number().int().min(1).max(100).default(100), cursor: z.string().max(4096).optional() }).strict(),
  restoreSnapshot: z.object({ ...withFloor, previewToken: z.string().min(1).max(4096) }).strict(),
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof schemas;
export const descriptions: Record<ToolName, string> = {
  getSession: 'Get the current repository-scoped Bassfish session and pending requests.',
  setAgentName: 'Choose or reclaim an inactive repository-scoped agent identity.',
  listAgents: 'List repository-scoped agent identities and current liveness.',
  createThread: 'Create a thread in one semantic Dolt commit.',
  listThreads: 'List thread metadata without message bodies.',
  createNote: 'Create a uniquely addressed note; never upserts.',
  listNotes: 'List note metadata without bodies or snippets.',
  searchNotes: 'Search note metadata without bodies or snippets.',
  requestFloor: 'Request FIFO access to a thread, note, or drained project operation.',
  getFloorRequest: 'Inspect one durable floor request without retrying it.',
  waitForFloor: 'Wait briefly for an existing request while preserving FIFO position.',
  cancelFloorRequest: 'Cancel a queued request or unclaimed offer.',
  claimFloor: 'Claim an offer, read a fresh snapshot, and start the hard lease.',
  readFloor: 'Read the next cursor-bounded page from the claimed snapshot.',
  releaseFloor: 'Release a held floor without writing.',
  commitFloor: 'Commit one revision-bound mutation and release; never retries.',
  listHistory: 'List semantic operations for the held resource.',
  readRevision: 'Read a historical revision under the current floor.',
  diffRevision: 'Compare a historical revision with current held content.',
  previewRestore: 'Bind a historical restore preview to the current floor.',
  restoreRevision: 'Apply a validated preview as a new revision and release.',
  getNoteOutline: 'Return Markdown headings and line ranges for the held note.',
  findInNote: 'Return bounded literal or RE2-compatible matches in the held note.',
  inspectSnapshot: 'Inspect the Dolt snapshot pinned by a project floor.',
  searchProjectNotes: 'Search note bodies under a search project floor.',
  searchProjectNoteHistory: 'Search all semantic note revisions under a search project floor.',
  exportSnapshot: 'Write a deterministic ZIP from an export project floor.',
  listSnapshotHistory: 'List semantic project commits under a restore project floor.',
  previewSnapshotRestore: 'Preview an exact visible-state project restore and bind it to this floor.',
  restoreSnapshot: 'Apply a validated project restore preview in one Dolt commit and release.',
};
