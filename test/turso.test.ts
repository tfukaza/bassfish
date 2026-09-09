import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TursoStore, isTransactionConflict, requireFreshStorage } from '../src/storage/turso.js';

const schema = `
  CREATE TABLE resources(id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0));
  CREATE TABLE notifications(id TEXT PRIMARY KEY, resourceId TEXT REFERENCES resources(id));
  INSERT INTO resources VALUES('a',0),('b',0);
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bf-turso-'));
  const path = join(dir, 'bassfish.db');
  const store = await TursoStore.open(path, schema);
  return {
    store,
    path,
    close: async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('independent transactions overlap and persist on reopen', async () => {
  const f = await fixture();
  try {
    let arrived = 0;
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => {
      resume = resolve;
    });
    await Promise.all(
      ['a', 'b'].map(id =>
        f.store.write(async tx => {
          await tx.run('UPDATE resources SET revision=revision+1 WHERE id=?', id);
          if (++arrived === 2) resume();
          await barrier;
          await tx.run('INSERT INTO notifications VALUES(?,?)', id, id);
        }),
      ),
    );
    await f.store.close();
    const reopened = await TursoStore.open(f.path);
    try {
      assert.deepEqual(await reopened.read(tx => tx.all('SELECT * FROM resources ORDER BY id')), [
        { id: 'a', revision: 1 },
        { id: 'b', revision: 1 },
      ]);
      assert.equal((await reopened.read(tx => tx.all('SELECT * FROM notifications'))).length, 2);
      assert.deepEqual(await reopened.read(tx => tx.get('PRAGMA integrity_check')), {
        integrity_check: 'ok',
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('atomic rollback suppresses both partial state and wakeups', async () => {
  const f = await fixture();
  try {
    let wakes = 0;
    await assert.rejects(
      f.store.write(async tx => {
        await tx.run("UPDATE resources SET revision=1 WHERE id='a'");
        await tx.run("INSERT INTO notifications VALUES('n','a')");
        tx.afterCommit(() => {
          wakes++;
        });
        throw new Error('injected');
      }),
      /injected/,
    );
    assert.deepEqual(
      await f.store.read(tx => tx.get("SELECT revision FROM resources WHERE id='a'")),
      { revision: 0 },
    );
    assert.deepEqual(await f.store.read(tx => tx.all('SELECT * FROM notifications')), []);
    assert.equal(wakes, 0);
    await f.store.write(async tx => {
      tx.afterCommit(() => {
        wakes++;
      });
    });
    assert.equal(wakes, 1);
  } finally {
    await f.close();
  }
});

test('contended increments retry complete transactions without losing updates', async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.store.write(async tx => {
          const before = await tx.get<{ revision: number }>(
            "SELECT revision FROM resources WHERE id='a'",
          );
          await tx.run("UPDATE resources SET revision=? WHERE id='a'", before!.revision + 1);
        }),
      ),
    );
    assert.deepEqual(
      await f.store.read(tx => tx.get("SELECT revision FROM resources WHERE id='a'")),
      { revision: 8 },
    );
  } finally {
    await f.close();
  }
});

test('nested transactions use the leased handle and cannot promote a reader', async () => {
  const f = await fixture();
  try {
    await f.store.write(async tx => {
      await f.store.write(async nested => {
        assert.equal(nested, tx);
        await nested.run("UPDATE resources SET revision=3 WHERE id='a'");
      });
    });
    await assert.rejects(
      f.store.read(() => f.store.write(async () => {})),
      /Cannot promote/,
    );
    await assert.rejects(
      f.store.write(tx => tx.run("INSERT INTO notifications VALUES('bad','missing')")),
      /FOREIGN KEY/,
    );
  } finally {
    await f.close();
  }
});

test('only known native conflict messages qualify for automatic retry', () => {
  assert.equal(isTransactionConflict(new Error('step failed: Write-write conflict')), true);
  assert.equal(
    isTransactionConflict(new Error('step failed: Runtime error: UNIQUE constraint failed')),
    false,
  );
  assert.equal(isTransactionConflict(new Error('GenericFailure')), false);
});

test('fresh-storage guard rejects legacy data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-turso-fresh-'));
  try {
    await requireFreshStorage(dir);
    await mkdir(join(dir, 'dolt'));
    await assert.rejects(requireFreshStorage(dir), /Legacy Bassfish data found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
