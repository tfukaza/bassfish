import type { ActivityDraft } from './observation-types.js';

export class BassfishError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
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
export interface Project {
  id: string;
  commonDir: string;
  recovering: boolean;
}
export interface Identity {
  id: string;
  projectId: string;
  name: string;
}
export interface Instance {
  id: string;
  projectId: string;
  identityId: string;
  handle: string;
  epoch: string;
  active: boolean;
  lastSeen: number;
  workspace: string;
  host?: AgentHost;
  hostSessionId?: string;
}
export type AgentHost = 'claude' | 'codex' | 'opencode';
export type ContentResourceType = 'thread' | 'ticket';
export type ResourceType = ContentResourceType | 'project';
export interface Resource {
  id: string;
  projectId: string;
  type: ResourceType;
  fence: string;
  queueSequence: string;
  present: boolean;
}
export type TurnState =
  | 'QUEUED'
  | 'READY'
  | 'OFFERED'
  | 'CLAIMED'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'RELEASED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED';
interface TurnRequestBase {
  id: string;
  projectId: string;
  identityId: string;
  instanceId: string;
  sequence: string;
  state: TurnState;
  createdAt: number;
  queueUntil: number;
  reconnectUntil?: number;
  offerId?: string;
  claimBy?: number;
  turnId?: string;
  finishedAt?: number;
  deliveryMode: 'ticket' | 'task';
  updatedAt: number;
  claimedAt?: number;
  terminalReason?: string;
}
export interface ContentTurnRequest extends TurnRequestBase {
  resourceType: ResourceType;
  resourceId: string;
  fence?: string;
  baseRevision?: string;
  snapshotCommit?: string;
  expiresAt?: number;
  result?: StorageResult;
  purpose?: 'snapshot' | 'export' | 'restore';
}
export interface FileTarget {
  path: string;
  kind: 'file' | 'directory';
}
export interface FileTurnRequest extends TurnRequestBase {
  resourceType: 'files';
  paths: FileTarget[];
}
export type TurnRequest = ContentTurnRequest | FileTurnRequest;
type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';
export interface DurableTask {
  id: string;
  projectId: string;
  identityId: string;
  requestId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  discardAt: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}
export interface PendingCommit {
  id: string;
  projectId: string;
  resourceId: string;
  resourceType: ResourceType;
  turnRequestId?: string;
  startingHead: string;
  kind: string;
  actor: Actor;
  followIdentityId?: string;
  notificationRecipients?: Record<string, NotificationReason[]>;
  notificationIntents?: NotificationIntent[];
  notificationCreatedAt?: number;
  observation?: Record<string, unknown>;
}
export type NotificationReason =
  | 'direct_mention'
  | 'here'
  | 'global'
  | 'followed_message'
  | 'thread_activity'
  | 'ticket_assigned'
  | 'ticket_ready';
export interface NotificationIntent {
  identityId: string;
  resourceType: 'thread' | 'ticket';
  resourceId: string;
  reasons: NotificationReason[];
}
export interface ThreadFollow {
  projectId: string;
  threadId: string;
  identityId: string;
  createdAt: number;
}
export interface Notification {
  id: string;
  projectId: string;
  identityId: string;
  resourceType: 'thread' | 'ticket';
  resourceId: string;
  eventId: string;
  threadId?: string;
  ticketId?: string;
  messageId?: string;
  sequence?: string;
  senderIdentityId: string;
  senderName: string;
  createdAt: number;
  reasons: NotificationReason[];
  lastDeliveredWakeKey?: string;
}
export interface HostSessionBinding {
  projectId: string;
  identityId: string;
  host: AgentHost;
  sessionId: string;
  wakeKey: string;
  createdAt: number;
  updatedAt: number;
}
export interface ControlState {
  /** Transaction-local activity outbox; never loaded as retained history. */
  observationEvents?: ActivityDraft[];
  projects: Record<string, Project>;
  identities: Record<string, Identity>;
  instances: Record<string, Instance>;
  resources: Record<string, Resource>;
  requests: Record<string, TurnRequest>;
  pending: Record<string, PendingCommit>;
  tasks: Record<string, DurableTask>;
  follows: Record<string, ThreadFollow>;
  notifications: Record<string, Notification>;
  hostSessionBindings: Record<string, HostSessionBinding>;
  wallClockHighWaterMs: number;
  fileQueueSequence: string;
}
export interface ControlStore {
  view<T>(fn: (state: ControlState) => T): T;
  update<T>(fn: (state: ControlState) => T): T;
  close(): void;
}
export interface Clock {
  now(): number;
  wallNow(): number;
  discontinuity(): boolean;
}
type ThreadState = 'active' | 'archived' | 'deleted';
export interface Thread {
  id: string;
  title: string;
  description: string;
  state: ThreadState;
  revision: string;
  headSequence: string;
  creator: string;
  createdAt: string;
}
type TicketState = 'todo' | 'in_progress' | 'blocked' | 'done';
export interface Ticket {
  id: string;
  title: string;
  description: string;
  owner: string;
  ownerName: string;
  state: TicketState;
  body: string;
  dependsOn: string[];
  revision: string;
  creator: string;
  creatorName: string;
  lastEditor: string;
  lastEditorName: string;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  threadId: string;
  sequence: string;
  identityId: string;
  name: string;
  instanceId: string;
  createdAt: string;
  body: string;
  mentions?: { agents: string[]; here: boolean; global?: boolean };
  retracted?: boolean;
}
export interface Snapshot {
  resourceType: 'thread';
  thread: Thread;
  commit: string;
  messages: Message[];
  truncated: boolean;
  nextBefore: string | null;
}
export interface BodyPage {
  text: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  truncated: boolean;
  nextCursor: string | null;
}
export interface TicketSnapshot {
  resourceType: 'ticket';
  ticket: Ticket;
  commit: string;
  page: BodyPage;
}
export type ThreadMutation =
  | {
      kind: 'appendMessage';
      body: string;
      mentions?: { agents: string[]; here: boolean; global?: boolean };
    }
  | { kind: 'renameThread'; title: string }
  | { kind: 'setThreadDescription'; description: string }
  | { kind: 'archiveThread' }
  | { kind: 'activateThread' }
  | { kind: 'deleteThread' }
  | { kind: 'retractMessage'; messageId: string }
  | { kind: 'reinstateMessage'; messageId: string }
  | { kind: 'restoreThreadRevision'; targetRevision: string };
export type TicketMutation =
  | {
      kind: 'updateTicket';
      title?: string;
      description?: string;
      owner?: string;
      state?: TicketState;
      dependsOn?: string[];
    }
  | { kind: 'replaceTicketBody'; body: string }
  | { kind: 'appendTicketBody'; body: string }
  | { kind: 'patchTicketBody'; patch: string };
export type Mutation = ThreadMutation | TicketMutation;
interface ThreadWriteOperation {
  id: string;
  actor: Actor;
  resourceId: string;
  at: string;
  resourceType: 'thread';
  thread: Thread;
  mutation: ThreadMutation | { kind: 'createThread' };
  visibilityChanges?: { messageId: string; visible: boolean }[];
}
interface TicketWriteOperation {
  id: string;
  actor: Actor;
  resourceId: string;
  at: string;
  resourceType: 'ticket';
  ticket: Ticket;
  mutation: TicketMutation | { kind: 'createTicket' };
}
export type WriteOperation = ThreadWriteOperation | TicketWriteOperation;
export interface MutationResult {
  resourceId: string;
  previousRevision: string;
  revision: string;
  doltCommit: string;
  messageId?: string;
  sequence?: string;
}
export interface HistoryEntry {
  operationId: string;
  kind: string;
  actorIdentityId: string;
  actorName: string;
  instanceId: string;
  createdAt: string;
  reason: string | null;
  beforeRevision: string;
  afterRevision: string;
  doltCommit: string;
}
interface MessageVisibility {
  messageId: string;
  threadId: string;
  visible: boolean;
  threadRevision: string;
  operationId: string;
  createdAt: string;
}
export interface ProjectSnapshot {
  commit: string;
  threads: Thread[];
  messages: Message[];
  tickets: Ticket[];
  visibility: MessageVisibility[];
}
export interface ProjectHistoryEntry {
  operationId: string;
  kind: string;
  actorIdentityId: string;
  actorName: string;
  instanceId: string;
  createdAt: string;
  doltCommit: string;
}
export interface ProjectRestoreChange {
  resourceType: ContentResourceType;
  resourceId: string;
  action: 'create' | 'update' | 'delete';
  beforeRevision: string;
  afterRevision: string;
}
export interface ProjectRestoreResult {
  operationId: string;
  targetCommit: string;
  previousCommit: string;
  doltCommit: string;
  changes: ProjectRestoreChange[];
}
export interface ProjectRestoreOperation {
  id: string;
  actor: Actor;
  resourceId: string;
  resourceType: 'project';
  at: string;
  mutation: { kind: 'restoreSnapshot'; targetCommit: string };
  target: ProjectSnapshot;
  current: ProjectSnapshot;
  changes: ProjectRestoreChange[];
}
export type StorageResult = MutationResult | ProjectRestoreResult;
export type Resolution =
  { state: 'committed'; result: StorageResult } | { state: 'absent' } | { state: 'unknown' };
export interface ContentStore {
  ensureProject(projectId: string): Promise<void>;
  head(projectId: string): Promise<string>;
  listThreads(projectId: string): Promise<Thread[]>;
  listTickets(projectId: string, at?: string): Promise<Ticket[]>;
  resourceType(projectId: string, resourceId: string): Promise<ContentResourceType>;
  snapshot(
    projectId: string,
    resourceId: string,
    limit: number,
    before?: string,
    at?: string,
  ): Promise<Snapshot>;
  ticketSnapshot(
    projectId: string,
    resourceId: string,
    cursor?: string,
    at?: string,
  ): Promise<TicketSnapshot>;
  history(
    projectId: string,
    resourceType: ContentResourceType,
    resourceId: string,
  ): Promise<HistoryEntry[]>;
  commitAtRevision(
    projectId: string,
    resourceType: ContentResourceType,
    resourceId: string,
    revision: string,
  ): Promise<string>;
  projectSnapshot(projectId: string, at?: string): Promise<ProjectSnapshot>;
  projectHistory(projectId: string): Promise<ProjectHistoryEntry[]>;
  maxRevision(
    projectId: string,
    resourceType: ContentResourceType,
    resourceId: string,
  ): Promise<string>;
  maxSequence(projectId: string, threadId: string): Promise<string>;
  write(operation: WriteOperation | ProjectRestoreOperation): Promise<StorageResult>;
  resolve(pending: PendingCommit): Promise<Resolution>;
  close(): Promise<void>;
}
export const activeStates: TurnState[] = ['QUEUED', 'READY', 'OFFERED', 'CLAIMED', 'COMMITTING'];
export const reservedStates: TurnState[] = ['READY', 'OFFERED', 'CLAIMED', 'COMMITTING'];
export const increment = (value: string): string => (BigInt(value) + 1n).toString();

export function prepareMutation(thread: Thread, mutation: ThreadMutation): Thread {
  const next = { ...thread, revision: increment(thread.revision) };
  switch (mutation.kind) {
    case 'appendMessage':
      requireThat(
        thread.state === 'active',
        'RESOURCE_ARCHIVED',
        'Restore the thread before appending.',
      );
      next.headSequence = increment(thread.headSequence);
      break;
    case 'renameThread':
      requireThat(thread.title !== mutation.title, 'NO_CHANGE', 'The title is unchanged.');
      next.title = mutation.title;
      break;
    case 'setThreadDescription':
      requireThat(
        thread.description !== mutation.description,
        'NO_CHANGE',
        'The description is unchanged.',
      );
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

export function bodyPage(
  body: string,
  cursor?: string,
  maxLines = 200,
  maxBytes = 32 * 1024,
): BodyPage {
  let startByte = 0;
  if (cursor !== undefined) {
    requireThat(/^(0|[1-9][0-9]*)$/.test(cursor), 'INVALID_CURSOR', 'The body cursor is invalid.');
    startByte = Number(cursor);
  }
  const bytes = Buffer.from(body, 'utf8');
  requireThat(
    startByte >= 0 && startByte <= bytes.length,
    'INVALID_CURSOR',
    'The body cursor is outside the body.',
  );
  let endByte = Math.min(bytes.length, startByte + maxBytes);
  while (endByte > startByte && (bytes[endByte] ?? 0) >= 0x80 && (bytes[endByte] ?? 0) < 0xc0)
    endByte--;
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
  return {
    text,
    startLine,
    endLine,
    startByte,
    endByte,
    truncated: endByte < bytes.length,
    nextCursor: endByte < bytes.length ? String(endByte) : null,
  };
}
