import { z } from 'zod';
import { activeStates, BassfishError, reservedStates } from './domain.js';
import type { ControlState, FileTurnRequest, TurnRequest } from './domain.js';
import { fileSetsOverlap } from './files.js';
import { SqliteControl } from './storage/control.js';
import type { DoltContent } from './storage/dolt.js';
import type { ObservationFilter } from './storage/observation-content.js';
import type {
  ObservationSnapshot,
  ObservedAgent,
  ObservedTicketDetail,
  ObservedTurn,
} from './observation-types.js';

const cursor = z.string().regex(/^\d{1,30}$/);
const commit = z.string().min(8).max(128);
const filterSchema = z
  .object({
    threadOffset: z.number().int().min(0).max(1_000_000).optional(),
    ticketOffset: z.number().int().min(0).max(1_000_000).optional(),
    agentOffset: z.number().int().min(0).max(1_000_000).optional(),
    turnOffset: z.number().int().min(0).max(1_000_000).optional(),
    query: z.string().max(200).optional(),
    threadState: z.enum(['active', 'archived', 'deleted', 'all']).optional(),
    ticketState: z.enum(['todo', 'in_progress', 'blocked', 'done', 'all']).optional(),
    owner: z.string().max(64).optional(),
  })
  .strict();
export const observerOpenSchema = z
  .object({ workspace: z.string().min(1).max(4096), protocolVersion: z.literal(1) })
  .strict();
export const observationReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), filter: filterSchema.optional() }).strict(),
  z.object({ kind: z.literal('content'), commit, filter: filterSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal('thread'),
      id: z.string().min(1).max(200),
      commit,
      before: cursor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ticket'),
      id: z.string().min(1).max(200),
      commit,
      cursor: z.string().max(4096).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('graph'),
      id: z.string().min(1).max(200),
      commit,
      focused: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('activity'),
      before: cursor.optional(),
      actor: z.string().max(64).optional(),
      resourceId: z.string().max(200).optional(),
      eventKind: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('files'),
      id: z.string().min(1).max(200),
      pathOffset: z.number().int().min(0).max(1_000_000).optional(),
      blockerOffset: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      id: z.string().min(1).max(200),
      pathOffset: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
]);
export type ObservationRead = z.infer<typeof observationReadSchema>;
export const observationWaitSchema = z
  .object({ cursor, timeoutMs: z.number().int().min(0).max(20_000).default(20_000) })
  .strict();
export type ObservationReader = Pick<
  DoltContent,
  'head' | 'observeContent' | 'observeGraph' | 'snapshot' | 'ticketSnapshot'
>;

function observeTurn(
  state: ControlState,
  request: TurnRequest,
  pathOffset = 0,
  blockerOffset = 0,
): ObservedTurn {
  const blockers =
    request.resourceType === 'files' && request.state === 'QUEUED'
      ? Object.values(state.requests).filter(
          (other): other is FileTurnRequest =>
            other.resourceType === 'files' &&
            other.id !== request.id &&
            activeStates.includes(other.state) &&
            fileSetsOverlap(other.paths, request.paths) &&
            (reservedStates.includes(other.state) ||
              (other.state === 'QUEUED' && BigInt(other.sequence) < BigInt(request.sequence))),
        )
      : [];
  return {
    id: request.id,
    projectId: request.projectId,
    resourceType: request.resourceType,
    ...(request.resourceType === 'files'
      ? {
          paths: request.paths.slice(pathOffset, pathOffset + 8),
          pathCount: request.paths.length,
          nextPathOffset: pathOffset + 8 < request.paths.length ? pathOffset + 8 : null,
        }
      : { resourceId: request.resourceId, expiresAt: request.expiresAt }),
    state: request.state,
    owner: state.identities[request.identityId]?.name ?? 'Unknown',
    identityId: request.identityId,
    workspace: state.instances[request.instanceId]?.workspace ?? '',
    createdAt: request.createdAt,
    claimedAt: request.claimedAt,
    blockerCount: blockers.length,
    nextBlockerOffset: blockerOffset + 8 < blockers.length ? blockerOffset + 8 : null,
    blockers: blockers.slice(blockerOffset, blockerOffset + 8).map(other => {
      const overlaps = other.paths.filter(
        path => request.resourceType === 'files' && fileSetsOverlap([path], request.paths),
      );
      return {
        id: other.id,
        owner: state.identities[other.identityId]?.name ?? 'Unknown',
        project: state.projects[other.projectId]?.commonDir ?? '',
        paths: overlaps.slice(0, 1),
        overlapCount: overlaps.length,
        reason: other.state === 'QUEUED' ? ('earlier_request' as const) : ('held' as const),
      };
    }),
  };
}
function boundedPage<T>(
  items: T[],
  offset: number,
  map: (item: T) => unknown,
  budget: number,
): { rows: unknown[]; next: number | null } {
  const rows: unknown[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + 100)) {
    const row = map(item),
      size = Buffer.byteLength(JSON.stringify(row));
    if (rows.length && bytes + size > budget) break;
    rows.push(row);
    bytes += size;
  }
  return { rows, next: offset + rows.length < items.length ? offset + rows.length : null };
}

export class ProjectObserver {
  constructor(
    private readonly control: SqliteControl,
    private readonly content: ObservationReader,
    readonly epoch: string,
  ) {}
  private project(commonDir: string) {
    return this.control.view(s => Object.values(s.projects).find(p => p.commonDir === commonDir));
  }
  async snapshot(commonDir: string, filter: ObservationFilter = {}): Promise<ObservationSnapshot> {
    // Cursor precedes capture: any changes during SQL reads are replayed on the next wait.
    const cursor = this.control.activity.head();
    const state = this.control.view(s => s);
    const project = Object.values(state.projects).find(p => p.commonDir === commonDir) ?? null;
    const at = Date.now();
    if (!project)
      return {
        protocolVersion: 1,
        epoch: this.epoch,
        cursor,
        at,
        project,
        status: 'empty',
        agents: [],
        turns: [],
        content: null,
        activity: null,
      };
    const agents: ObservedAgent[] = Object.values(state.identities)
      .filter(i => i.projectId === project.id)
      .map(identity => {
        const instances = Object.values(state.instances)
          .filter(i => i.identityId === identity.id)
          .sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeen - a.lastSeen);
        const latest = instances[0];
        return {
          id: identity.id,
          name: identity.name,
          online: Boolean(latest?.active),
          lastSeen: latest?.lastSeen ?? null,
          host: latest?.host ?? null,
          workspace: latest?.workspace ?? null,
        };
      });
    agents.sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
    const requests = Object.values(state.requests)
      .filter(r => r.projectId === project.id && activeStates.includes(r.state))
      .sort((a, b) => a.id.localeCompare(b.id));
    const agentPage = boundedPage(agents, filter.agentOffset ?? 0, a => a, 100_000);
    const turnPage = boundedPage(
      requests,
      filter.turnOffset ?? 0,
      r => observeTurn(state, r),
      350_000,
    );
    const result: ObservationSnapshot = {
      protocolVersion: 1,
      epoch: this.epoch,
      cursor,
      at,
      project,
      status: project.recovering ? 'recovering' : 'ready',
      agents: agentPage.rows as ObservedAgent[],
      turns: turnPage.rows as ObservedTurn[],
      coordinationTotals: {
        agents: agents.length,
        online: agents.filter(a => a.online).length,
        turns: requests.length,
        files: requests.filter(r => r.resourceType === 'files').length,
      },
      nextAgentOffset: agentPage.next,
      nextTurnOffset: turnPage.next,
      content: null,
      activity: this.control.activity.page({ projectId: project.id }),
    };
    try {
      const commit = await this.content.head(project.id);
      result.content = await this.content.observeContent(project.id, commit, {
        threadState: 'active',
        ...filter,
      });
    } catch (error) {
      result.status = project.recovering ? 'recovering' : 'content_unavailable';
      result.contentError =
        error instanceof BassfishError ? error.code : 'Content storage unavailable';
    }
    return result;
  }
  async read(commonDir: string, request: ObservationRead): Promise<unknown> {
    if (request.kind === 'snapshot') return this.snapshot(commonDir, request.filter);
    const project = this.project(commonDir);
    if (!project)
      throw new BassfishError(
        'NOT_FOUND',
        'No Bassfish activity has been recorded in this project.',
      );
    switch (request.kind) {
      case 'files':
        return this.control.view(state => {
          const turn = state.requests[request.id];
          if (!turn || turn.projectId !== project.id || turn.resourceType !== 'files')
            throw new BassfishError(
              'NOT_FOUND',
              'Reservation no longer available. Open its retained activity event.',
            );
          return observeTurn(state, turn, request.pathOffset, request.blockerOffset);
        });
      case 'event': {
        const event = this.control.activity.event(project.id, request.id, request.pathOffset);
        if (!event)
          throw new BassfishError('NOT_FOUND', 'Activity event is outside the retained history.');
        return event;
      }
      case 'content':
        return this.content.observeContent(project.id, request.commit, request.filter ?? {});
      case 'thread': {
        const snapshot = await this.content.snapshot(
          project.id,
          request.id,
          50,
          request.before,
          request.commit,
        );
        let bytes = 0,
          start = snapshot.messages.length;
        for (let i = snapshot.messages.length - 1; i >= 0; i--) {
          const size = Buffer.byteLength(JSON.stringify(snapshot.messages[i]));
          if (start < snapshot.messages.length && bytes + size > 500_000) break;
          bytes += size;
          start = i;
        }
        if (start > 0) {
          snapshot.messages = snapshot.messages.slice(start);
          snapshot.truncated = true;
          snapshot.nextBefore = snapshot.messages[0]!.sequence;
        }
        return snapshot;
      }
      case 'ticket': {
        const snapshot = await this.content.ticketSnapshot(
          project.id,
          request.id,
          request.cursor,
          request.commit,
        );
        const { body: _body, ...ticket } = snapshot.ticket;
        return { ...snapshot, ticket } satisfies ObservedTicketDetail;
      }
      case 'graph': {
        const graph = await this.content.observeGraph(
          project.id,
          request.commit,
          request.id,
          request.focused,
        );
        if (!request.focused && graph.tickets.length >= 200 && graph.hidden)
          return this.content.observeGraph(project.id, request.commit, request.id, true);
        return graph;
      }
      case 'activity':
        return this.control.activity.page({
          projectId: project.id,
          before: request.before,
          actor: request.actor,
          resourceId: request.resourceId,
          kind: request.eventKind,
        });
    }
  }
  async wait(commonDir: string, after: string, timeoutMs: number, signal?: AbortSignal) {
    if (this.control.activity.head() === after && timeoutMs > 0)
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener('abort', abort);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new BassfishError('CANCELLED', 'Observation cancelled.'));
        };
        const unsubscribe = this.control.subscribe(done);
        timer = setTimeout(done, timeoutMs);
        if (signal?.aborted) abort();
        else {
          signal?.addEventListener('abort', abort, { once: true });
          if (this.control.activity.head() !== after) done();
        }
      });
    const project = this.project(commonDir);
    return {
      cursor: this.control.activity.head(),
      epoch: this.epoch,
      at: Date.now(),
      gap: project ? this.control.activity.gap(project.id, after) : false,
    };
  }
}
