import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
