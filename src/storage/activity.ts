import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ControlState, TurnRequest } from '../domain.js';
import type {
  ActivityDraft,
  ActivityEvent,
  ActivityPage,
  ActivityQuery,
} from '../observation-types.js';

export const activityRetentionMs = 7 * 86_400_000;
export const activityLimit = 100_000;

/** Only small coordination facts are copied, never content, credentials or history. */
export function observationBefore(state: ControlState) {
  return {
    onlineIdentities: new Map(
      Object.values(state.identities).map(identity => [
        identity.id,
        Object.values(state.instances).some(
          instance => instance.identityId === identity.id && instance.active,
        ),
      ]),
    ),
    identities: new Map(Object.values(state.identities).map(i => [i.id, i.name])),
    projects: new Map(Object.values(state.projects).map(p => [p.id, p.recovering])),
    requests: new Map(Object.values(state.requests).map(r => [r.id, r.state])),
  };
}

export function coordinationEvents(
  before: ReturnType<typeof observationBefore>,
  state: ControlState,
): ActivityDraft[] {
  const events = [...(state.observationEvents ?? [])];
  for (const identity of Object.values(state.identities)) {
    const previous = before.onlineIdentities.get(identity.id) ?? false;
    const activeInstances = Object.values(state.instances)
      .filter(instance => instance.identityId === identity.id && instance.active)
      .sort((left, right) => right.lastSeen - left.lastSeen);
    const online = activeInstances.length > 0;
    const renamed =
      before.identities.has(identity.id) && before.identities.get(identity.id) !== identity.name;
    if (previous === online && !renamed) continue;
    if (!before.identities.has(identity.id) && !online) continue;
    const instance =
      activeInstances[0] ??
      Object.values(state.instances)
        .filter(candidate => candidate.identityId === identity.id)
        .sort((left, right) => right.lastSeen - left.lastSeen)[0];
    events.push({
      id: randomUUID(),
      projectId: identity.projectId,
      kind: renamed ? 'agent.renamed' : online ? 'agent.connected' : 'agent.disconnected',
      at: Date.now(),
      actor: identity.name,
      identityId: identity.id,
      resourceType: 'agent',
      resourceId: identity.id,
      details: { workspace: instance?.workspace ?? '', host: instance?.host ?? null },
    });
  }
  for (const project of Object.values(state.projects)) {
    if (before.projects.get(project.id) === project.recovering) continue;
    events.push({
      id: randomUUID(),
      projectId: project.id,
      kind: before.projects.has(project.id)
        ? project.recovering
          ? 'project.recovering'
          : 'project.ready'
        : 'project.registered',
      at: Date.now(),
      resourceType: 'project',
      resourceId: project.id,
      details: {},
    });
  }
  const record = (request: TurnRequest, phase: string) =>
    events.push({
      id: randomUUID(),
      projectId: request.projectId,
      kind: `${request.resourceType === 'files' ? 'files' : 'turn'}.${phase.toLowerCase()}`,
      at: request.updatedAt,
      actor: state.identities[request.identityId]?.name,
      identityId: request.identityId,
      resourceType: request.resourceType,
      resourceId: request.resourceType === 'files' ? request.id : request.resourceId,
      details: {
        requestId: request.id,
        ...(request.resourceType === 'files' ? { paths: request.paths } : {}),
        ...(request.terminalReason ? { reason: request.terminalReason } : {}),
      },
    } satisfies ActivityDraft);
  for (const request of Object.values(state.requests)) {
    const previous = before.requests.get(request.id);
    if (previous === request.state) continue;
    if (!previous && request.state !== 'QUEUED') record(request, 'QUEUED');
    if (request.state === 'CLAIMED' && request.claimedAt === undefined)
      request.claimedAt = request.updatedAt;
    record(request, request.state);
  }
  return events;
}

/** Separate indexed tables: retained events never participate in ControlState rewrites. */
export class ActivityJournal {
  private lastPrune = 0;
  constructor(private readonly db: DatabaseSync) {}
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activityEvents (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        projectId TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        actor TEXT, resourceId TEXT NOT NULL, eventJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_project_sequence ON activityEvents(projectId,seq);
      CREATE INDEX IF NOT EXISTS activity_project_time ON activityEvents(projectId,at);
      CREATE TABLE IF NOT EXISTS activityProjects (projectId TEXT PRIMARY KEY, since INTEGER NOT NULL, prunedThrough INTEGER NOT NULL DEFAULT 0);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO controlMeta(key,value) VALUES('activitySince',?)")
      .run(String(Date.now()));
  }
  append(events: ActivityDraft[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO activityEvents(id,projectId,at,kind,actor,resourceId,eventJson) VALUES(?,?,?,?,?,?,?)',
    );
    for (const event of events) {
      this.db
        .prepare('INSERT OR IGNORE INTO activityProjects(projectId,since) VALUES(?,?)')
        .run(event.projectId, event.at);
      insert.run(
        event.id,
        event.projectId,
        event.at,
        event.kind,
        event.actor ?? null,
        event.resourceId,
        JSON.stringify(event),
      );
    }
    for (const projectId of new Set(events.map(e => e.projectId))) {
      const boundary = this.db
        .prepare(
          'SELECT seq FROM activityEvents WHERE projectId=? ORDER BY seq DESC LIMIT 1 OFFSET ?',
        )
        .get(projectId, activityLimit - 1)?.seq;
      if (boundary !== undefined) {
        const lastRemoved = this.db
          .prepare('SELECT MAX(seq) AS seq FROM activityEvents WHERE projectId=? AND seq<?')
          .get(projectId, boundary)?.seq;
        if (lastRemoved !== null && lastRemoved !== undefined) {
          this.db
            .prepare('DELETE FROM activityEvents WHERE projectId=? AND seq<?')
            .run(projectId, boundary);
          this.db
            .prepare(
              'UPDATE activityProjects SET prunedThrough=MAX(prunedThrough,?) WHERE projectId=?',
            )
            .run(lastRemoved, projectId);
        }
      }
    }
    if (Date.now() - this.lastPrune >= 60_000) {
      this.lastPrune = Date.now();
      for (const { projectId } of this.db
        .prepare('SELECT projectId FROM activityProjects')
        .all() as { projectId: string }[]) {
        const boundary = this.db
          .prepare(
            'SELECT seq FROM activityEvents WHERE projectId=? ORDER BY seq DESC LIMIT 1 OFFSET ?',
          )
          .get(projectId, activityLimit - 1)?.seq;
        const doomed = this.db
          .prepare(
            'SELECT seq FROM activityEvents WHERE projectId=? AND (at<? OR seq<?) ORDER BY seq LIMIT 1000',
          )
          .all(projectId, Date.now() - activityRetentionMs, boundary ?? 0) as { seq: number }[];
        if (doomed.length) {
          const through = Math.max(...doomed.map(r => r.seq));
          for (const row of doomed)
            this.db.prepare('DELETE FROM activityEvents WHERE seq=?').run(row.seq);
          this.db
            .prepare(
              'UPDATE activityProjects SET prunedThrough=MAX(prunedThrough,?) WHERE projectId=?',
            )
            .run(through, projectId);
        }
      }
    }
  }
  head(): string {
    return String(
      this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='activityEvents'").get()?.seq ??
        0,
    );
  }
  event(projectId: string, id: string, pathOffset = 0): ActivityEvent | undefined {
    const row = this.db
      .prepare('SELECT seq,eventJson FROM activityEvents WHERE projectId=? AND id=? AND at>=?')
      .get(projectId, id, Date.now() - activityRetentionMs) as
      { seq: number; eventJson: string } | undefined;
    if (!row) return undefined;
    return this.summary({ ...JSON.parse(row.eventJson), cursor: String(row.seq) }, pathOffset);
  }
  private summary(event: ActivityEvent, pathOffset = 0): ActivityEvent {
    const paths = event.details.paths;
    if (!Array.isArray(paths)) return event;
    return {
      ...event,
      details: {
        ...event.details,
        paths: paths.slice(pathOffset, pathOffset + 8),
        pathCount: paths.length,
        nextPathOffset: pathOffset + 8 < paths.length ? pathOffset + 8 : null,
      },
    };
  }
  gap(projectId: string, cursor: string): boolean {
    return (
      BigInt(cursor) <
      BigInt(
        String(
          this.db
            .prepare('SELECT prunedThrough FROM activityProjects WHERE projectId=?')
            .get(projectId)?.prunedThrough ?? 0,
        ),
      )
    );
  }
  page(query: ActivityQuery): ActivityPage {
    const where = ['projectId=?', 'at>=?'];
    const params: (string | number)[] = [query.projectId, Date.now() - activityRetentionMs];
    if (query.before) {
      where.push('seq<?');
      params.push(query.before);
    }
    if (query.actor) {
      where.push('actor=? COLLATE NOCASE');
      params.push(query.actor);
    }
    if (query.resourceId) {
      where.push('resourceId=?');
      params.push(query.resourceId);
    }
    if (query.kind) {
      where.push('kind LIKE ?');
      params.push(`${query.kind}%`);
    }
    const limit = Math.min(100, query.limit ?? 50);
    const rows = this.db
      .prepare(
        `SELECT seq,eventJson FROM activityEvents WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as { seq: number; eventJson: string }[];
    const events: ActivityEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const event = this.summary({ ...JSON.parse(row.eventJson), cursor: String(row.seq) });
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 200_000) break;
      events.push(event);
      bytes += size;
    }
    const bucketStart = Math.floor(Date.now() / 60_000) * 60_000 - 29 * 60_000;
    const buckets = Array<number>(30).fill(0);
    const counts = this.db
      .prepare(
        'SELECT CAST((at-?)/60000 AS INTEGER) AS bucket, COUNT(*) AS count FROM activityEvents WHERE projectId=? AND at>=? AND at<? GROUP BY bucket',
      )
      .all(bucketStart, query.projectId, bucketStart, bucketStart + 30 * 60_000) as {
      bucket: number;
      count: number;
    }[];
    for (const row of counts)
      if (row.bucket >= 0 && row.bucket < 30) buckets[row.bucket] = row.count;
    return {
      events,
      nextBefore: rows.length > events.length ? events.at(-1)!.cursor : null,
      recordingSince: Number(
        this.db.prepare("SELECT value FROM controlMeta WHERE key='activitySince'").get()?.value,
      ),
      retainedSince:
        Number(
          this.db
            .prepare('SELECT MIN(at) AS at FROM activityEvents WHERE projectId=? AND at>=?')
            .get(query.projectId, Date.now() - activityRetentionMs)?.at,
        ) || null,
      buckets,
      bucketStart,
    };
  }
}
