import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as Y from 'yjs';
import { openDatabase } from '../src/server/main.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-update-store-'));
  const filename = join(directory, 'board.sqlite');
  const db = await openDatabase(filename);
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run('account-1', 'member', 'not-used-by-test');
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run('board-1', 'Durable board');
  return { directory, filename, db };
}

function createYjsUpdate(value) {
  const doc = new Y.Doc();
  doc.getMap('board').set('title', value);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

test('durable acknowledgement is returned only after the SQLite update is committed', async () => {
  const fixture = await createFixture();
  const store = createBoardUpdateStore(fixture.db);
  const bytes = createYjsUpdate('committed');

  try {
    fixture.db.exec(`CREATE TRIGGER reject_board_update BEFORE INSERT ON board_updates
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    assert.throws(() => store.persistUpdate({
      updateId: 'update-fails', boardId: 'board-1', originAccountId: 'account-1', bytes,
    }), /simulated storage failure/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 0);

    fixture.db.exec('DROP TRIGGER reject_board_update');
    const ack = store.persistUpdate({
      updateId: 'update-commits', boardId: 'board-1', originAccountId: 'account-1', bytes,
    });
    assert.deepEqual(ack, {
      boardId: 'board-1',
      updateId: 'update-commits',
      committedAt: fixture.db.prepare('SELECT received_at FROM board_updates WHERE id = ?')
        .get('update-commits').received_at,
    });

    const observer = await openDatabase(fixture.filename);
    assert.equal(observer.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 1);
    observer.close();
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('committed board updates reconstruct a Y.Doc after closing and reopening SQLite', async () => {
  const fixture = await createFixture();
  const store = createBoardUpdateStore(fixture.db);
  const bytes = createYjsUpdate('survives restart');

  try {
    const ack = store.persistUpdate({
      updateId: 'update-restart', boardId: 'board-1', originAccountId: 'account-1', bytes,
    });
    assert.equal(ack.updateId, 'update-restart');
    fixture.db.close();

    const reopened = await openDatabase(fixture.filename);
    try {
      const recovered = createBoardUpdateStore(reopened).loadDocument('board-1');
      assert.equal(recovered.getMap('board').get('title'), 'survives restart');
      recovered.destroy();
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('duplicate update delivery is idempotent and conflicting ID reuse is rejected', async () => {
  const fixture = await createFixture();
  const store = createBoardUpdateStore(fixture.db);
  const bytes = createYjsUpdate('same payload');

  try {
    const input = { updateId: 'update-retry', boardId: 'board-1', originAccountId: 'account-1', bytes };
    const firstAck = store.persistUpdate(input);
    const retryAck = store.persistUpdate(input);
    assert.deepEqual(retryAck, firstAck);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 1);

    assert.throws(() => store.persistUpdate({
      ...input,
      bytes: createYjsUpdate('different payload'),
    }), { code: 'UPDATE_ID_CONFLICT' });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('checkpoint pruning preserves state across restart and late join, including a pruned retry', async () => {
  const fixture = await createFixture();
  const store = createBoardUpdateStore(fixture.db);
  const source = new Y.Doc();
  const board = source.getMap('board');
  board.set('first', 'one');
  const firstBytes = Y.encodeStateAsUpdate(source);
  const afterFirst = Y.encodeStateVector(source);
  board.set('second', 'two');
  const secondBytes = Y.encodeStateAsUpdate(source, afterFirst);

  try {
    store.persistUpdate({ updateId: 'update-first', boardId: 'board-1', originAccountId: 'account-1', bytes: firstBytes });
    store.persistUpdate({ updateId: 'update-second', boardId: 'board-1', originAccountId: 'account-1', bytes: secondBytes });
    const expected = [['first', 'one'], ['second', 'two']];
    const beforeCheckpoint = store.loadDocument('board-1');
    assert.deepEqual([...beforeCheckpoint.getMap('board').entries()].sort(), expected);
    beforeCheckpoint.destroy();

    const checkpoint = store.checkpointBoard('board-1');
    assert.equal(checkpoint.coveredSequence, 2);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get('board-1').count, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_checkpoints WHERE board_id = ?').get('board-1').count, 1);
    fixture.db.close();

    const reopened = await openDatabase(fixture.filename);
    try {
      const reopenedStore = createBoardUpdateStore(reopened);
      const afterRestart = reopenedStore.loadDocument('board-1');
      assert.deepEqual([...afterRestart.getMap('board').entries()].sort(), expected);
      afterRestart.destroy();

      // A newly created document represents a late join and sees the same durable state.
      const lateJoin = reopenedStore.loadDocument('board-1');
      assert.deepEqual([...lateJoin.getMap('board').entries()].sort(), expected);
      lateJoin.destroy();

      // The old update ID was pruned, so its exact Yjs bytes may be stored again.
      reopenedStore.persistUpdate({
        updateId: 'update-first', boardId: 'board-1', originAccountId: 'account-1', bytes: firstBytes,
      });
      const afterRetry = reopenedStore.loadDocument('board-1');
      assert.deepEqual([...afterRetry.getMap('board').entries()].sort(), expected);
      afterRetry.destroy();
      assert.deepEqual(
        reopened.prepare('SELECT sequence FROM board_updates WHERE id = ?').get('update-first'),
        { sequence: 3 },
      );

      reopenedStore.checkpointBoard('board-1');
      const beforeThird = Y.encodeStateVector(source);
      board.set('third', 'three');
      reopenedStore.persistUpdate({
        updateId: 'update-after-prune',
        boardId: 'board-1',
        originAccountId: 'account-1',
        bytes: Y.encodeStateAsUpdate(source, beforeThird),
      });
      assert.equal(reopened.prepare('SELECT sequence FROM board_updates WHERE id = ?').get('update-after-prune').sequence, 4);
      source.destroy();
    } finally {
      reopened.close();
    }
  } finally {
    source.destroy();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('checkpoint insertion and pruning roll back together on a storage failure', async () => {
  const fixture = await createFixture();
  const store = createBoardUpdateStore(fixture.db);
  const bytes = createYjsUpdate('atomic checkpoint');

  try {
    store.persistUpdate({ updateId: 'update-atomic', boardId: 'board-1', originAccountId: 'account-1', bytes });
    fixture.db.exec(`CREATE TRIGGER reject_update_pruning BEFORE DELETE ON board_updates
      BEGIN SELECT RAISE(ABORT, 'simulated pruning failure'); END`);

    assert.throws(() => store.checkpointBoard('board-1'), /simulated pruning failure/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_checkpoints').get().count, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 1);
    const stillRecoverable = store.loadDocument('board-1');
    assert.equal(stillRecoverable.getMap('board').get('title'), 'atomic checkpoint');
    stillRecoverable.destroy();

    fixture.db.exec('DROP TRIGGER reject_update_pruning');
    store.checkpointBoard('board-1');
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_checkpoints').get().count, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates').get().count, 0);
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('migration backfills monotonic per-board sequences and seeds the persistent cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-cursor-migration-'));
  const migrations = join(directory, 'legacy-migrations');
  const filename = join(directory, 'legacy.sqlite');
  await mkdir(migrations);
  const foundation = await readFile(new URL('../src/server/migrations/001-foundation.sql', import.meta.url), 'utf8');
  await writeFile(join(migrations, '001-foundation.sql'), foundation);

  const legacyDb = await openDatabase(filename, migrations);
  legacyDb.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run('legacy-account', 'legacy-member', 'not-used-by-test');
  legacyDb.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run('legacy-board', 'Legacy board');
  const insertLegacyUpdate = legacyDb.prepare(`
    INSERT INTO board_updates (id, board_id, origin_account_id, update_bytes, received_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertLegacyUpdate.run('legacy-1', 'legacy-board', 'legacy-account', Buffer.from([1]), '2026-01-01T00:00:00.000Z');
  insertLegacyUpdate.run('legacy-2', 'legacy-board', 'legacy-account', Buffer.from([2]), '2026-01-01T00:00:00.000Z');
  legacyDb.close();

  try {
    const migrated = await openDatabase(filename);
    try {
      assert.deepEqual(
        migrated.prepare('SELECT id, sequence FROM board_updates ORDER BY sequence').all(),
        [{ id: 'legacy-1', sequence: 1 }, { id: 'legacy-2', sequence: 2 }],
      );
      assert.equal(
        migrated.prepare('SELECT last_sequence FROM board_update_cursors WHERE board_id = ?').get('legacy-board').last_sequence,
        2,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
