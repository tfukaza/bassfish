import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connect as officialConnect } from '@tursodatabase/database';
import type {
  DatabasePromise,
  Transaction,
  AsyncTransactionFunction,
} from '@tursodatabase/database-common';
import { TursoStore, type TursoStoreOptions } from '../src/storage/turso.js';

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>(done => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
async function fixture(t: test.TestContext, options: TursoStoreOptions = {}, count = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'bf-recycle-'));
  const path = join(dir, 'bassfish.db');
  const store = await TursoStore.open(
    path,
    'CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO counter VALUES(1,0);',
    count,
    {
      connect: officialConnect,
      bindingIdentity: 'official-0.7.2',
      prepareLimit: 4,
      ...options,
    },
  );
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { store, path };
}
function instrument(db: DatabasePromise, hook: (tx: Transaction) => void) {
  const original = db.transactionAsync.bind(db) as (
    callback: (tx: Transaction) => Promise<unknown>,
  ) => AsyncTransactionFunction<(tx: Transaction) => Promise<unknown>>;
  db.transactionAsync = ((callback: (tx: Transaction) => Promise<unknown>) =>
    original(async tx => {
      hook(tx);
      return callback(tx);
    })) as typeof db.transactionAsync;
}

test('one-shot cleanup covers all/get/run, execution errors and rollback; preserves execution error', async t => {
  let closes = 0;
  const executionError = new Error('execution failed');
  const { store } = await fixture(t, {
    prepareLimit: Infinity,
    connect: async path => {
      const db = await officialConnect(path);
      instrument(db, tx => {
        const prepare = tx.prepare.bind(tx);
        tx.prepare = async sql => {
          const stmt = await prepare(sql);
          const close = stmt.close.bind(stmt);
          stmt.close = () => {
            closes++;
            close();
            if (sql.includes('failure') || sql.includes('cleanup'))
              throw new Error('cleanup failed');
          };
          if (sql.includes('failure'))
            stmt.get = async () => {
              throw executionError;
            };
          return stmt;
        };
      });
      return db;
    },
  });
  await store.write(async tx => {
    await tx.all('SELECT * FROM counter');
    await tx.get('SELECT * FROM counter');
    await tx.run('UPDATE counter SET n=1');
  });
  await assert.rejects(
    store.read(tx => tx.get('SELECT 1 AS failure')),
    error => error === executionError,
  );
  await assert.rejects(
    store.write(async tx => {
      await tx.run('UPDATE counter SET n=2');
      throw new Error('rollback');
    }),
    /rollback/,
  );
  await assert.rejects(
    store.write(tx => tx.run('INSERT INTO counter VALUES(1,3)')),
    /UNIQUE/,
  );
  await assert.rejects(
    store.read(tx => tx.get('SELECT 1 AS cleanup')),
    /cleanup failed/,
  );
  assert.equal(closes, 7);
  assert.equal(store.diagnostics().connections[0]!.totalPrepares, 7);
  assert.deepEqual(await store.read(tx => tx.get('SELECT n FROM counter')), { n: 1 });
});

test('failed prepares do not count; nested operations and rolled-back attempts do count', async t => {
  const { store } = await fixture(t, { prepareLimit: Infinity });
  await assert.rejects(store.read(tx => tx.get('invalid SQL')));
  assert.equal(store.diagnostics().connections[0]!.prepares, 0);
  await assert.rejects(
    store.write(async tx => {
      await tx.get('SELECT n FROM counter');
      await store.read(nested => nested.all('SELECT n FROM counter'));
      await store.write(nested => nested.run('UPDATE counter SET n=1'));
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal(store.diagnostics().connections[0]!.prepares, 3);
});

test('crossing threshold keeps leased transaction intact; FIFO acquisitions wait for replacement', async t => {
  const entered = deferred(),
    finish = deferred(),
    opened = deferred(),
    configured = deferred();
  let opens = 0;
  const { store } = await fixture(t, {
    connect: async path => {
      const db = await officialConnect(path);
      if (++opens === 2) {
        const exec = db.exec.bind(db);
        db.exec = async sql => {
          opened.resolve();
          await configured.promise;
          await exec(sql);
        };
      }
      return db;
    },
  });
  const first = store.write(async tx => {
    for (let i = 0; i < 9; i++) await tx.run('UPDATE counter SET n=n+1');
    entered.resolve();
    await finish.promise;
    assert.equal(opens, 1);
    assert.equal(store.diagnostics().connections[0]!.state, 'leased');
    return 9;
  });
  await entered.promise;
  const order: number[] = [];
  const queued = [1, 2, 3].map(i =>
    store.read(async tx => {
      order.push(i);
      return tx.get('SELECT n FROM counter');
    }),
  );
  finish.resolve();
  assert.equal(await first, 9);
  await opened.promise;
  assert.equal(store.diagnostics().connections[0]!.prepares, 9);
  assert.deepEqual(order, []);
  configured.resolve();
  assert.deepEqual(await Promise.all(queued), [{ n: 9 }, { n: 9 }, { n: 9 }]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(store.diagnostics().replacementSuccesses, 1);
  assert.equal(store.diagnostics().connections[0]!.generation, 1);
});

test('replacement opening is serialized and retains at least one open connection', async t => {
  let live = 0,
    maxLive = 0,
    opens = 0;
  const entered = deferred(),
    finish = deferred();
  const { store } = await fixture(
    t,
    {
      prepareLimit: 1,
      connect: async path => {
        const db = await officialConnect(path);
        opens++;
        live++;
        maxLive = Math.max(maxLive, live);
        const close = db.close.bind(db);
        db.close = async () => {
          if (opens > 2 && !store?.diagnostics().closing) assert.ok(live > 1);
          await close();
          live--;
        };
        return db;
      },
    },
    2,
  );
  let arrived = 0;
  const work = [1, 2].map(() =>
    store.read(async tx => {
      await tx.get('SELECT 1');
      if (++arrived === 2) entered.resolve();
      await finish.promise;
    }),
  );
  await entered.promise;
  finish.resolve();
  await Promise.all(work);
  await Promise.all([store.read(tx => tx.get('SELECT 1')), store.read(tx => tx.get('SELECT 1'))]);
  await store.close();
  assert.equal(maxLive, 3);
  assert.equal(live, 0);
});

for (const failure of ['open', 'configure', 'close'] as const)
  test(`replacement ${failure} failure preserves committed result, rejects waiters and closes partial replacements`, async t => {
    let opens = 0,
      closes = 0,
      failed = false,
      calls = 0,
      publications = 0;
    const entered = deferred(),
      fail = deferred();
    const { store, path } = await fixture(t, {
      prepareLimit: 1,
      connect: async path => {
        const number = ++opens;
        if (number > 1 && failure === 'open') {
          entered.resolve();
          await fail.promise;
          throw new Error('opening failed');
        }
        const db = await officialConnect(path);
        if (number > 1 && failure === 'configure')
          db.exec = async () => {
            entered.resolve();
            await fail.promise;
            throw new Error('configuration failed');
          };
        const close = db.close.bind(db);
        db.close = async () => {
          if (number === 1 && failure === 'close' && !failed) {
            failed = true;
            entered.resolve();
            await fail.promise;
            throw new Error('close failed');
          }
          closes++;
          await close();
        };
        return db;
      },
    });
    assert.equal(
      await store.write(async tx => {
        calls++;
        await tx.run('UPDATE counter SET n=n+1');
        tx.afterCommit(() => {
          publications++;
        });
        return 'committed';
      }),
      'committed',
    );
    await entered.promise;
    const queued = [1, 2].map(() =>
      assert.rejects(
        store.read(tx => tx.get('SELECT n FROM counter')),
        { code: 'STORAGE_UNAVAILABLE' },
      ),
    );
    fail.resolve();
    await Promise.all(queued);
    await store.close();
    assert.equal(calls, 1);
    assert.equal(publications, 1);
    assert.equal(closes, failure === 'open' ? 1 : 2);
    assert.equal(store.diagnostics().replacementFailures, 1);
    assert.equal(store.diagnostics().openConnections, 0);
    const reopened = await TursoStore.open(path, '', 1, {
      connect: officialConnect,
      bindingIdentity: 'official-0.7.2',
    });
    try {
      assert.deepEqual(await reopened.read(tx => tx.get('SELECT n FROM counter')), { n: 1 });
    } finally {
      await reopened.close();
    }
  });

test('shutdown waits for active leases and partially configured replacement', async t => {
  const opening = deferred(),
    configure = deferred(),
    entered = deferred(),
    finish = deferred();
  let opens = 0,
    closed = 0;
  const { store } = await fixture(
    t,
    {
      prepareLimit: 1,
      connect: async path => {
        const db = await officialConnect(path);
        const close = db.close.bind(db);
        db.close = async () => {
          closed++;
          await close();
        };
        if (++opens === 3) {
          const exec = db.exec.bind(db);
          db.exec = async sql => {
            opening.resolve();
            await configure.promise;
            await exec(sql);
          };
        }
        return db;
      },
    },
    2,
  );
  const held = store.read(async tx => {
    await tx.get('SELECT 1');
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  await store.read(tx => tx.get('SELECT 1'));
  await opening.promise;
  let done = false;
  const shutdown = store.close().then(() => {
    done = true;
  });
  assert.equal(store.close(), store.close());
  await delay(10);
  assert.equal(done, false);
  assert.equal(closed, 0);
  configure.resolve();
  await delay(10);
  assert.equal(done, false);
  finish.resolve();
  await held;
  await shutdown;
  assert.equal(closed, 3);
  assert.equal(store.diagnostics().openConnections, 0);
});

test('uncertain commit crossing threshold is never replayed or published and persists exactly once', async t => {
  let callbacks = 0,
    publications = 0,
    inject = false;
  const { store } = await fixture(t, {
    prepareLimit: 1,
    connect: async path => {
      const db = await officialConnect(path);
      instrument(db, tx => {
        const exec = tx.exec.bind(tx);
        tx.exec = async sql => {
          await exec(sql);
          if (sql === 'COMMIT' && inject) {
            inject = false;
            throw new Error('lost commit response');
          }
        };
      });
      return db;
    },
  });
  // Enable injection after schema initialization.
  inject = true;
  await assert.rejects(
    store.write(async tx => {
      callbacks++;
      await tx.run('UPDATE counter SET n=n+1');
      tx.afterCommit(() => {
        publications++;
      });
    }),
    { code: 'OUTCOME_UNKNOWN' },
  );
  assert.equal(callbacks, 1);
  assert.equal(publications, 0);
  assert.deepEqual(await store.read(tx => tx.get('SELECT n FROM counter')), { n: 1 });
});

test('concurrent writes survive multiple generations and persist on reopen', async t => {
  const { store, path } = await fixture(t, {}, 2);
  for (let batch = 0; batch < 12; batch++)
    await Promise.all([1, 2].map(() => store.write(tx => tx.run('UPDATE counter SET n=n+1'))));
  assert.ok(store.diagnostics().replacementSuccesses >= 4);
  await store.close();
  const db = await officialConnect(path);
  try {
    assert.deepEqual(await db.get('SELECT n FROM counter'), { n: 24 });
  } finally {
    await db.close();
  }
});

test('a conflict attempt counts prepares and closes statements before retrying across generations', async t => {
  let fail = true,
    callbacks = 0,
    closes = 0;
  const { store } = await fixture(t, {
    prepareLimit: 1,
    connect: async path => {
      const db = await officialConnect(path);
      instrument(db, tx => {
        const prepare = tx.prepare.bind(tx);
        tx.prepare = async sql => {
          const stmt = await prepare(sql);
          const get = stmt.get.bind(stmt),
            close = stmt.close.bind(stmt);
          stmt.get = async (...args) => {
            const result = await get(...args);
            if (fail) {
              fail = false;
              throw new Error('step failed: Write-write conflict');
            }
            return result;
          };
          stmt.close = () => {
            closes++;
            close();
          };
          return stmt;
        };
      });
      return db;
    },
  });
  assert.deepEqual(
    await store.read(tx => {
      callbacks++;
      return tx.get('SELECT n FROM counter');
    }),
    { n: 0 },
  );
  assert.equal(callbacks, 2);
  assert.equal(closes, 2);
  assert.equal(store.diagnostics().connections[0]!.totalPrepares, 2);
  assert.ok(store.diagnostics().replacementSuccesses >= 1);
});

test('replacement failure drains an active write without changing either committed outcome', async t => {
  let opens = 0,
    callbacks = 0,
    publications = 0;
  const held = deferred(),
    finish = deferred(),
    replacing = deferred(),
    fail = deferred();
  const { store, path } = await fixture(
    t,
    {
      prepareLimit: 1,
      connect: async path => {
        if (++opens > 2) {
          replacing.resolve();
          await fail.promise;
          throw new Error('replacement failed');
        }
        return officialConnect(path);
      },
    },
    2,
  );
  const active = store.write(async tx => {
    callbacks++;
    await tx.run('INSERT INTO counter VALUES(2,0)');
    held.resolve();
    await finish.promise;
    await tx.run('UPDATE counter SET n=9 WHERE id=2');
    tx.afterCommit(() => {
      publications++;
    });
    return 'active write committed';
  });
  await held.promise;
  assert.equal(
    await store.write(async tx => {
      callbacks++;
      await tx.run('UPDATE counter SET n=1 WHERE id=1');
      tx.afterCommit(() => {
        publications++;
      });
      return 'first committed';
    }),
    'first committed',
  );
  await replacing.promise;
  const queued = assert.rejects(
    store.read(tx => tx.get('SELECT 1')),
    { code: 'STORAGE_UNAVAILABLE' },
  );
  fail.resolve();
  await queued;
  let closed = false;
  const shutdown = store.close().then(() => {
    closed = true;
  });
  await delay(10);
  assert.equal(closed, false);
  finish.resolve();
  assert.equal(await active, 'active write committed');
  await shutdown;
  assert.equal(callbacks, 2);
  assert.equal(publications, 2);
  const db = await officialConnect(path);
  try {
    assert.deepEqual(await db.all('SELECT n FROM counter ORDER BY id'), [{ n: 1 }, { n: 9 }]);
  } finally {
    await db.close();
  }
});

test('shutdown waits for replacement opening and closes it when opening completes', async t => {
  let opens = 0,
    closes = 0;
  const opening = deferred(),
    finish = deferred();
  const { store } = await fixture(t, {
    prepareLimit: 1,
    connect: async path => {
      const db = await officialConnect(path);
      const close = db.close.bind(db);
      db.close = async () => {
        closes++;
        await close();
      };
      if (++opens > 1) {
        opening.resolve();
        await finish.promise;
      }
      return db;
    },
  });
  await store.read(tx => tx.get('SELECT 1'));
  await opening.promise;
  let done = false;
  const shutdown = store.close().then(() => {
    done = true;
  });
  await delay(10);
  assert.equal(done, false);
  assert.equal(closes, 0);
  finish.resolve();
  await shutdown;
  assert.equal(closes, 2);
  assert.equal(store.diagnostics().openConnections, 0);
});
