import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BassfishError } from './domain.js';

/** SQLite's rollback-journal EXCLUSIVE transaction holds a kernel file lock until close/process death. */
export function exclusiveLock(path: string, waitMs = 0): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=${Math.trunc(waitMs)}; BEGIN EXCLUSIVE;`);
  } catch {
    db.close();
    throw new BassfishError('ALREADY_RUNNING', 'Another process holds the service ownership lock.');
  }
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}
