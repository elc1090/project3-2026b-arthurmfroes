import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openOfflineBoard } from '../src/client/offline-board.js';

test('a board document restores an edit when its tab closes immediately after the edit', async () => {
  const boardId = `offline-${randomUUID()}`;
  let session = openOfflineBoard(boardId);

  try {
    await session.ready;
    session.doc.getMap('offline').set('edit', 'made without network');
    const closing = session.destroy();
    assert.equal(session.destroy(), closing);
    await closing;

    session = openOfflineBoard(boardId);
    await session.ready;
    assert.equal(session.doc.getMap('offline').get('edit'), 'made without network');
  } finally {
    await session.destroy();
  }
});

test('local persistence is isolated by board ID', async () => {
  const firstBoardId = `board-a-${randomUUID()}`;
  const secondBoardId = `board-b-${randomUUID()}`;
  const firstBoard = openOfflineBoard(firstBoardId);
  const secondBoard = openOfflineBoard(secondBoardId);

  try {
    await Promise.all([firstBoard.ready, secondBoard.ready]);
    firstBoard.doc.getMap('offline').set('value', 'only on A');
    secondBoard.doc.getMap('offline').set('value', 'only on B');
    await Promise.all([firstBoard.destroy(), secondBoard.destroy()]);

    const reopenedFirst = openOfflineBoard(firstBoardId);
    const reopenedSecond = openOfflineBoard(secondBoardId);
    try {
      await Promise.all([reopenedFirst.ready, reopenedSecond.ready]);
      assert.equal(reopenedFirst.doc.getMap('offline').get('value'), 'only on A');
      assert.equal(reopenedSecond.doc.getMap('offline').get('value'), 'only on B');
    } finally {
      await Promise.all([reopenedFirst.destroy(), reopenedSecond.destroy()]);
    }
  } finally {
    await Promise.all([firstBoard.destroy(), secondBoard.destroy()]);
  }
});

test('empty board IDs are rejected before opening IndexedDB', () => {
  assert.throws(() => openOfflineBoard(''), /boardId must be a non-empty string/);
});
