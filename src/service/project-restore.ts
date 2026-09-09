import { createHmac } from 'node:crypto';
import {
  increment,
  type Actor,
  type ContentStore,
  type ProjectRestoreChange,
  type ProjectSnapshot,
  type Ticket,
} from '../domain.js';
import { validateTicketGraph } from '../ticket.js';

export interface BuiltProjectRestore {
  snapshot: ProjectSnapshot;
  changes: ProjectRestoreChange[];
  digest: string;
  summary: Record<string, unknown>;
}

function threadShape(snapshot: ProjectSnapshot, id: string): unknown {
  const thread = snapshot.threads.find(value => value.id === id);
  return {
    thread: thread
      ? (({ revision: _revision, headSequence: _sequence, ...rest }) => rest)(thread)
      : null,
    messages: snapshot.messages.filter(value => value.threadId === id),
    visibility: snapshot.visibility
      .filter(value => value.threadId === id)
      .map(({ threadRevision: _revision, ...rest }) => rest),
  };
}

function ticketShape(ticket: Ticket | undefined): unknown {
  if (!ticket) return null;
  const {
    revision: _revision,
    lastEditor: _lastEditor,
    lastEditorName: _lastEditorName,
    updatedAt: _updatedAt,
    ...rest
  } = ticket;
  return rest;
}

function summarize(
  changes: ProjectRestoreChange[],
  current: ProjectSnapshot,
  target: ProjectSnapshot,
) {
  const count = (resourceType: 'thread' | 'ticket', action: ProjectRestoreChange['action']) =>
    changes.filter(change => change.resourceType === resourceType && change.action === action)
      .length;
  return {
    threads: {
      create: count('thread', 'create'),
      update: count('thread', 'update'),
      delete: count('thread', 'delete'),
    },
    tickets: {
      create: count('ticket', 'create'),
      update: count('ticket', 'update'),
      delete: count('ticket', 'delete'),
    },
    messages: { current: current.messages.length, target: target.messages.length },
    visibility: { current: current.visibility.length, target: target.visibility.length },
  };
}

export async function buildProjectRestore(
  content: ContentStore,
  secret: Buffer,
  projectId: string,
  actor: Actor,
  current: ProjectSnapshot,
  target: ProjectSnapshot,
  at: string,
): Promise<BuiltProjectRestore> {
  const changes: ProjectRestoreChange[] = [];
  const currentThreads = new Map(current.threads.map(value => [value.id, value]));
  const targetThreads = new Map(target.threads.map(value => [value.id, value]));
  const currentTickets = new Map(current.tickets.map(value => [value.id, value]));
  const targetTickets = new Map(target.tickets.map(value => [value.id, value]));
  const changedThreads = new Map<string, string>();
  const changedTickets = new Map<string, string>();

  for (const id of new Set([...currentThreads.keys(), ...targetThreads.keys()])) {
    const before = currentThreads.get(id);
    const after = targetThreads.get(id);
    if (JSON.stringify(threadShape(current, id)) === JSON.stringify(threadShape(target, id))) {
      continue;
    }
    const next = increment(await content.maxRevision(projectId, 'thread', id));
    changedThreads.set(id, next);
    changes.push({
      resourceType: 'thread',
      resourceId: id,
      action: !before ? 'create' : !after ? 'delete' : 'update',
      beforeRevision: before?.revision ?? '0',
      afterRevision: next,
    });
  }
  for (const id of new Set([...currentTickets.keys(), ...targetTickets.keys()])) {
    const before = currentTickets.get(id);
    const after = targetTickets.get(id);
    if (JSON.stringify(ticketShape(before)) === JSON.stringify(ticketShape(after))) continue;
    const next = increment(await content.maxRevision(projectId, 'ticket', id));
    changedTickets.set(id, next);
    changes.push({
      resourceType: 'ticket',
      resourceId: id,
      action: !before ? 'create' : !after ? 'delete' : 'update',
      beforeRevision: before?.revision ?? '0',
      afterRevision: next,
    });
  }
  changes.sort((a, b) =>
    `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`),
  );

  const threads = await Promise.all(
    target.threads.map(async thread => ({
      ...thread,
      revision:
        changedThreads.get(thread.id) ?? currentThreads.get(thread.id)?.revision ?? thread.revision,
      headSequence: await content.maxSequence(projectId, thread.id),
    })),
  );
  const tickets = target.tickets.map(ticket =>
    changedTickets.has(ticket.id)
      ? {
          ...ticket,
          revision: changedTickets.get(ticket.id)!,
          lastEditor: actor.identityId,
          lastEditorName: actor.name,
          updatedAt: at,
        }
      : { ...ticket, revision: currentTickets.get(ticket.id)?.revision ?? ticket.revision },
  );
  validateTicketGraph(tickets);
  const snapshot = { ...target, threads, tickets };
  const summary = summarize(changes, current, target);
  const digest = createHmac('sha256', secret)
    .update(JSON.stringify({ current: current.commit, target: target.commit, changes, summary }))
    .digest('base64url');
  return { snapshot, changes, digest, summary };
}
