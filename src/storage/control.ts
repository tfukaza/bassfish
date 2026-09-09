import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BassfishError, reservedStates, requireThat } from '../domain.js';
import { fileSetsOverlap } from '../files.js';
import { ActivityJournal, coordinationEvents, observationBefore } from './activity.js';
import type {
  Actor,
  ControlState,
  ControlStore,
  DurableTask,
  TurnRequest,
  Identity,
  Instance,
  PendingCommit,
  Project,
  Resource,
  ThreadFollow,
  Notification,
  HostSessionBinding,
} from '../domain.js';

const schemaVersion = 13;

/** Durable current coordination state. Content and semantic history never live here. */
export class SqliteControl implements ControlStore {
  private readonly db: DatabaseSync;
  readonly activity: ActivityJournal;
  private readonly observers = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.activity = new ActivityJournal(this.db);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (![0, 10, 11, 12, schemaVersion].includes(version)) {
      this.db.close();
      throw new BassfishError(
        'SCHEMA_MISMATCH',
        `Control schema ${version} is incompatible with v0 schema ${schemaVersion}; reset the preview data.`,
      );
    }
    const hasColumn = (table: string, column: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        value => value.name === column,
      );
    try {
      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, commonDir TEXT NOT NULL UNIQUE, recovering INTEGER NOT NULL CHECK(recovering IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id), UNIQUE(projectId,name COLLATE NOCASE)
      );
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
        epoch TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), lastSeen INTEGER NOT NULL, workspace TEXT NOT NULL,
        host TEXT CHECK(host IS NULL OR host IN ('claude','codex','opencode')), hostSessionId TEXT,
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('thread','ticket','project')),
        fence TEXT NOT NULL, queueSequence TEXT NOT NULL, present INTEGER NOT NULL CHECK(present IN (0,1)), FOREIGN KEY(projectId) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS turnRequests (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, resourceId TEXT,
        resourceType TEXT NOT NULL CHECK(resourceType IN ('thread','ticket','project','files')),
        pathsJson TEXT CHECK(pathsJson IS NULL OR json_valid(pathsJson)),
        identityId TEXT NOT NULL, instanceId TEXT NOT NULL, sequence TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','READY','OFFERED','CLAIMED','COMMITTING','COMMITTED','RELEASED','EXPIRED','CANCELLED','FAILED')),
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, queueUntil INTEGER NOT NULL, reconnectUntil INTEGER,
        offerId TEXT UNIQUE, claimBy INTEGER, turnId TEXT UNIQUE, fence TEXT, baseRevision TEXT,
        snapshotCommit TEXT, expiresAt INTEGER, finishedAt INTEGER, resultJson TEXT CHECK(resultJson IS NULL OR json_valid(resultJson)),
        purpose TEXT CHECK(purpose IS NULL OR purpose IN ('snapshot','export','restore')),
        deliveryMode TEXT NOT NULL CHECK(deliveryMode IN ('ticket','task')), claimedAt INTEGER, terminalReason TEXT,
        CHECK((resourceType='files' AND resourceId IS NULL AND pathsJson IS NOT NULL AND fence IS NULL AND baseRevision IS NULL AND snapshotCommit IS NULL AND expiresAt IS NULL AND purpose IS NULL AND resultJson IS NULL AND state NOT IN ('COMMITTING','COMMITTED')) OR (resourceType!='files' AND resourceId IS NOT NULL AND pathsJson IS NULL)),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(resourceId) REFERENCES resources(id),
        FOREIGN KEY(identityId) REFERENCES identities(id), FOREIGN KEY(instanceId) REFERENCES instances(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reserved_resource ON turnRequests(projectId,resourceId)
        WHERE state IN ('READY','OFFERED','CLAIMED','COMMITTING');
      CREATE UNIQUE INDEX IF NOT EXISTS one_content_request_per_instance ON turnRequests(instanceId)
        WHERE resourceType!='files' AND state IN ('QUEUED','READY','OFFERED','CLAIMED','COMMITTING');
      CREATE UNIQUE INDEX IF NOT EXISTS one_file_request_per_instance ON turnRequests(instanceId)
        WHERE resourceType='files' AND state IN ('QUEUED','READY','OFFERED','CLAIMED');
      CREATE TABLE IF NOT EXISTS pendingCommits (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, resourceId TEXT NOT NULL,
        resourceType TEXT NOT NULL CHECK(resourceType IN ('thread','ticket','project')), turnRequestId TEXT,
        startingHead TEXT NOT NULL, kind TEXT NOT NULL, actorJson TEXT NOT NULL CHECK(json_valid(actorJson)),
        followIdentityId TEXT, notificationRecipientsJson TEXT CHECK(notificationRecipientsJson IS NULL OR json_valid(notificationRecipientsJson)),
        notificationIntentsJson TEXT CHECK(notificationIntentsJson IS NULL OR json_valid(notificationIntentsJson)),
        notificationCreatedAt INTEGER, observationJson TEXT CHECK(observationJson IS NULL OR json_valid(observationJson)),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(turnRequestId) REFERENCES turnRequests(id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL, requestId TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('working','completed','failed','cancelled')),
        statusMessage TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, discardAt INTEGER NOT NULL,
        resultJson TEXT CHECK(resultJson IS NULL OR json_valid(resultJson)),
        errorJson TEXT CHECK(errorJson IS NULL OR json_valid(errorJson)),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id), FOREIGN KEY(requestId) REFERENCES turnRequests(id)
      );
      CREATE TABLE IF NOT EXISTS threadFollows (
        projectId TEXT NOT NULL, threadId TEXT NOT NULL, identityId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(projectId,threadId,identityId), FOREIGN KEY(projectId) REFERENCES projects(id),
        FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL,
        resourceType TEXT NOT NULL CHECK(resourceType IN ('thread','ticket')), resourceId TEXT NOT NULL, eventId TEXT NOT NULL,
        threadId TEXT, ticketId TEXT, messageId TEXT, sequence TEXT, senderIdentityId TEXT NOT NULL, senderName TEXT NOT NULL,
        createdAt INTEGER NOT NULL, reasonsJson TEXT NOT NULL CHECK(json_valid(reasonsJson)), lastDeliveredWakeKey TEXT,
        UNIQUE(identityId,eventId,resourceType,resourceId), FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      CREATE TABLE IF NOT EXISTS hostSessionBindings (
        projectId TEXT NOT NULL, identityId TEXT NOT NULL, host TEXT NOT NULL CHECK(host IN ('claude','codex','opencode')),
        sessionId TEXT NOT NULL, wakeKey TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(projectId,host,sessionId), UNIQUE(projectId,identityId),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      CREATE TABLE IF NOT EXISTS controlMeta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO controlMeta(key,value) VALUES('wallClockHighWaterMs','0'),('fileQueueSequence','0');
      PRAGMA user_version=${schemaVersion};
    `);
      if (version === 10) {
        if (!hasColumn('turnRequests', 'claimedAt'))
          this.db.exec('ALTER TABLE turnRequests ADD COLUMN claimedAt INTEGER;');
        if (!hasColumn('turnRequests', 'terminalReason'))
          this.db.exec('ALTER TABLE turnRequests ADD COLUMN terminalReason TEXT;');
        if (!hasColumn('pendingCommits', 'observationJson'))
          this.db.exec('ALTER TABLE pendingCommits ADD COLUMN observationJson TEXT;');
      }
      if (version !== 0 && version < schemaVersion) {
        const hostSession = hasColumn('instances', 'hostSessionId') ? 'hostSessionId' : 'NULL';
        this.db.exec(`
      CREATE TABLE instancesV13 (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
        epoch TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), lastSeen INTEGER NOT NULL, workspace TEXT NOT NULL,
        host TEXT CHECK(host IS NULL OR host IN ('claude','codex','opencode')), hostSessionId TEXT,
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      INSERT INTO instancesV13(id,projectId,identityId,handle,epoch,active,lastSeen,workspace,host,hostSessionId)
        SELECT id,projectId,identityId,handle,epoch,active,lastSeen,workspace,host,${hostSession} FROM instances;
      DROP TABLE instances;
      ALTER TABLE instancesV13 RENAME TO instances;
    `);
        if (!hasColumn('notifications', 'lastDeliveredWakeKey')) {
          if (hasColumn('notifications', 'lastPushedWakeKey'))
            this.db.exec(
              'ALTER TABLE notifications RENAME COLUMN lastPushedWakeKey TO lastDeliveredWakeKey;',
            );
          else if (hasColumn('notifications', 'lastPushedRunId'))
            this.db.exec(
              'ALTER TABLE notifications RENAME COLUMN lastPushedRunId TO lastDeliveredWakeKey;',
            );
          else this.db.exec('ALTER TABLE notifications ADD COLUMN lastDeliveredWakeKey TEXT;');
        }
        this.db.exec(`
          UPDATE notifications
          SET reasonsJson=REPLACE(reasonsJson,'"urgent_mention"','"direct_mention"'),
              lastDeliveredWakeKey=NULL;
          DROP TABLE IF EXISTS wakeDispatches;
        `);
        this.db.exec('DROP TABLE IF EXISTS nativeHostPreferences;');
      }
      this.activity.initialize();
      this.db.exec('COMMIT');
      this.db.exec('PRAGMA foreign_keys=ON;');
      const foreignKeyFailure = this.db.prepare('PRAGMA foreign_key_check').get();
      requireThat(!foreignKeyFailure, 'SCHEMA_MISMATCH', 'Control schema migration failed.');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } finally {
        this.db.close();
      }
      throw error;
    }
  }

  private load(): ControlState {
    const watermark = this.db
      .prepare("SELECT value FROM controlMeta WHERE key='wallClockHighWaterMs'")
      .get() as { value: string } | undefined;
    const state: ControlState = {
      projects: {},
      identities: {},
      instances: {},
      resources: {},
      requests: {},
      pending: {},
      tasks: {},
      follows: {},
      notifications: {},
      hostSessionBindings: {},
      fileQueueSequence: String(
        this.db.prepare("SELECT value FROM controlMeta WHERE key='fileQueueSequence'").get()
          ?.value ?? '0',
      ),
      wallClockHighWaterMs: Number(watermark?.value ?? 0),
    };
    for (const row of this.db.prepare('SELECT * FROM projects').all() as unknown as (Omit<
      Project,
      'recovering'
    > & { recovering: number })[]) {
      state.projects[row.id] = { ...row, recovering: row.recovering === 1 };
    }
    for (const row of this.db.prepare('SELECT * FROM identities').all() as unknown as Identity[])
      state.identities[row.id] = row;
    for (const row of this.db.prepare('SELECT * FROM instances').all() as unknown as (Omit<
      Instance,
      'active'
    > & { active: number })[]) {
      state.instances[row.id] = { ...row, active: row.active === 1 };
    }
    for (const row of this.db.prepare('SELECT * FROM resources').all() as unknown as (Omit<
      Resource,
      'present'
    > & { present: number })[])
      state.resources[row.id] = { ...row, present: row.present === 1 };
    for (const row of this.db.prepare('SELECT * FROM turnRequests').all() as Record<
      string,
      unknown
    >[]) {
      const request = { ...row };
      if (request.resultJson) request.result = JSON.parse(String(request.resultJson));
      if (request.pathsJson) request.paths = JSON.parse(String(request.pathsJson));
      delete request.resultJson;
      delete request.pathsJson;
      for (const key of Object.keys(request)) if (request[key] === null) delete request[key];
      state.requests[String(request.id)] = request as unknown as TurnRequest;
    }
    for (const row of this.db.prepare('SELECT * FROM pendingCommits').all() as Record<
      string,
      unknown
    >[]) {
      const pending = {
        ...row,
        actor: JSON.parse(String(row.actorJson)) as Actor,
      } as unknown as PendingCommit & {
        actorJson?: string;
        notificationRecipientsJson?: string | null;
        notificationIntentsJson?: string | null;
        observationJson?: string | null;
      };
      if (pending.notificationRecipientsJson)
        pending.notificationRecipients = JSON.parse(pending.notificationRecipientsJson);
      if (pending.notificationIntentsJson)
        pending.notificationIntents = JSON.parse(pending.notificationIntentsJson);
      delete pending.actorJson;
      delete pending.notificationRecipientsJson;
      delete pending.notificationIntentsJson;
      if (pending.observationJson) pending.observation = JSON.parse(pending.observationJson);
      delete pending.observationJson;
      if (pending.turnRequestId === null) delete pending.turnRequestId;
      if (pending.followIdentityId === null) delete pending.followIdentityId;
      if (pending.notificationCreatedAt === null) delete pending.notificationCreatedAt;
      state.pending[pending.id] = pending;
    }
    for (const row of this.db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[]) {
      const task = { ...row } as unknown as DurableTask & {
        resultJson?: string | null;
        errorJson?: string | null;
      };
      if (task.resultJson) task.result = JSON.parse(task.resultJson);
      if (task.errorJson) task.error = JSON.parse(task.errorJson);
      delete task.resultJson;
      delete task.errorJson;
      for (const key of Object.keys(task) as (keyof DurableTask)[])
        if (task[key] === null) delete task[key];
      state.tasks[task.id] = task;
    }
    for (const row of this.db
      .prepare('SELECT * FROM threadFollows')
      .all() as unknown as ThreadFollow[])
      state.follows[`${row.projectId}:${row.threadId}:${row.identityId}`] = row;
    for (const row of this.db.prepare('SELECT * FROM notifications').all() as Record<
      string,
      unknown
    >[]) {
      const notification = {
        ...row,
        reasons: JSON.parse(String(row.reasonsJson)),
      } as unknown as Notification & { reasonsJson?: string };
      delete notification.reasonsJson;
      if (notification.lastDeliveredWakeKey === null) delete notification.lastDeliveredWakeKey;
      state.notifications[notification.id] = notification;
    }
    for (const row of this.db
      .prepare('SELECT * FROM hostSessionBindings')
      .all() as unknown as HostSessionBinding[])
      state.hostSessionBindings[`${row.projectId}:${row.host}:${row.sessionId}`] = row;
    return state;
  }

  view<T>(fn: (state: ControlState) => T): T {
    return fn(this.load());
  }

  update<T>(fn: (state: ControlState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.load();
      const before = observationBefore(state);
      const result = fn(state);
      const events = coordinationEvents(before, state);
      const files = Object.values(state.requests).filter(
        value => value.resourceType === 'files' && reservedStates.includes(value.state),
      );
      for (let i = 0; i < files.length; i++)
        for (let j = i + 1; j < files.length; j++) {
          const left = files[i]!,
            right = files[j]!;
          requireThat(
            left.resourceType === 'files' &&
              right.resourceType === 'files' &&
              !fileSetsOverlap(left.paths, right.paths),
            'FILE_LOCK_CONFLICT',
            'Overlapping file sets cannot have simultaneous ownership.',
          );
        }
      this.db.exec(
        'DELETE FROM hostSessionBindings; DELETE FROM notifications; DELETE FROM threadFollows; DELETE FROM tasks; DELETE FROM pendingCommits; DELETE FROM turnRequests; DELETE FROM resources; DELETE FROM instances; DELETE FROM identities; DELETE FROM projects;',
      );
      const project = this.db.prepare(
        'INSERT INTO projects(id,commonDir,recovering) VALUES(?,?,?)',
      );
      for (const value of Object.values(state.projects))
        project.run(value.id, value.commonDir, value.recovering ? 1 : 0);
      const identity = this.db.prepare('INSERT INTO identities(id,projectId,name) VALUES(?,?,?)');
      for (const value of Object.values(state.identities))
        identity.run(value.id, value.projectId, value.name);
      const instance = this.db.prepare(
        'INSERT INTO instances(id,projectId,identityId,handle,epoch,active,lastSeen,workspace,host,hostSessionId) VALUES(?,?,?,?,?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.instances))
        instance.run(
          value.id,
          value.projectId,
          value.identityId,
          value.handle,
          value.epoch,
          value.active ? 1 : 0,
          value.lastSeen,
          value.workspace,
          value.host ?? null,
          value.hostSessionId ?? null,
        );
      const resource = this.db.prepare(
        'INSERT INTO resources(id,projectId,type,fence,queueSequence,present) VALUES(?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.resources))
        resource.run(
          value.id,
          value.projectId,
          value.type,
          value.fence,
          value.queueSequence,
          value.present ? 1 : 0,
        );
      const request = this.db
        .prepare(`INSERT INTO turnRequests(id,projectId,resourceId,resourceType,identityId,instanceId,sequence,state,createdAt,updatedAt,queueUntil,
        reconnectUntil,offerId,claimBy,turnId,fence,baseRevision,snapshotCommit,expiresAt,finishedAt,resultJson,purpose,deliveryMode,pathsJson,claimedAt,terminalReason) VALUES(${Array(26).fill('?').join(',')})`);
      for (const value of Object.values(state.requests)) {
        const content = value.resourceType === 'files' ? undefined : value;
        request.run(
          value.id,
          value.projectId,
          content?.resourceId ?? null,
          value.resourceType,
          value.identityId,
          value.instanceId,
          value.sequence,
          value.state,
          value.createdAt,
          value.updatedAt,
          value.queueUntil,
          value.reconnectUntil ?? null,
          value.offerId ?? null,
          value.claimBy ?? null,
          value.turnId ?? null,
          content?.fence ?? null,
          content?.baseRevision ?? null,
          content?.snapshotCommit ?? null,
          content?.expiresAt ?? null,
          value.finishedAt ?? null,
          content?.result ? JSON.stringify(content.result) : null,
          content?.purpose ?? null,
          value.deliveryMode,
          value.resourceType === 'files' ? JSON.stringify(value.paths) : null,
          value.claimedAt ?? null,
          value.terminalReason ?? null,
        );
      }
      const pending = this.db.prepare(
        'INSERT INTO pendingCommits(id,projectId,resourceId,resourceType,turnRequestId,startingHead,kind,actorJson,followIdentityId,notificationRecipientsJson,notificationIntentsJson,notificationCreatedAt,observationJson) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.pending))
        pending.run(
          value.id,
          value.projectId,
          value.resourceId,
          value.resourceType,
          value.turnRequestId ?? null,
          value.startingHead,
          value.kind,
          JSON.stringify(value.actor),
          value.followIdentityId ?? null,
          value.notificationRecipients ? JSON.stringify(value.notificationRecipients) : null,
          value.notificationIntents ? JSON.stringify(value.notificationIntents) : null,
          value.notificationCreatedAt ?? null,
          value.observation ? JSON.stringify(value.observation) : null,
        );
      const task = this.db.prepare(
        'INSERT INTO tasks(id,projectId,identityId,requestId,status,statusMessage,createdAt,updatedAt,discardAt,resultJson,errorJson) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.tasks))
        task.run(
          value.id,
          value.projectId,
          value.identityId,
          value.requestId,
          value.status,
          value.statusMessage ?? null,
          value.createdAt,
          value.updatedAt,
          value.discardAt,
          value.result ? JSON.stringify(value.result) : null,
          value.error ? JSON.stringify(value.error) : null,
        );
      const follow = this.db.prepare(
        'INSERT INTO threadFollows(projectId,threadId,identityId,createdAt) VALUES(?,?,?,?)',
      );
      for (const value of Object.values(state.follows))
        follow.run(value.projectId, value.threadId, value.identityId, value.createdAt);
      const notification = this.db.prepare(
        'INSERT INTO notifications(id,projectId,identityId,resourceType,resourceId,eventId,threadId,ticketId,messageId,sequence,senderIdentityId,senderName,createdAt,reasonsJson,lastDeliveredWakeKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.notifications))
        notification.run(
          value.id,
          value.projectId,
          value.identityId,
          value.resourceType,
          value.resourceId,
          value.eventId,
          value.threadId ?? null,
          value.ticketId ?? null,
          value.messageId ?? null,
          value.sequence ?? null,
          value.senderIdentityId,
          value.senderName,
          value.createdAt,
          JSON.stringify(value.reasons),
          value.lastDeliveredWakeKey ?? null,
        );
      const hostSessionBinding = this.db.prepare(
        'INSERT INTO hostSessionBindings(projectId,identityId,host,sessionId,wakeKey,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
      );
      for (const value of Object.values(state.hostSessionBindings))
        hostSessionBinding.run(
          value.projectId,
          value.identityId,
          value.host,
          value.sessionId,
          value.wakeKey,
          value.createdAt,
          value.updatedAt,
        );
      this.db
        .prepare("UPDATE controlMeta SET value=? WHERE key='wallClockHighWaterMs'")
        .run(String(state.wallClockHighWaterMs));
      this.db
        .prepare("UPDATE controlMeta SET value=? WHERE key='fileQueueSequence'")
        .run(state.fileQueueSequence);
      this.activity.append(events);
      this.db.exec('COMMIT');
      if (events.length)
        for (const wake of this.observers) {
          try {
            wake();
          } catch {
            /* An observer cannot fail a committed write. */
          }
        }
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
