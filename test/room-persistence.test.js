import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import * as Y from 'yjs';
import { createAppServer, openDatabase } from '../src/server/main.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { coversUpdate, documentCoverage, encodeBytes, verifyReceipt } from '../src/shared/persistence-coverage.js';

import { persistenceFixture } from './fixtures/room-persistence-server.js';

test('coverage requires both structures and deletions and excludes later edits', () => {
  const doc = new Y.Doc(); const updates = []; doc.on('update', (bytes) => updates.push(bytes));
  doc.getMap('board').set('x', 1);
  const first = documentCoverage(doc);
  doc.getMap('board').delete('x');
  assert.equal(coversUpdate(first, updates[1]), false, 'a vector cannot confirm a later delete');
  const deleted = documentCoverage(doc);
  assert.equal(coversUpdate(deleted, updates[1]), true);
  doc.getMap('board').set('y', 2);
  assert.equal(coversUpdate(deleted, updates[2]), false);
  doc.destroy();
});

test('authenticated batches commit, verify receipts, reject tampering and deduplicate across checkpoint and members', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc();
  try {
    assert.equal((await f.request(null, null)).status, 401);
    assert.equal((await f.request(null, f.users[2])).status, 403);
    doc.getMap('board').set('x', 'durable');
    const bytes = Y.encodeStateAsUpdate(doc);
    const body = { batchId: randomUUID(), update: encodeBytes(bytes) };
    const response = await f.request(body); assert.equal(response.status, 200);
    const data = await response.json();
    const key = await crypto.subtle.importKey('jwk', data.key, 'Ed25519', false, ['verify']);
    assert.equal(await verifyReceipt(data.receipt, key, f.boardId), true);
    assert.equal(coversUpdate(data.receipt.payload.coverage, bytes), true);
    assert.equal(await verifyReceipt(data.receipt, key, 'other-board'), false);
    const forged = structuredClone(data.receipt); forged.payload.coverage.vector[doc.clientID] = 999;
    assert.equal(await verifyReceipt(forged, key, f.boardId), false);
    const store = createBoardUpdateStore(f.db); store.checkpointBoard(f.boardId);
    const retry = await f.request(body, f.users[1]); assert.equal(retry.status, 200);
    assert.equal((await retry.json()).receipt.payload.committedAt, data.receipt.payload.committedAt);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM board_updates').get().n, 0);
    doc.getMap('board').set('x', 'changed');
    assert.equal((await f.request({ ...body, update: encodeBytes(Y.encodeStateAsUpdate(doc)) })).status, 409);
    const recovered = store.loadDocument(f.boardId); assert.equal(recovered.getMap('board').get('x'), 'durable'); recovered.destroy();
    assert.equal((await f.request({ batchId: randomUUID(), update: 'bad!' })).status, 400);
    assert.equal((await f.request({ batchId: randomUUID(), update: encodeBytes(new Uint8Array([255])) })).status, 400);
    f.db.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON board_updates BEGIN SELECT RAISE(ABORT, 'fail'); END");
    const fail = await f.request({ batchId: randomUUID(), update: encodeBytes(Y.encodeStateAsUpdate(doc)) });
    assert.equal(fail.status, 400); assert.equal((await fail.json()).receipt, undefined);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM persistence_batches').get().n, 1);
  } finally { doc.destroy(); await f.close(); }
});


test('membership revoked during a streaming upload cannot commit a batch', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc();
  try {
    doc.getMap('board').set('mustNotPersist', true);
    const body = JSON.stringify({ batchId: randomUUID(), update: encodeBytes(Y.encodeStateAsUpdate(doc)) });
    const result = new Promise((resolve, reject) => {
      const request = httpRequest(f.url, { method: 'POST', headers: { cookie: `whiteboard_session=${f.users[0].token}`, 'content-type': 'application/json' } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.write(body.slice(0, 10));
      setTimeout(() => {
        f.db.prepare('DELETE FROM memberships WHERE board_id = ? AND account_id = ?').run(f.boardId, f.users[0].id);
        request.end(body.slice(10));
      }, 30);
    });
    assert.equal(await result, 403);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM board_updates').get().n, 0);
  } finally { doc.destroy(); await f.close(); }
});
