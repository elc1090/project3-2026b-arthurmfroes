import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { addElement } from '../src/shared/board-model.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'replica-diagnostics-test');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, cookie: 'whiteboard_session=' + token };
}

function messageReader(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) messages.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  return {
    next(predicate = () => true, timeoutMs = 2_000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: null };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for diagnostic message'));
        }, timeoutMs);
        waiter.resolve = (message) => { clearTimeout(timer); resolve(message); };
        waiters.push(waiter);
      });
    },
  };
}

function connect(baseUrl, boardId, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/api/boards/' + boardId + '/replicas', {
      headers: cookie ? { cookie } : {},
    });
    const reader = messageReader(socket);
    socket.once('open', () => resolve({ socket, reader }));
    socket.once('error', reject);
  });
}

function rejectedStatus(baseUrl, boardId, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/api/boards/' + boardId + '/replicas', {
      headers: cookie ? { cookie } : {},
    });
    socket.once('open', () => { socket.terminate(); reject(new Error('Expected diagnostics upgrade rejection')); });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      response.resume();
      socket.terminate();
    });
    socket.once('error', reject);
  });
}

test('replica diagnostics are authorized projections separate from persisted board updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-replica-diagnostics-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const member = addAccount(db, 'replicamember');
  const outsider = addAccount(db, 'replicaoutsider');
  const boardId = randomUUID();
  const otherBoardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Diagnostic projections');
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(otherBoardId, 'Isolated diagnostic board');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, member.accountId);
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(otherBoardId, member.accountId);

  const store = createBoardUpdateStore(db);
  const durableDoc = new Y.Doc();
  addElement(durableDoc, {
    id: 'durable-shape',
    type: 'rect',
    geometry: { x: 15, y: 25, width: 40, height: 30 },
    style: { color: '#1e293b', strokeWidth: 2 },
  });
  store.persistUpdate({
    updateId: randomUUID(),
    boardId,
    originAccountId: member.accountId,
    bytes: Y.encodeStateAsUpdate(durableDoc),
  });
  durableDoc.destroy();

  const server = await createAppServer({ db, boardUpdateStore: store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let socket;
  let observer;
  let isolatedSocket;
  try {
    assert.equal(await rejectedStatus(baseUrl, boardId, outsider.cookie), 403);
    assert.equal(await rejectedStatus(baseUrl, boardId, null), 401);

    const connected = await connect(baseUrl, boardId, member.cookie);
    socket = connected.socket;
    const { reader } = connected;
    const welcome = await reader.next((message) => message.type === 'welcome');
    assert.match(welcome.replicaId, /^peer:/);
    const initial = await reader.next((message) => message.type === 'replicas');
    assert.equal(initial.projectionOnly, true);
    assert.equal(initial.vps.replicaId, 'vps');
    assert.equal(initial.vps.elements.length, 1, 'the server preview is reconstructed from the committed store');
    assert.deepEqual(initial.peers[0].elements, []);

    const observerConnection = await connect(baseUrl, boardId, member.cookie);
    observer = observerConnection.socket;
    const observerReader = observerConnection.reader;
    await observerReader.next((message) => message.type === 'welcome');
    await observerReader.next((message) => message.type === 'replicas');
    const isolatedConnection = await connect(baseUrl, otherBoardId, member.cookie);
    isolatedSocket = isolatedConnection.socket;
    const isolatedInitial = await isolatedConnection.reader.next((message) => message.type === 'replicas');
    assert.equal(isolatedInitial.vps.elements.length, 0);
    assert.equal(isolatedInitial.peers.length, 1);

    socket.send(JSON.stringify({
      type: 'snapshot',
      elements: [{ id: 'peer-shape', type: 'rect', geometry: { x: 100, y: 80, width: 60, height: 35 }, style: { color: '#dc2626' }, data: {} }],
    }));
    const projected = await reader.next((message) => message.type === 'replicas' && message.peers.some((peer) =>
      peer.replicaId === welcome.replicaId && peer.elements.some((element) => element.id === 'peer-shape')));
    assert.equal(projected.vps.elements.some((element) => element.id === 'peer-shape'), false);
    assert.equal(isolatedInitial.peers.some((peer) => peer.elements.some((element) => element.id === 'peer-shape')), false,
      'a diagnostic snapshot is restricted to its board room');
    const checkDurable = store.loadDocument(boardId);
    try {
      assert.equal(checkDurable.getMap('elements').has('peer-shape'), false,
        'a diagnostic projection never enters the durable Y.Doc');
    } finally { checkDurable.destroy(); }

    assert.equal(server.replicaDiagnostics.publishServerEvent(boardId, 'durable-persisted', {
      actionId: 'sha256:example', updateBytes: 42, sequence: 9, observedAt: '2026-10-06T12:00:00.000Z', sourcePath: 'sqlite',
    }), true);
    const event = await reader.next((message) => message.type === 'event');
    assert.equal(event.replicaId, 'vps');
    assert.equal(event.event.type, 'durable-persisted');
    assert.equal(event.event.updateBytes, 42);
    assert.equal(event.event.sequence, 9);
    assert.equal(event.event.observedAt, '2026-10-06T12:00:00.000Z');
    assert.equal(Object.hasOwn(event.event, 'update'), false, 'the diagnostic event carries metadata, not Yjs update bytes');

    socket.send(JSON.stringify({ type: 'event', event: { type: 'update-observed', actionId: 'sha256:peer', updateBytes: 57 } }));
    const peerEvent = await observerReader.next((message) => message.type === 'event' && message.replicaId === welcome.replicaId);
    assert.equal(peerEvent.event.updateBytes, 57, 'updateBytes is permitted as size metadata on diagnostic events');

    socket.send(JSON.stringify({
      type: 'snapshot',
      elements: [{ id: 'malformed', type: 'rect', geometry: { x: 'not-a-number', y: 0, width: 2, height: 2 }, style: {}, data: {} }],
    }));
    const [invalidProjectionClose] = await once(socket, 'close');
    assert.equal(invalidProjectionClose, 1008, 'malformed geometry is rejected before other previews can render it');
    const afterMalformed = await observerReader.next((message) => message.type === 'replicas');
    assert.equal(afterMalformed.peers.some((peer) => peer.elements.some((element) => element.id === 'malformed')), false);

    db.prepare('DELETE FROM memberships WHERE board_id = ? AND account_id = ?').run(boardId, member.accountId);
    const [closeCode] = await once(observer, 'close');
    assert.equal(closeCode, 1008, 'the periodic recheck closes an idle diagnostic connection after revocation');
  } finally {
    const activeSockets = [socket, observer, isolatedSocket].filter((item) => item && item.readyState !== WebSocket.CLOSED);
    const closed = activeSockets.map((item) => once(item, 'close'));
    for (const item of activeSockets) item.terminate();
    await Promise.all(closed);
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
