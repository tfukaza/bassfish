import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HistoricalNote, Note } from '../domain.js';

export interface SearchMatch { noteId: string; path: string; revision: string; snippet: string }
export interface HistoricalSearchMatch extends SearchMatch { doltCommit: string; changedAt: string; state: string }

/** Disposable current-state index. A head mismatch always triggers a full rebuild from Dolt. */
export class NoteSearchIndex {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS indexedProjects(projectId TEXT PRIMARY KEY, doltHead TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS indexedHistoryProjects(projectId TEXT PRIMARY KEY, doltHead TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS noteIndex USING fts5(projectId UNINDEXED,noteId UNINDEXED,revision UNINDEXED,path,title,labels,noteKind,body,state UNINDEXED);
      CREATE VIRTUAL TABLE IF NOT EXISTS noteHistoryIndex USING fts5(projectId UNINDEXED,noteId UNINDEXED,revision UNINDEXED,doltCommit UNINDEXED,changedAt UNINDEXED,path,title,labels,noteKind,body,state UNINDEXED);`);
  }
  ensure(projectId: string, head: string, notes: Note[]): void {
    const row = this.db.prepare('SELECT doltHead FROM indexedProjects WHERE projectId=?').get(projectId) as { doltHead: string } | undefined;
    if (row?.doltHead === head) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM noteIndex WHERE projectId=?').run(projectId);
      const insert = this.db.prepare('INSERT INTO noteIndex VALUES(?,?,?,?,?,?,?,?,?)');
      for (const note of notes) insert.run(projectId,note.id,note.revision,note.path,note.title,note.labels.join(' '),note.kind ?? '',note.body,note.state);
      this.db.prepare('INSERT INTO indexedProjects VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET doltHead=excluded.doltHead').run(projectId,head);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  search(projectId: string, query: string, states: string[], limit: number, offset: number): SearchMatch[] {
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT noteId,path,revision,snippet(noteIndex,7,'[',']','…',16) AS snippet FROM noteIndex
      WHERE projectId=? AND noteIndex MATCH ? AND state IN (${placeholders}) ORDER BY rank,path,noteId LIMIT ? OFFSET ?`).all(projectId,query,...states,limit,offset) as Record<string, unknown>[];
    return rows.map(row => ({ noteId: String(row.noteId), path: String(row.path), revision: String(row.revision), snippet: Buffer.from(String(row.snippet)).subarray(0,512).toString('utf8') }));
  }
  ensureHistory(projectId: string, head: string, notes: HistoricalNote[]): void {
    const row = this.db.prepare('SELECT doltHead FROM indexedHistoryProjects WHERE projectId=?').get(projectId) as { doltHead: string } | undefined;
    if (row?.doltHead === head) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM noteHistoryIndex WHERE projectId=?').run(projectId);
      const insert = this.db.prepare('INSERT INTO noteHistoryIndex VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const seen = new Set<string>();
      for (const entry of notes) {
        const note = entry.note; const key = `${note.id}:${note.revision}`; if (seen.has(key)) continue; seen.add(key);
        insert.run(projectId,note.id,note.revision,entry.doltCommit,entry.changedAt,note.path,note.title,note.labels.join(' '),note.kind ?? '',note.body,note.state);
      }
      this.db.prepare('INSERT INTO indexedHistoryProjects VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET doltHead=excluded.doltHead').run(projectId,head);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  searchHistory(projectId: string, query: string, states: string[], noteId: string | undefined, limit: number, offset: number): HistoricalSearchMatch[] {
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT noteId,path,revision,doltCommit,changedAt,state,snippet(noteHistoryIndex,9,'[',']','…',16) AS snippet FROM noteHistoryIndex
      WHERE projectId=? AND noteHistoryIndex MATCH ? AND state IN (${placeholders}) ${noteId ? 'AND noteId=?' : ''}
      ORDER BY rank,changedAt DESC,noteId,revision LIMIT ? OFFSET ?`).all(projectId,query,...states,...(noteId ? [noteId] : []),limit,offset) as Record<string, unknown>[];
    return rows.map(row => ({ noteId: String(row.noteId), path: String(row.path), revision: String(row.revision), doltCommit: String(row.doltCommit),
      changedAt: String(row.changedAt), state: String(row.state), snippet: Buffer.from(String(row.snippet)).subarray(0,512).toString('utf8') }));
  }
  close(): void { this.db.close(); }
}
