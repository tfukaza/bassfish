import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, chmod, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database, Transaction } from '@tursodatabase/database';
import { requireSupportedPlatform } from './platform.js';
import { BassfishError, requireThat } from '../domain.js';

export type SqlValue = string | number | bigint | Uint8Array | null;

/** All statements in a unit of work use this handle, never its pooled connection. */
export class TursoTransaction {
  private readonly committed: Array<() => void> = [];
  private readonly publicationBatch = randomUUID();
  private publicationPosition = 0;
  outboxOrder(): [string, number] {
    return [this.publicationBatch, this.publicationPosition++];
  }
  constructor(
    private readonly transaction: Transaction,
    readonly writable: boolean,
  ) {}

  async all<T extends object>(sql: string, ...args: SqlValue[]): Promise<T[]> {
    return (await this.transaction.prepare(sql)).all(...args) as Promise<T[]>;
  }

  async get<T extends object>(sql: string, ...args: SqlValue[]): Promise<T | undefined> {
    return (await this.transaction.prepare(sql)).get(...args) as Promise<T | undefined>;
  }

  async run(sql: string, ...args: SqlValue[]): Promise<number> {
    requireThat(this.writable, 'READ_ONLY', 'A read transaction cannot modify storage.');
    return (await (await this.transaction.prepare(sql)).run(...args)).changes;
  }

  afterCommit(callback: () => void): void {
    this.committed.push(callback);
  }

  publish(): void {
    for (const callback of this.committed) {
      try {
        callback();
      } catch {
        // A failed wakeup cannot turn a committed write into a failed operation.
      }
    }
  }
}

/** Native 0.7.2 uses GenericFailure for many unrelated errors. Match only known conflicts. */
export function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(?:step failed: )?(?:Write-write conflict|Transaction conflict|database is locked|database is busy)(?:$| \()/i.test(
    error.message,
  );
}

export async function requireFreshStorage(dataDir: string): Promise<void> {
  for (const name of ['control.sqlite', 'dolt', 'projects', 'dolt-config']) {
    try {
      await access(join(dataDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new BassfishError(
      'RESET_REQUIRED',
      'Legacy Bassfish data found. Stop the old daemon and run bassfish data reset --yes to archive it before initializing Turso.',
    );
  }
}

/** One daemon owns the file; independent units of work lease independent connections. */
export class TursoStore {
  private readonly context = new AsyncLocalStorage<TursoTransaction>();
  private readonly available: Database[];
  private readonly waiters: Array<{
    resolve: (db: Database) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly drained = new Set<() => void>();
  private active = 0;
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly connections: Database[]) {
    this.available = [...connections];
  }

  static async open(path: string, schema = '', connectionCount = 8): Promise<TursoStore> {
    requireThat(
      Number.isInteger(connectionCount) && connectionCount > 0,
      'INVALID_ARGUMENT',
      'Invalid connection count.',
    );
    requireSupportedPlatform();
    const { connect } = await import('@tursodatabase/database');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const connections: Database[] = [];
    try {
      for (let index = 0; index < connectionCount; index++) {
        const db = await connect(path);
        connections.push(db);
        await db.exec(
          "PRAGMA journal_mode='mvcc'; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
        );
        if (index === 0 && schema) {
          await db.transactionAsync(async transaction => {
            await transaction.exec(schema);
          })();
        }
      }
      await chmod(path, 0o600);
      return new TursoStore(connections);
    } catch (error) {
      await Promise.allSettled(connections.map(db => db.close()));
      throw error;
    }
  }

  current(): TursoTransaction | undefined {
    return this.context.getStore();
  }

  read<T>(callback: (transaction: TursoTransaction) => Promise<T>): Promise<T> {
    return this.execute(false, callback);
  }

  write<T>(callback: (transaction: TursoTransaction) => Promise<T>): Promise<T> {
    return this.execute(true, callback);
  }

  private async acquire(): Promise<Database> {
    requireThat(!this.closing, 'STORAGE_UNAVAILABLE', 'Storage is closing.');
    const db = this.available.pop();
    if (db) {
      this.active++;
      return db;
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(db: Database): void {
    const waiter = this.waiters.shift();
    if (waiter && !this.closing) {
      waiter.resolve(db);
      return;
    }
    this.available.push(db);
    this.active--;
    if (!this.active) for (const resolve of this.drained) resolve();
  }

  private async execute<T>(
    writable: boolean,
    callback: (transaction: TursoTransaction) => Promise<T>,
  ): Promise<T> {
    const parent = this.context.getStore();
    if (parent) {
      requireThat(
        !writable || parent.writable,
        'READ_ONLY',
        'Cannot promote a read transaction to a write transaction.',
      );
      return callback(parent);
    }
    for (let attempt = 0; ; attempt++) {
      const db = await this.acquire();
      let scope: TursoTransaction | undefined;
      let callbackError: unknown;
      let commitError: unknown;
      try {
        const result = await db
          .transactionAsync(async transaction => {
            // 0.7.2 can automatically abort a conflicting transaction. Its wrapper then
            // masks the conflict with "cannot rollback". Preserve COMMIT's original error.
            const exec = transaction.exec.bind(transaction);
            transaction.exec = async (sql, options) => {
              try {
                return await exec(sql, options);
              } catch (error) {
                if (sql.trim().toUpperCase() === 'COMMIT') commitError = error;
                throw error;
              }
            };
            scope = new TursoTransaction(transaction, writable);
            try {
              return await this.context.run(scope, () => callback(scope!));
            } catch (error) {
              callbackError = error;
              throw error;
            }
          })
          .concurrent();
        scope!.publish();
        return result;
      } catch (error) {
        // The driver returns the original callback error only after successful rollback.
        // A rollback error can mask it; that case must never be retried.
        const original = callbackError ?? commitError ?? error;
        const alreadyAborted =
          error instanceof Error &&
          error.message ===
            'step failed: Transaction error: cannot rollback - no transaction is active';
        const rolledBack = !db.inTransaction && (original === error || alreadyAborted);
        if (db.inTransaction) {
          // Never lease a connection whose rollback outcome is unresolved.
          void this.close().catch(() => {});
          throw new BassfishError(
            'OUTCOME_UNKNOWN',
            'Storage could not confirm rollback. Reconnect and inspect the resource before retrying.',
          );
        }
        if (!rolledBack || !isTransactionConflict(original)) {
          if (commitError)
            throw new BassfishError(
              'OUTCOME_UNKNOWN',
              'Storage could not confirm commit. Reconnect and inspect the resource before retrying.',
            );
          throw original;
        }
        if (attempt === 4)
          throw new BassfishError(
            'STORAGE_BUSY',
            'Storage remained busy after five transaction attempts. Try again.',
          );
      } finally {
        this.release(db);
      }
      await delay(5 * 2 ** attempt + Math.floor(Math.random() * 5));
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.closing = true;
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new BassfishError('STORAGE_UNAVAILABLE', 'Storage is closing.'));
      if (this.active) await new Promise<void>(resolve => this.drained.add(resolve));
      await Promise.all(this.connections.map(db => db.close()));
    })());
  }
}
