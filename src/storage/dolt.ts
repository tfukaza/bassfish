import mysql from 'mysql2/promise';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import { BassfishError } from '../domain.js';
import { notePage } from '../domain.js';
import type { ContentResourceType, ContentStore, HistoricalNote, HistoryEntry, Message, MutationResult, Note, NoteSnapshot, PendingCommit, ProjectHistoryEntry, ProjectRestoreOperation, ProjectRestoreResult, ProjectSnapshot, Resolution, ResourceLink, Snapshot, StorageResult, Thread, WriteOperation } from '../domain.js';

const database = (id: string) => {
  if (!/^p_[a-f0-9]{32}$/.test(id)) throw new BassfishError('INVALID_PROJECT', 'Invalid internal project identifier.');
  return `\`${id}\``;
};
const threadFrom = (row: RowDataPacket): Thread => ({ id: row.id, title: row.title, description: row.description, state: row.state,
  revision: String(row.revision), headSequence: String(row.headSequence), creator: row.creator, createdAt: row.createdAt });
const messageFrom = (row: RowDataPacket): Message => ({ id: row.id, threadId: row.threadId, sequence: String(row.sequence),
  identityId: row.identityId, name: row.senderName, instanceId: row.instanceId, createdAt: row.createdAt, body: row.body });
const noteFrom = (row: RowDataPacket, links: ResourceLink[] = []): Note => ({ id: row.id, path: row.path, title: row.title, body: row.body,
  labels: JSON.parse(String(row.labelsJson)) as string[], kind: row.noteKind === null ? null : String(row.noteKind), state: row.state,
  revision: String(row.revision), creator: row.creator, creatorName: row.creatorName, lastEditor: row.lastEditor,
  lastEditorName: row.lastEditorName, createdAt: row.createdAt, updatedAt: row.updatedAt, links });

export class DoltContent implements ContentStore {
  private readonly pool: Pool;
  private readonly initialized = new Set<string>();
  private readonly unsettled = new Set<string>();
  constructor(options: { socketPath: string; password: string }) {
    this.pool = mysql.createPool({ ...options, user: 'root', connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true,
      multipleStatements: false, connectTimeout: 5000, decimalNumbers: false });
  }
  private async connection(projectId: string): Promise<Connection> {
    const connection = await this.pool.getConnection();
    try { await connection.query(`USE ${database(projectId)}`); return connection; }
    catch (error) { connection.release(); throw error; }
  }
  private release(connection: Connection): void { (connection as mysql.PoolConnection).release(); }
  async ensureProject(projectId: string): Promise<void> {
    if (this.initialized.has(projectId)) return;
    await this.pool.query(`CREATE DATABASE IF NOT EXISTS ${database(projectId)}`);
    const c = await this.connection(projectId);
    try {
      const [tables] = await c.query<RowDataPacket[]>('SHOW TABLES');
      const names = tables.map(row => String(Object.values(row)[0]));
      if (names.length === 0) {
        await c.query(`CREATE TABLE threads (
          id VARCHAR(36) PRIMARY KEY, title VARCHAR(200) NOT NULL, description TEXT NOT NULL,
          state VARCHAR(16) NOT NULL, revision BIGINT UNSIGNED NOT NULL, headSequence BIGINT UNSIGNED NOT NULL,
          creator VARCHAR(36) NOT NULL, createdAt VARCHAR(32) NOT NULL
        )`);
        await c.query(`CREATE TABLE messages (
          id VARCHAR(36) PRIMARY KEY, threadId VARCHAR(36) NOT NULL, sequence BIGINT UNSIGNED NOT NULL,
          identityId VARCHAR(36) NOT NULL, senderName VARCHAR(64) NOT NULL, instanceId VARCHAR(36) NOT NULL,
          createdAt VARCHAR(32) NOT NULL, body TEXT NOT NULL,
          UNIQUE KEY thread_sequence(threadId,sequence), FOREIGN KEY (threadId) REFERENCES threads(id)
        )`);
        await c.query(`CREATE TABLE notes (
          id VARCHAR(36) PRIMARY KEY, path VARCHAR(240) COLLATE utf8mb4_bin NOT NULL UNIQUE, title VARCHAR(200) NOT NULL,
          body MEDIUMTEXT NOT NULL, labelsJson TEXT NOT NULL, noteKind VARCHAR(32), state VARCHAR(16) NOT NULL,
          revision BIGINT UNSIGNED NOT NULL, creator VARCHAR(36) NOT NULL, creatorName VARCHAR(64) NOT NULL,
          lastEditor VARCHAR(36) NOT NULL, lastEditorName VARCHAR(64) NOT NULL,
          createdAt VARCHAR(32) NOT NULL, updatedAt VARCHAR(32) NOT NULL
        )`);
        await c.query(`CREATE TABLE resource_links (
          sourceType VARCHAR(16) NOT NULL, sourceId VARCHAR(36) NOT NULL, targetType VARCHAR(16) NOT NULL, targetId VARCHAR(36) NOT NULL,
          PRIMARY KEY(sourceType,sourceId,targetType,targetId)
        )`);
        await c.query(`CREATE TABLE operations (
          operationId VARCHAR(36) PRIMARY KEY, kind VARCHAR(64) NOT NULL, actor_identityId VARCHAR(36) NOT NULL,
          actorName VARCHAR(64) NOT NULL, instanceId VARCHAR(36) NOT NULL, createdAt VARCHAR(32) NOT NULL, reason TEXT
        )`);
        await c.query(`CREATE TABLE operation_objects (
          operationId VARCHAR(36) NOT NULL, resourceType VARCHAR(16) NOT NULL, resourceId VARCHAR(36) NOT NULL,
          beforeRevision BIGINT UNSIGNED NOT NULL, afterRevision BIGINT UNSIGNED NOT NULL,
          PRIMARY KEY(operationId,resourceType,resourceId)
        )`);
        await c.query(`CREATE TABLE message_visibility (
          id VARCHAR(36) PRIMARY KEY, threadId VARCHAR(36) NOT NULL, messageId VARCHAR(36) NOT NULL, visible BOOLEAN NOT NULL,
          threadRevision BIGINT UNSIGNED NOT NULL, operationId VARCHAR(36) NOT NULL, createdAt VARCHAR(32) NOT NULL
        )`);
        await c.query('CREATE TABLE bassfish_meta (schemaVersion INT NOT NULL)');
        await c.query('INSERT INTO bassfish_meta VALUES(3)');
        await c.query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", ['bassfish:schema:3', 'Bassfish <bassfish@localhost>']);
      } else if (!['threads','messages','notes','resource_links','operations','operation_objects','message_visibility','bassfish_meta'].every(name => names.includes(name))) {
        throw new BassfishError('RESET_REQUIRED', 'This preview content schema is incompatible. Move it aside with bassfish data reset.');
      }
      const [metadata] = await c.query<RowDataPacket[]>('SELECT schemaVersion FROM bassfish_meta');
      if (Number(metadata[0]?.schemaVersion) !== 3) throw new BassfishError('RESET_REQUIRED', 'This preview content schema is incompatible. Move it aside with bassfish data reset.');
      const [dirty] = await c.query<RowDataPacket[]>('SELECT * FROM dolt_status');
      if (dirty.length) throw new BassfishError('PROJECT_RECOVERING', 'The project has an unexplained working set; it has not been staged, reset, or replayed.');
      this.initialized.add(projectId);
    } finally { this.release(c); }
  }
  private async currentHead(c: Connection): Promise<string> {
    const [rows] = await c.query<RowDataPacket[]>("SELECT DOLT_HASHOF('HEAD') AS hash");
    return String(rows[0]!.hash);
  }
  async head(projectId: string): Promise<string> {
    const c = await this.connection(projectId);
    try { return await this.currentHead(c); } finally { this.release(c); }
  }
  async listThreads(projectId: string): Promise<Thread[]> {
    const c = await this.connection(projectId);
    try {
      const head = await this.currentHead(c);
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM threads AS OF ? ORDER BY createdAt,id', [head]);
      return rows.map(threadFrom);
    } finally { this.release(c); }
  }
  async listNotes(projectId: string): Promise<Note[]> {
    const c = await this.connection(projectId);
    try {
      const head = await this.currentHead(c);
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM notes AS OF ? ORDER BY path,id', [head]);
      const [linkRows] = await c.query<RowDataPacket[]>("SELECT * FROM resource_links AS OF ? WHERE sourceType='note'", [head]);
      return rows.map(row => noteFrom(row, linkRows.filter(link => link.sourceId === row.id).map(link => ({ targetType: link.targetType, targetId: link.targetId }))));
    } finally { this.release(c); }
  }
  async resourceType(projectId: string, resourceId: string): Promise<ContentResourceType> {
    const c = await this.connection(projectId);
    try {
      const [threads] = await c.query<RowDataPacket[]>('SELECT id FROM threads WHERE id=?', [resourceId]);
      if (threads[0]) return 'thread';
      const [notes] = await c.query<RowDataPacket[]>('SELECT id FROM notes WHERE id=?', [resourceId]);
      if (notes[0]) return 'note';
      throw new BassfishError('NOT_FOUND', 'Resource not found in this project.');
    } finally { this.release(c); }
  }
  async snapshot(projectId: string, resourceId: string, limit: number, before?: string, at?: string): Promise<Snapshot> {
    const c = await this.connection(projectId);
    try {
      const commit = at ?? await this.currentHead(c);
      const [threads] = await c.query<RowDataPacket[]>('SELECT * FROM threads AS OF ? WHERE id=?', [commit, resourceId]);
      if (!threads[0]) throw new BassfishError('NOT_FOUND', 'Thread not found in this project.');
      const [rows] = await c.query<RowDataPacket[]>(`SELECT * FROM messages AS OF ? WHERE threadId=? ${before === undefined ? '' : 'AND sequence < ?'} ORDER BY sequence DESC LIMIT ?`,
        [commit, resourceId, ...(before === undefined ? [] : [before]), limit + 1]);
      const messages = rows.slice(0, limit).map(messageFrom).reverse();
      if (messages.length) {
        const [visibility] = await c.query<RowDataPacket[]>('SELECT * FROM message_visibility AS OF ? WHERE threadId=? ORDER BY threadRevision,id', [commit, resourceId]);
        const latest = new Map<string, boolean>(); for (const row of visibility) latest.set(String(row.messageId), Boolean(row.visible));
        for (const message of messages) if (latest.get(message.id) === false) { message.body = ''; message.retracted = true; }
      }
      return { resourceType: 'thread', thread: threadFrom(threads[0]), commit, messages, truncated: rows.length > limit, nextBefore: rows.length > limit ? messages[0]!.sequence : null };
    } finally { this.release(c); }
  }
  async noteSnapshot(projectId: string, resourceId: string, cursor?: string, at?: string): Promise<NoteSnapshot> {
    const c = await this.connection(projectId);
    try {
      const commit = at ?? await this.currentHead(c);
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM notes AS OF ? WHERE id=?', [commit, resourceId]);
      if (!rows[0]) throw new BassfishError('NOT_FOUND', 'Note not found in this project.');
      const [linkRows] = await c.query<RowDataPacket[]>("SELECT * FROM resource_links AS OF ? WHERE sourceType='note' AND sourceId=? ORDER BY targetType,targetId", [commit, resourceId]);
      const note = noteFrom(rows[0], linkRows.map(link => ({ targetType: link.targetType, targetId: link.targetId })));
      return { resourceType: 'note', note, commit, page: notePage(note.body, cursor) };
    } finally { this.release(c); }
  }
  async write(operation: WriteOperation | ProjectRestoreOperation): Promise<StorageResult> {
    if (operation.resourceType === 'project') return this.writeProjectRestore(operation);
    const c = await this.connection(operation.actor.projectId);
    let commitStarted = false;
    const resource = operation.resourceType === 'thread' ? operation.thread : operation.note;
    const creating = operation.mutation.kind === 'createThread' || operation.mutation.kind === 'createNote';
    const result: MutationResult = { resourceId: resource.id, previousRevision: creating ? '0' : (BigInt(resource.revision) - 1n).toString(), revision: resource.revision, doltCommit: '' };
    try {
      await c.beginTransaction();
      if (operation.resourceType === 'thread' && operation.mutation.kind === 'createThread') {
        const t = operation.thread;
        await c.query('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', [t.id, t.title, t.description, t.state, t.revision, t.headSequence, t.creator, t.createdAt]);
      } else if (operation.resourceType === 'thread') {
        const t = operation.thread;
        const [updated] = await c.query<mysql.ResultSetHeader>('UPDATE threads SET title=?,description=?,state=?,revision=?,headSequence=? WHERE id=? AND revision=?',
          [t.title, t.description, t.state, t.revision, t.headSequence, t.id, result.previousRevision]);
        if (updated.affectedRows !== 1) throw new BassfishError('REVISION_CHANGED', 'The persisted thread revision changed.');
        if (operation.mutation.kind === 'appendMessage') {
          // A deterministic server operation ID also identifies this one message; it is never a retry key.
          result.messageId = operation.id; result.sequence = t.headSequence;
          await c.query('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)', [operation.id, t.id, t.headSequence, operation.actor.identityId, operation.actor.name,
            operation.actor.instanceId, operation.at, operation.mutation.body]);
        }
        if (operation.mutation.kind === 'retractMessage' || operation.mutation.kind === 'reinstateMessage') {
          const [message] = await c.query<RowDataPacket[]>('SELECT id FROM messages WHERE id=? AND threadId=?', [operation.mutation.messageId,t.id]);
          if (!message[0]) throw new BassfishError('NOT_FOUND', 'Message not found in this thread.');
          await c.query('INSERT INTO message_visibility VALUES(?,?,?,?,?,?,?)', [operation.id,t.id,operation.mutation.messageId,operation.mutation.kind === 'reinstateMessage',t.revision,operation.id,operation.at]);
        }
        for (const [index, change] of (operation.visibilityChanges ?? []).entries()) {
          await c.query('INSERT INTO message_visibility VALUES(?,?,?,?,?,?,?)', [`${operation.id.slice(0,30)}${String(index).padStart(6,'0')}`,t.id,change.messageId,change.visible,t.revision,operation.id,operation.at]);
        }
      } else {
        const n = operation.note;
        if (operation.mutation.kind === 'createNote') {
          try { await c.query('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [n.id,n.path,n.title,n.body,JSON.stringify(n.labels),n.kind,n.state,n.revision,n.creator,n.creatorName,n.lastEditor,n.lastEditorName,n.createdAt,n.updatedAt]); }
          catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new BassfishError('PATH_CONFLICT', 'A note already reserves this path.'); throw error; }
        } else {
          try {
            const [updated] = await c.query<mysql.ResultSetHeader>('UPDATE notes SET path=?,title=?,body=?,labelsJson=?,noteKind=?,state=?,revision=?,lastEditor=?,lastEditorName=?,updatedAt=? WHERE id=? AND revision=?',
              [n.path,n.title,n.body,JSON.stringify(n.labels),n.kind,n.state,n.revision,n.lastEditor,n.lastEditorName,n.updatedAt,n.id,result.previousRevision]);
            if (updated.affectedRows !== 1) throw new BassfishError('REVISION_CHANGED', 'The persisted note revision changed.');
          } catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new BassfishError('PATH_CONFLICT', 'A note already reserves this path.'); throw error; }
        }
        await c.query("DELETE FROM resource_links WHERE sourceType='note' AND sourceId=?", [n.id]);
        for (const link of n.links) await c.query('INSERT INTO resource_links VALUES(?,?,?,?)', ['note',n.id,link.targetType,link.targetId]);
      }
      await c.query('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', [operation.id,operation.mutation.kind,operation.actor.identityId,operation.actor.name,operation.actor.instanceId,operation.at,null]);
      await c.query('INSERT INTO operation_objects VALUES(?,?,?,?,?)', [operation.id,operation.resourceType,operation.resourceId,result.previousRevision,result.revision]);
      const metadata = JSON.stringify({ bassfish: 1, operationId: operation.id, kind: operation.mutation.kind, actor: operation.actor, at: operation.at, result });
      commitStarted = true;
      const [rows] = await c.query({ sql: "CALL DOLT_COMMIT('-Am', ?, '--author', ?)", timeout: 10_000 }, [metadata, `${operation.actor.name} <${operation.actor.identityId}@bassfish.local>`]);
      const sets = rows as unknown as RowDataPacket[][];
      const hash = sets[0]?.[0]?.hash;
      result.doltCommit = hash ? String(hash) : await this.currentHead(c);
      return result;
    } catch (error) {
      // Once commit was sent, preserve uncertainty and discard the connection; no SQL mutation is repeated.
      if (!commitStarted) { try { await c.rollback(); } catch { c.destroy(); throw error; } }
      else { this.unsettled.add(operation.id); c.destroy(); }
      throw error;
    } finally { this.release(c); }
  }
  private async writeProjectRestore(operation: ProjectRestoreOperation): Promise<ProjectRestoreResult> {
    const c = await this.connection(operation.actor.projectId);
    let commitStarted = false;
    const result: ProjectRestoreResult = { operationId: operation.id, targetCommit: operation.target.commit, previousCommit: operation.current.commit, doltCommit: '', changes: operation.changes };
    try {
      await c.beginTransaction();
      if (await this.currentHead(c) !== operation.current.commit) throw new BassfishError('PREVIEW_STALE', 'The project changed after the restore preview.');
      await c.query('DELETE FROM resource_links');
      await c.query('DELETE FROM message_visibility');
      await c.query('DELETE FROM messages');
      await c.query('DELETE FROM notes');
      await c.query('DELETE FROM threads');
      for (const thread of operation.target.threads) await c.query('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', [thread.id,thread.title,thread.description,thread.state,thread.revision,thread.headSequence,thread.creator,thread.createdAt]);
      for (const message of operation.target.messages) await c.query('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)', [message.id,message.threadId,message.sequence,message.identityId,message.name,message.instanceId,message.createdAt,message.body]);
      for (const note of operation.target.notes) {
        await c.query('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [note.id,note.path,note.title,note.body,JSON.stringify(note.labels),note.kind,note.state,note.revision,note.creator,note.creatorName,note.lastEditor,note.lastEditorName,note.createdAt,note.updatedAt]);
        for (const link of note.links) await c.query('INSERT INTO resource_links VALUES(?,?,?,?)', ['note',note.id,link.targetType,link.targetId]);
      }
      for (const [index, visibility] of operation.target.visibility.entries()) await c.query('INSERT INTO message_visibility VALUES(?,?,?,?,?,?,?)', [`${operation.id.slice(0,29)}${String(index).padStart(7,'0')}`,visibility.threadId,visibility.messageId,visibility.visible,visibility.threadRevision,visibility.operationId,visibility.createdAt]);
      await c.query('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', [operation.id,'restoreSnapshot',operation.actor.identityId,operation.actor.name,operation.actor.instanceId,operation.at,`Restore ${operation.target.commit}`]);
      for (const change of operation.changes) await c.query('INSERT INTO operation_objects VALUES(?,?,?,?,?)', [operation.id,change.resourceType,change.resourceId,change.beforeRevision,change.afterRevision]);
      const metadata = JSON.stringify({ bassfish: 1, operationId: operation.id, kind: 'restoreSnapshot', actor: operation.actor, at: operation.at, result });
      commitStarted = true;
      const [rows] = await c.query({ sql: "CALL DOLT_COMMIT('-Am', ?, '--author', ?)", timeout: 10_000 }, [metadata, `${operation.actor.name} <${operation.actor.identityId}@bassfish.local>`]);
      const sets = rows as unknown as RowDataPacket[][]; const hash = sets[0]?.[0]?.hash;
      result.doltCommit = hash ? String(hash) : await this.currentHead(c);
      return result;
    } catch (error) {
      if (!commitStarted) { try { await c.rollback(); } catch { c.destroy(); throw error; } }
      else { this.unsettled.add(operation.id); c.destroy(); }
      throw error;
    } finally { this.release(c); }
  }
  async history(projectId: string, resourceType: ContentResourceType, resourceId: string): Promise<HistoryEntry[]> {
    const c = await this.connection(projectId);
    try {
      const [rows] = await c.query<RowDataPacket[]>(`SELECT o.*,x.beforeRevision,x.afterRevision
        FROM operations o JOIN operation_objects x ON x.operationId=o.operationId
        WHERE x.resourceType=? AND x.resourceId=? ORDER BY o.createdAt DESC,o.operationId DESC`, [resourceType,resourceId]);
      const [logs] = await c.query<RowDataPacket[]>('SELECT commit_hash,message FROM dolt_log');
      const commits = new Map<string,string>();
      for (const log of logs) { try { const meta = JSON.parse(String(log.message)) as { operationId?: string }; if (meta.operationId) commits.set(meta.operationId,String(log.commit_hash)); } catch {} }
      return rows.map(row => ({ operationId: row.operationId, kind: row.kind, actorIdentityId: row.actor_identityId, actorName: row.actorName,
        instanceId: row.instanceId, createdAt: row.createdAt, reason: row.reason, beforeRevision: String(row.beforeRevision), afterRevision: String(row.afterRevision), doltCommit: commits.get(String(row.operationId)) ?? '' }));
    } finally { this.release(c); }
  }
  async commitAtRevision(projectId: string, resourceType: ContentResourceType, resourceId: string, revision: string): Promise<string> {
    const entries = await this.history(projectId, resourceType, resourceId);
    const entry = entries.find(item => item.afterRevision === revision);
    if (!entry?.doltCommit) throw new BassfishError('REVISION_NOT_FOUND', 'No committed content exists at that resource revision.');
    return entry.doltCommit;
  }
  async maxRevision(projectId: string, resourceType: ContentResourceType, resourceId: string): Promise<string> {
    const c = await this.connection(projectId);
    try {
      const [rows] = await c.query<RowDataPacket[]>('SELECT MAX(afterRevision) AS revision FROM operation_objects WHERE resourceType=? AND resourceId=?',[resourceType,resourceId]);
      return rows[0]?.revision === null || rows[0]?.revision === undefined ? '0' : String(rows[0].revision);
    } finally { this.release(c); }
  }
  async maxSequence(projectId: string, threadId: string): Promise<string> {
    const entries = await this.history(projectId,'thread',threadId); let maximum = 0n;
    const c = await this.connection(projectId);
    try {
      for (const entry of entries) {
        if (!entry.doltCommit) continue;
        const [rows] = await c.query<RowDataPacket[]>('SELECT headSequence FROM threads AS OF ? WHERE id=?',[entry.doltCommit,threadId]);
        if (rows[0]) maximum = maximum > BigInt(rows[0].headSequence) ? maximum : BigInt(rows[0].headSequence);
      }
      return String(maximum);
    } finally { this.release(c); }
  }
  private async operationCommits(c: Connection): Promise<Map<string,string>> {
    const [logs] = await c.query<RowDataPacket[]>('SELECT commit_hash,message FROM dolt_log'); const commits = new Map<string,string>();
    for (const log of logs) { try { const meta = JSON.parse(String(log.message)) as { operationId?: string }; if (meta.operationId) commits.set(meta.operationId,String(log.commit_hash)); } catch {} }
    return commits;
  }
  async projectHistory(projectId: string): Promise<ProjectHistoryEntry[]> {
    const c = await this.connection(projectId);
    try {
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM operations ORDER BY createdAt DESC,operationId DESC'); const commits = await this.operationCommits(c);
      return rows.map(row => ({ operationId: String(row.operationId), kind: String(row.kind), actorIdentityId: String(row.actor_identityId), actorName: String(row.actorName), instanceId: String(row.instanceId), createdAt: String(row.createdAt), doltCommit: commits.get(String(row.operationId)) ?? '' }));
    } finally { this.release(c); }
  }
  async historicalNotes(projectId: string, at: string): Promise<HistoricalNote[]> {
    const c = await this.connection(projectId);
    try {
      const [rows] = await c.query<RowDataPacket[]>(`SELECT o.operationId,o.createdAt,x.afterRevision FROM operations AS OF ? AS o JOIN operation_objects AS OF ? AS x ON x.operationId=o.operationId WHERE x.resourceType='note' ORDER BY o.createdAt,o.operationId`,[at,at]);
      const commits = await this.operationCommits(c); const output: HistoricalNote[] = [];
      for (const row of rows) {
        const commit = commits.get(String(row.operationId)); if (!commit) continue;
        const [notes] = await c.query<RowDataPacket[]>('SELECT * FROM notes AS OF ? WHERE id=(SELECT resourceId FROM operation_objects AS OF ? WHERE operationId=? AND resourceType=\'note\')',[commit,commit,row.operationId]);
        if (!notes[0]) continue;
        const [links] = await c.query<RowDataPacket[]>("SELECT * FROM resource_links AS OF ? WHERE sourceType='note' AND sourceId=? ORDER BY targetType,targetId",[commit,notes[0].id]);
        output.push({ note: noteFrom(notes[0],links.map(link => ({ targetType: link.targetType, targetId: link.targetId }))), doltCommit: commit, changedAt: String(row.createdAt) });
      }
      return output;
    } finally { this.release(c); }
  }
  async projectSnapshot(projectId: string, at?: string): Promise<ProjectSnapshot> {
    const c = await this.connection(projectId);
    try {
      const commit = at ?? await this.currentHead(c);
      const [threads] = await c.query<RowDataPacket[]>('SELECT * FROM threads AS OF ? ORDER BY id', [commit]);
      const [messages] = await c.query<RowDataPacket[]>('SELECT * FROM messages AS OF ? ORDER BY threadId,sequence', [commit]);
      const [notes] = await c.query<RowDataPacket[]>('SELECT * FROM notes AS OF ? ORDER BY id', [commit]);
      const [links] = await c.query<RowDataPacket[]>('SELECT * FROM resource_links AS OF ? ORDER BY sourceType,sourceId,targetType,targetId', [commit]);
      const [visibility] = await c.query<RowDataPacket[]>('SELECT * FROM message_visibility AS OF ? ORDER BY threadId,threadRevision,id', [commit]);
      return { commit, threads: threads.map(threadFrom), messages: messages.map(messageFrom), notes: notes.map(row => noteFrom(row,
        links.filter(link => link.sourceType === 'note' && link.sourceId === row.id).map(link => ({ targetType: link.targetType, targetId: link.targetId })))),
        visibility: visibility.map(row => ({ messageId: row.messageId, threadId: row.threadId, visible: Boolean(row.visible), threadRevision: String(row.threadRevision), operationId: row.operationId, createdAt: row.createdAt })) };
    } finally { this.release(c); }
  }
  async resolve(pending: PendingCommit): Promise<Resolution> {
    const c = await this.connection(pending.projectId);
    try {
      const [logs] = await c.query<RowDataPacket[]>('SELECT commit_hash,message FROM dolt_log');
      for (const log of logs) {
        let meta;
        try { meta = JSON.parse(String(log.message)); } catch { continue; }
        if (meta.bassfish === 1 && meta.operationId === pending.id) {
          // Working changes still need diagnosis; a found commit is not permission to stage an unexplained working set.
          const [dirty] = await c.query<RowDataPacket[]>('SELECT * FROM dolt_status');
          if (dirty.length) return { state: 'unknown' };
          return { state: 'committed', result: { ...meta.result, doltCommit: String(log.commit_hash) } as StorageResult };
        }
      }
      const head = await this.currentHead(c);
      const [dirty] = await c.query<RowDataPacket[]>('SELECT * FROM dolt_status');
      // The supervisor guarantees that no old SQL server remains when restart recovery runs.
      // In-process unknown commits require the same exclusion; the caller must restart the SQL service first.
      return !this.unsettled.has(pending.id) && head === pending.startingHead && dirty.length === 0 ? { state: 'absent' } : { state: 'unknown' };
    } finally { this.release(c); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
