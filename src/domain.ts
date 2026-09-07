export class BassfishError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'BassfishError';
  }
}

export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new BassfishError(code, message);
}

export interface Actor {
  projectId: string;
  identityId: string;
  instanceId: string;
  name: string;
}
export interface Project { id: string; commonDir: string; recovering: boolean }
export interface Identity { id: string; projectId: string; name: string }
export interface Instance {
  id: string; projectId: string; identityId: string; handle: string;
  epoch: string; active: boolean; lastSeen: number;
}
export type ContentResourceType = 'thread' | 'note';
export type ResourceType = ContentResourceType | 'project';
export interface Resource { id: string; projectId: string; type: ResourceType; fence: string; queueSequence: string; present: boolean }
export type TurnState = 'QUEUED' | 'READY' | 'OFFERED' | 'CLAIMED' | 'COMMITTING' | 'COMMITTED' | 'RELEASED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';
export interface TurnRequest {
  id: string; projectId: string; resourceId: string; resourceType: ResourceType; identityId: string; instanceId: string;
  sequence: string; state: TurnState; createdAt: number; queueUntil: number;
  reconnectUntil?: number; offerId?: string; claimBy?: number;
  turnId?: string; fence?: string; baseRevision?: string; snapshotCommit?: string;
  expiresAt?: number; finishedAt?: number; result?: StorageResult;
  purpose?: 'snapshot' | 'export' | 'search' | 'restore';
  deliveryMode: 'ticket' | 'task';
  updatedAt: number;
}
export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';
export interface DurableTask {
  id: string; projectId: string; identityId: string; requestId: string; status: TaskStatus;
  statusMessage?: string; createdAt: number; updatedAt: number; discardAt: number;
  result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> };
}
export interface PendingCommit {
  id: string; projectId: string; resourceId: string; resourceType: ResourceType; turnRequestId?: string;
  startingHead: string; kind: string; actor: Actor;
}
export interface ControlState {
  projects: Record<string, Project>;
  identities: Record<string, Identity>;
  instances: Record<string, Instance>;
  resources: Record<string, Resource>;
  requests: Record<string, TurnRequest>;
  pending: Record<string, PendingCommit>;
  tasks: Record<string, DurableTask>;
  wallClockHighWaterMs: number;
}
export interface ControlStore {
  view<T>(fn: (state: ControlState) => T): T;
  update<T>(fn: (state: ControlState) => T): T;
  close(): void;
}
export interface Clock { now(): number; wallNow(): number; discontinuity(): boolean }
export type ThreadState = 'active' | 'archived' | 'deleted';
export interface Thread {
  id: string; title: string; description: string; state: ThreadState;
  revision: string; headSequence: string; creator: string; createdAt: string;
}
export type NoteState = 'active' | 'archived' | 'deleted';
export type LinkTargetType = 'note' | 'thread' | 'message';
export interface ResourceLink { targetType: LinkTargetType; targetId: string }
export interface Note {
  id: string; path: string; title: string; body: string; labels: string[]; kind: string | null;
  state: NoteState; revision: string; creator: string; creatorName: string;
  lastEditor: string; lastEditorName: string; createdAt: string; updatedAt: string;
  links: ResourceLink[];
}
export interface Message {
  id: string; threadId: string; sequence: string; identityId: string; name: string;
  instanceId: string; createdAt: string; body: string; retracted?: boolean;
}
export interface Snapshot {
  resourceType: 'thread';
  thread: Thread; commit: string; messages: Message[]; truncated: boolean; nextBefore: string | null;
}
export interface NotePage {
  text: string; startLine: number; endLine: number; startByte: number; endByte: number;
  truncated: boolean; nextCursor: string | null;
}
export interface NoteSnapshot { resourceType: 'note'; note: Note; commit: string; page: NotePage }
export type ResourceSnapshot = Snapshot | NoteSnapshot;
export type ThreadMutation =
  | { kind: 'appendMessage'; body: string }
  | { kind: 'renameThread'; title: string }
  | { kind: 'setThreadDescription'; description: string }
  | { kind: 'archiveThread' }
  | { kind: 'activateThread' }
  | { kind: 'deleteThread' }
  | { kind: 'retractMessage'; messageId: string }
  | { kind: 'reinstateMessage'; messageId: string }
  | { kind: 'restoreThreadRevision'; targetRevision: string };
export type NoteMutation =
  | { kind: 'replaceNoteBody'; body: string }
  | { kind: 'patchNoteBody'; patch: string }
  | { kind: 'appendNoteBody'; body: string }
  | { kind: 'prependNoteBody'; body: string }
  | { kind: 'moveNote'; path: string }
  | { kind: 'setNoteMetadata'; title?: string; labels?: string[]; noteKind?: string | null }
  | { kind: 'setLinks'; links: ResourceLink[] }
  | { kind: 'archiveNote' }
  | { kind: 'deleteNote' }
  | { kind: 'activateNote' }
  | { kind: 'replaceNoteText'; find: string; replace: string; expectedOccurrences: number }
  | { kind: 'upsertNoteSection'; headingPath: string[]; body: string; occurrence?: number; createIfMissing: boolean }
  | { kind: 'batchNote'; mutations: Exclude<NoteMutation, { kind: 'batchNote' }>[] };
export type Mutation = ThreadMutation | NoteMutation;
export interface ThreadWriteOperation {
  id: string; actor: Actor; resourceId: string; at: string;
  resourceType: 'thread'; thread: Thread; mutation: ThreadMutation | { kind: 'createThread' };
  visibilityChanges?: { messageId: string; visible: boolean }[];
}
export interface NoteWriteOperation {
  id: string; actor: Actor; resourceId: string; at: string;
  resourceType: 'note'; note: Note; mutation: NoteMutation | { kind: 'createNote' };
}
export type WriteOperation = ThreadWriteOperation | NoteWriteOperation;
export interface MutationResult {
  resourceId: string; previousRevision: string; revision: string; doltCommit: string;
  messageId?: string; sequence?: string;
}
export interface HistoryEntry {
  operationId: string; kind: string; actorIdentityId: string; actorName: string; instanceId: string;
  createdAt: string; reason: string | null; beforeRevision: string; afterRevision: string; doltCommit: string;
}
export interface MessageVisibility { messageId: string; threadId: string; visible: boolean; threadRevision: string; operationId: string; createdAt: string }
export interface ProjectSnapshot { commit: string; threads: Thread[]; messages: Message[]; notes: Note[]; visibility: MessageVisibility[] }
export interface ProjectHistoryEntry { operationId: string; kind: string; actorIdentityId: string; actorName: string; instanceId: string; createdAt: string; doltCommit: string }
export interface ProjectRestoreChange { resourceType: ContentResourceType; resourceId: string; action: 'create' | 'update' | 'delete'; beforeRevision: string; afterRevision: string }
export interface ProjectRestoreResult {
  operationId: string; targetCommit: string; previousCommit: string; doltCommit: string;
  changes: ProjectRestoreChange[];
}
export interface ProjectRestoreOperation {
  id: string; actor: Actor; resourceId: string; resourceType: 'project'; at: string;
  mutation: { kind: 'restoreSnapshot'; targetCommit: string };
  target: ProjectSnapshot; current: ProjectSnapshot; changes: ProjectRestoreChange[];
}
export type StorageResult = MutationResult | ProjectRestoreResult;
export type Resolution = { state: 'committed'; result: StorageResult } | { state: 'absent' } | { state: 'unknown' };
export interface ContentStore {
  ensureProject(projectId: string): Promise<void>;
  head(projectId: string): Promise<string>;
  listThreads(projectId: string): Promise<Thread[]>;
  listNotes(projectId: string): Promise<Note[]>;
  resourceType(projectId: string, resourceId: string): Promise<ContentResourceType>;
  snapshot(projectId: string, resourceId: string, limit: number, before?: string, at?: string): Promise<Snapshot>;
  noteSnapshot(projectId: string, resourceId: string, cursor?: string, at?: string): Promise<NoteSnapshot>;
  history(projectId: string, resourceType: ContentResourceType, resourceId: string): Promise<HistoryEntry[]>;
  commitAtRevision(projectId: string, resourceType: ContentResourceType, resourceId: string, revision: string): Promise<string>;
  projectSnapshot(projectId: string, at?: string): Promise<ProjectSnapshot>;
  projectHistory(projectId: string): Promise<ProjectHistoryEntry[]>;
  maxRevision(projectId: string, resourceType: ContentResourceType, resourceId: string): Promise<string>;
  maxSequence(projectId: string, threadId: string): Promise<string>;
  historicalNotes(projectId: string, at: string): Promise<HistoricalNote[]>;
  write(operation: WriteOperation | ProjectRestoreOperation): Promise<StorageResult>;
  resolve(pending: PendingCommit): Promise<Resolution>;
  close(): Promise<void>;
}
export interface HistoricalNote { note: Note; doltCommit: string; changedAt: string }
export const activeStates: TurnState[] = ['QUEUED', 'READY', 'OFFERED', 'CLAIMED', 'COMMITTING'];
export const reservedStates: TurnState[] = ['READY', 'OFFERED', 'CLAIMED', 'COMMITTING'];
export const increment = (value: string): string => (BigInt(value) + 1n).toString();

export function prepareMutation(thread: Thread, mutation: ThreadMutation): Thread {
  const next = { ...thread, revision: increment(thread.revision) };
  switch (mutation.kind) {
    case 'appendMessage':
      requireThat(thread.state === 'active', 'RESOURCE_ARCHIVED', 'Restore the thread before appending.');
      next.headSequence = increment(thread.headSequence);
      break;
    case 'renameThread':
      requireThat(thread.title !== mutation.title, 'NO_CHANGE', 'The title is unchanged.');
      next.title = mutation.title;
      break;
    case 'setThreadDescription':
      requireThat(thread.description !== mutation.description, 'NO_CHANGE', 'The description is unchanged.');
      next.description = mutation.description;
      break;
    case 'archiveThread':
      requireThat(thread.state === 'active', 'NO_CHANGE', 'Only an active thread can be archived.');
      next.state = 'archived';
      break;
    case 'activateThread':
      requireThat(thread.state !== 'active', 'NO_CHANGE', 'The thread is already active.');
      next.state = 'active';
      break;
    case 'deleteThread':
      requireThat(thread.state !== 'deleted', 'NO_CHANGE', 'The thread is already deleted.');
      next.state = 'deleted';
      break;
    case 'retractMessage':
    case 'reinstateMessage':
    case 'restoreThreadRevision':
      break;
  }
  return next;
}

export function notePage(body: string, cursor?: string, maxLines = 200, maxBytes = 32 * 1024): NotePage {
  let startByte = 0;
  if (cursor !== undefined) {
    requireThat(/^(0|[1-9][0-9]*)$/.test(cursor), 'INVALID_CURSOR', 'The note cursor is invalid.');
    startByte = Number(cursor);
  }
  const bytes = Buffer.from(body, 'utf8');
  requireThat(startByte >= 0 && startByte <= bytes.length, 'INVALID_CURSOR', 'The note cursor is outside the body.');
  let endByte = Math.min(bytes.length, startByte + maxBytes);
  while (endByte > startByte && (bytes[endByte] ?? 0) >= 0x80 && (bytes[endByte] ?? 0) < 0xc0) endByte--;
  const prefix = bytes.subarray(0, startByte).toString('utf8');
  const candidate = bytes.subarray(startByte, endByte).toString('utf8');
  const lines = candidate.split('\n');
  if (lines.length > maxLines) {
    const limited = lines.slice(0, maxLines).join('\n') + '\n';
    endByte = startByte + Buffer.byteLength(limited);
  }
  const text = bytes.subarray(startByte, endByte).toString('utf8');
  const startLine = prefix.split('\n').length;
  const endLine = startLine + Math.max(0, text.split('\n').length - 1);
  return { text, startLine, endLine, startByte, endByte, truncated: endByte < bytes.length, nextCursor: endByte < bytes.length ? String(endByte) : null };
}
