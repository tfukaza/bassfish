import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BassfishError } from '../domain.js';
import type { Actor, ControlState, ControlStore, DurableTask, FloorRequest, Identity, Instance, PendingCommit, Project, Resource } from '../domain.js';

const schemaVersion = 3;

/** Durable current coordination state. Content and semantic history never live here. */
export class SqliteControl implements ControlStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== schemaVersion) {
      this.db.close();
      throw new BassfishError('SCHEMA_MISMATCH', `Control schema ${version} is incompatible with v0 schema ${schemaVersion}; reset the preview data.`);
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, commonDir TEXT NOT NULL UNIQUE, recovering INTEGER NOT NULL CHECK(recovering IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id), UNIQUE(projectId,name COLLATE NOCASE)
      );
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
        epoch TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), lastSeen INTEGER NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_instance ON instances(identityId) WHERE active=1;
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('thread','note','project')),
        fence TEXT NOT NULL, queueSequence TEXT NOT NULL, present INTEGER NOT NULL CHECK(present IN (0,1)), FOREIGN KEY(projectId) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS floorRequests (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, resourceId TEXT NOT NULL,
        resourceType TEXT NOT NULL CHECK(resourceType IN ('thread','note','project')),
        identityId TEXT NOT NULL, instanceId TEXT NOT NULL, sequence TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','READY','OFFERED','HELD','COMMITTING','COMMITTED','RELEASED','EXPIRED','CANCELLED','FAILED')),
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, queueUntil INTEGER NOT NULL, reconnectUntil INTEGER,
        offerId TEXT UNIQUE, claimBy INTEGER, floorId TEXT UNIQUE, fence TEXT, baseRevision TEXT,
        snapshotCommit TEXT, expiresAt INTEGER, finishedAt INTEGER, resultJson TEXT CHECK(resultJson IS NULL OR json_valid(resultJson)),
        purpose TEXT CHECK(purpose IS NULL OR purpose IN ('snapshot','export','search','restore')),
        deliveryMode TEXT NOT NULL CHECK(deliveryMode IN ('ticket','task')),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(resourceId) REFERENCES resources(id),
        FOREIGN KEY(identityId) REFERENCES identities(id), FOREIGN KEY(instanceId) REFERENCES instances(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reserved_resource ON floorRequests(projectId,resourceId)
        WHERE state IN ('READY','OFFERED','HELD','COMMITTING');
      CREATE UNIQUE INDEX IF NOT EXISTS one_request_per_instance ON floorRequests(instanceId)
        WHERE state IN ('QUEUED','READY','OFFERED','HELD','COMMITTING');
      CREATE TABLE IF NOT EXISTS pendingCommits (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, resourceId TEXT NOT NULL,
        resourceType TEXT NOT NULL CHECK(resourceType IN ('thread','note','project')), floorRequestId TEXT,
        startingHead TEXT NOT NULL, kind TEXT NOT NULL, actorJson TEXT NOT NULL CHECK(json_valid(actorJson)),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(floorRequestId) REFERENCES floorRequests(id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, identityId TEXT NOT NULL, requestId TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('working','completed','failed','cancelled')),
        statusMessage TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, discardAt INTEGER NOT NULL,
        resultJson TEXT CHECK(resultJson IS NULL OR json_valid(resultJson)),
        errorJson TEXT CHECK(errorJson IS NULL OR json_valid(errorJson)),
        FOREIGN KEY(projectId) REFERENCES projects(id), FOREIGN KEY(identityId) REFERENCES identities(id), FOREIGN KEY(requestId) REFERENCES floorRequests(id)
      );
      CREATE TABLE IF NOT EXISTS controlMeta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO controlMeta(key,value) VALUES('wallClockHighWaterMs','0');
      PRAGMA user_version=${schemaVersion};
    `);
  }

  private load(): ControlState {
    const watermark = this.db.prepare("SELECT value FROM controlMeta WHERE key='wallClockHighWaterMs'").get() as { value: string } | undefined;
    const state: ControlState = { projects: {}, identities: {}, instances: {}, resources: {}, requests: {}, pending: {}, tasks: {}, wallClockHighWaterMs: Number(watermark?.value ?? 0) };
    for (const row of this.db.prepare('SELECT * FROM projects').all() as unknown as (Omit<Project,'recovering'> & { recovering: number })[]) {
      state.projects[row.id] = { ...row, recovering: row.recovering === 1 };
    }
    for (const row of this.db.prepare('SELECT * FROM identities').all() as unknown as Identity[]) state.identities[row.id] = row;
    for (const row of this.db.prepare('SELECT * FROM instances').all() as unknown as (Omit<Instance,'active'> & { active: number })[]) {
      state.instances[row.id] = { ...row, active: row.active === 1 };
    }
    for (const row of this.db.prepare('SELECT * FROM resources').all() as unknown as (Omit<Resource,'present'> & { present: number })[]) state.resources[row.id] = { ...row, present: row.present === 1 };
    for (const row of this.db.prepare('SELECT * FROM floorRequests').all() as Record<string, unknown>[]) {
      const request = { ...row } as unknown as FloorRequest & { resultJson?: string | null };
      if (request.resultJson) request.result = JSON.parse(request.resultJson);
      delete request.resultJson;
      for (const key of Object.keys(request) as (keyof FloorRequest)[]) if (request[key] === null) delete request[key];
      state.requests[request.id] = request;
    }
    for (const row of this.db.prepare('SELECT * FROM pendingCommits').all() as Record<string, unknown>[]) {
      const pending = { ...row, actor: JSON.parse(String(row.actorJson)) as Actor } as unknown as PendingCommit & { actorJson?: string };
      delete pending.actorJson;
      if (pending.floorRequestId === null) delete pending.floorRequestId;
      state.pending[pending.id] = pending;
    }
    for (const row of this.db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[]) {
      const task = { ...row } as unknown as DurableTask & { resultJson?: string | null; errorJson?: string | null };
      if (task.resultJson) task.result = JSON.parse(task.resultJson);
      if (task.errorJson) task.error = JSON.parse(task.errorJson);
      delete task.resultJson; delete task.errorJson;
      for (const key of Object.keys(task) as (keyof DurableTask)[]) if (task[key] === null) delete task[key];
      state.tasks[task.id] = task;
    }
    return state;
  }

  view<T>(fn: (state: ControlState) => T): T { return fn(this.load()); }

  update<T>(fn: (state: ControlState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.load();
      const result = fn(state);
      this.db.exec('DELETE FROM tasks; DELETE FROM pendingCommits; DELETE FROM floorRequests; DELETE FROM resources; DELETE FROM instances; DELETE FROM identities; DELETE FROM projects;');
      const project = this.db.prepare('INSERT INTO projects(id,commonDir,recovering) VALUES(?,?,?)');
      for (const value of Object.values(state.projects)) project.run(value.id,value.commonDir,value.recovering ? 1 : 0);
      const identity = this.db.prepare('INSERT INTO identities(id,projectId,name) VALUES(?,?,?)');
      for (const value of Object.values(state.identities)) identity.run(value.id,value.projectId,value.name);
      const instance = this.db.prepare('INSERT INTO instances(id,projectId,identityId,handle,epoch,active,lastSeen) VALUES(?,?,?,?,?,?,?)');
      for (const value of Object.values(state.instances)) instance.run(value.id,value.projectId,value.identityId,value.handle,value.epoch,value.active ? 1 : 0,value.lastSeen);
      const resource = this.db.prepare('INSERT INTO resources(id,projectId,type,fence,queueSequence,present) VALUES(?,?,?,?,?,?)');
      for (const value of Object.values(state.resources)) resource.run(value.id,value.projectId,value.type,value.fence,value.queueSequence,value.present ? 1 : 0);
      const request = this.db.prepare(`INSERT INTO floorRequests(id,projectId,resourceId,resourceType,identityId,instanceId,sequence,state,createdAt,updatedAt,queueUntil,
        reconnectUntil,offerId,claimBy,floorId,fence,baseRevision,snapshotCommit,expiresAt,finishedAt,resultJson,purpose,deliveryMode) VALUES(${Array(23).fill('?').join(',')})`);
      for (const value of Object.values(state.requests)) request.run(value.id,value.projectId,value.resourceId,value.resourceType,value.identityId,value.instanceId,
        value.sequence,value.state,value.createdAt,value.updatedAt,value.queueUntil,value.reconnectUntil ?? null,value.offerId ?? null,value.claimBy ?? null,value.floorId ?? null,
        value.fence ?? null,value.baseRevision ?? null,value.snapshotCommit ?? null,value.expiresAt ?? null,value.finishedAt ?? null,value.result ? JSON.stringify(value.result) : null,value.purpose ?? null,value.deliveryMode);
      const pending = this.db.prepare('INSERT INTO pendingCommits(id,projectId,resourceId,resourceType,floorRequestId,startingHead,kind,actorJson) VALUES(?,?,?,?,?,?,?,?)');
      for (const value of Object.values(state.pending)) pending.run(value.id,value.projectId,value.resourceId,value.resourceType,value.floorRequestId ?? null,value.startingHead,value.kind,JSON.stringify(value.actor));
      const task = this.db.prepare('INSERT INTO tasks(id,projectId,identityId,requestId,status,statusMessage,createdAt,updatedAt,discardAt,resultJson,errorJson) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const value of Object.values(state.tasks)) task.run(value.id,value.projectId,value.identityId,value.requestId,value.status,value.statusMessage ?? null,
        value.createdAt,value.updatedAt,value.discardAt,value.result ? JSON.stringify(value.result) : null,value.error ? JSON.stringify(value.error) : null);
      this.db.prepare("UPDATE controlMeta SET value=? WHERE key='wallClockHighWaterMs'").run(String(state.wallClockHighWaterMs));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
