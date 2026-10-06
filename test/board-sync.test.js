import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createAppServer, openDatabase } from '../src/server/main.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';

function messageReader(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index === -1) messages.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });

  return {
    next(predicate = () => true, timeoutMs = 2_000) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: null };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push(waiter);
      });
    },
  };
}

function connect(baseUrl, boardId, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/boards/${boardId}/sync`, {
      headers: { cookie },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function rejectedStatus(baseUrl, boardId, cookie) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/boards/${boardId}/sync`, {
      headers: cookie ? { cookie } : {},
    });
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('Expected the WebSocket upgrade to be rejected'));
    });
    ws.once('unexpected-response', (_request, response) => {
      if (settled) return;
      settled = true;
      resolve(response.statusCode);
      response.resume();
      ws.terminate();
    });
    ws.once('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function encode(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function decode(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function syncClient(ws, doc) {
  const reader = messageReader(ws);
  ws.send(JSON.stringify({ type: 'sync', stateVector: encode(Y.encodeStateVector(doc)) }));
  const response = await reader.next((message) => message.type === 'sync');
  Y.applyUpdate(doc, decode(response.update));

  const clientDiff = Y.encodeStateAsUpdate(doc, decode(response.stateVector));
  if (clientDiff.byteLength > 2) {
    const updateId = randomUUID();
    ws.send(JSON.stringify({ type: 'update', updateId, update: encode(clientDiff) }));
    const ack = await reader.next((message) => message.type === 'durable-ack' && message.updateId === updateId);
    assert.equal(ack.boardId.length > 0, true);
  }
  return reader;
}

function insertAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, cookie: `whiteboard_session=${token}` };
}

test('authorized members exchange updates, reject revoked recipients, and recover after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-board-sync-'));
  const dbPath = join(directory, 'sync.sqlite');
  let db = await openDatabase(dbPath);
  const alice = insertAccount(db, 'alice');
  const beatrice = insertAccount(db, 'beatrice');
  const charlie = insertAccount(db, 'charlie');
  const outsider = insertAccount(db, 'outsider');
  const lateJoiner = insertAccount(db, 'latejoiner');
  const boardA = randomUUID();
  const boardB = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardA, 'Board A');
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardB, 'Board B');
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  addMember.run(boardA, alice.accountId);
  addMember.run(boardA, beatrice.accountId);
  addMember.run(boardA, lateJoiner.accountId);
  addMember.run(boardB, charlie.accountId);

  const persistedUpdateIds = new Set();
  const syncEvents = [];
  const baseStore = createBoardUpdateStore(db);
  const updateStore = {
    ...baseStore,
    persistUpdate(input) {
      const ack = baseStore.persistUpdate(input);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE id = ?').get(input.updateId).count, 1);
      persistedUpdateIds.add(input.updateId);
      return ack;
    },
  };
  let server = await createAppServer({
    db,
    boardUpdateStore: updateStore,
    onSyncEvent: (type, detail) => syncEvents.push({ type, detail }),
  });
  const clients = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal(await rejectedStatus(baseUrl, boardA, outsider.cookie), 403);
    assert.equal(await rejectedStatus(baseUrl, boardA, null), 401);

    const aliceSocket = await connect(baseUrl, boardA, alice.cookie);
    const beatriceSocket = await connect(baseUrl, boardA, beatrice.cookie);
    const charlieSocket = await connect(baseUrl, boardB, charlie.cookie);
    clients.push(aliceSocket, beatriceSocket, charlieSocket);
    const aliceDoc = new Y.Doc();
    const beatriceDoc = new Y.Doc();
    const charlieDoc = new Y.Doc();
    const aliceReader = await syncClient(aliceSocket, aliceDoc);
    const beatriceReader = await syncClient(beatriceSocket, beatriceDoc);
    const charlieReader = await syncClient(charlieSocket, charlieDoc);

    aliceDoc.getMap('board').set('element', { label: 'shared edit' });
    const updateId = randomUUID();
    const emptyDoc = new Y.Doc();
    const serverVector = Y.encodeStateVector(emptyDoc);
    emptyDoc.destroy();
    const diff = Y.encodeStateAsUpdate(aliceDoc, serverVector);
    aliceSocket.send(JSON.stringify({ type: 'update', updateId, update: encode(diff) }));

    const ack = await aliceReader.next((message) => message.type === 'durable-ack' && message.updateId === updateId);
    assert.equal(persistedUpdateIds.has(updateId), true, 'the store must commit before the server emits its ACK');
    assert.equal(ack.boardId, boardA);
    assert.match(ack.actionId, /^sha256:[0-9a-f]{64}$/);
    const receivedEvent = syncEvents.find(({ type, detail }) => type === 'server-received' && detail.updateId === updateId);
    const persistedEvent = syncEvents.find(({ type, detail }) => type === 'durable-persisted' && detail.updateId === updateId);
    assert.ok(receivedEvent);
    assert.ok(persistedEvent);
    assert.equal(receivedEvent.detail.actionId, ack.actionId);
    assert.equal(persistedEvent.detail.actionId, ack.actionId);
    assert.ok(receivedEvent.detail.sequence < persistedEvent.detail.sequence);
    assert.equal(Object.hasOwn(persistedEvent.detail, 'bytes'), false, 'diagnostics must not expose update bytes');
    const broadcast = await beatriceReader.next((message) => message.type === 'update' && message.updateId === updateId);
    Y.applyUpdate(beatriceDoc, decode(broadcast.update));
    assert.deepEqual(beatriceDoc.getMap('board').get('element'), { label: 'shared edit' });
    await assert.rejects(
      charlieReader.next((message) => message.type === 'update', 100),
      /Timed out waiting for WebSocket message/,
    );

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardA).count, 1);
    const stored = createBoardUpdateStore(db).loadDocument(boardA);
    assert.deepEqual(stored.getMap('board').get('element'), { label: 'shared edit' });
    stored.destroy();

    const invalidId = randomUUID();
    aliceSocket.send(JSON.stringify({ type: 'update', updateId: invalidId, update: encode(new Uint8Array([1])) }));
    const invalidResponse = await aliceReader.next((message) => message.type === 'error');
    assert.equal(invalidResponse.code, 'INVALID_MESSAGE');
    assert.equal(persistedUpdateIds.has(invalidId), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardA).count, 1);

    const lateJoinSocket = await connect(baseUrl, boardA, lateJoiner.cookie);
    clients.push(lateJoinSocket);
    const lateJoinDoc = new Y.Doc();
    await syncClient(lateJoinSocket, lateJoinDoc);
    assert.deepEqual(lateJoinDoc.getMap('board').get('element'), { label: 'shared edit' });

    db.prepare('DELETE FROM memberships WHERE board_id = ? AND account_id = ?').run(boardA, beatrice.accountId);
    const revokedClose = once(beatriceSocket, 'close');
    aliceDoc.getMap('board').set('second', 'still shared only with authorized members');
    const secondUpdateId = randomUUID();
    aliceSocket.send(JSON.stringify({
      type: 'update',
      updateId: secondUpdateId,
      update: encode(Y.encodeStateAsUpdate(aliceDoc, serverVector)),
    }));
    await aliceReader.next((message) => message.type === 'durable-ack' && message.updateId === secondUpdateId);
    const [closeCode] = await revokedClose;
    assert.equal(closeCode, 1008);
    await assert.rejects(
      beatriceReader.next((message) => message.type === 'update' && message.updateId === secondUpdateId, 100),
      /Timed out waiting for WebSocket message/,
    );

    aliceDoc.destroy();
    beatriceDoc.destroy();
    charlieDoc.destroy();
    lateJoinDoc.destroy();

    for (const client of clients) client.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server = null;
    db.close();

    db = await openDatabase(dbPath);
    server = await createAppServer({ db });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const restartedUrl = `http://127.0.0.1:${server.address().port}`;
    const restartedSocket = await connect(restartedUrl, boardA, lateJoiner.cookie);
    clients.push(restartedSocket);
    const restartedDoc = new Y.Doc();
    await syncClient(restartedSocket, restartedDoc);
    assert.deepEqual(restartedDoc.getMap('board').get('element'), { label: 'shared edit' });
    assert.equal(restartedDoc.getMap('board').get('second'), 'still shared only with authorized members');
    restartedDoc.destroy();
  } finally {
    for (const client of clients) client.terminate();
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
