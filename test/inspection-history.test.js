import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { addElement, readBoardElements } from '../src/shared/board-model.js';
import { diffInspectionSnapshots } from '../src/public/inspection-diff.js';
import { createInspectionHistoryStore } from '../src/server/inspection-history-store.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)').run(accountId, username, 'history-test');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, cookie: `whiteboard_session=${token}` };
}

function reader(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (bytes) => {
    const value = JSON.parse(bytes.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index < 0) queue.push(value); else waiters.splice(index, 1)[0].resolve(value);
  });
  return { next(predicate, timeout = 3000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null };
      const timer = setTimeout(() => reject(new Error('history websocket response timed out')), timeout);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      waiters.push(waiter);
    });
  } };
}

function connect(url, boardId, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http/, 'ws') + `/api/boards/${boardId}/replicas`, { headers: { cookie } });
    socket.once('open', () => resolve({ socket, reader: reader(socket) }));
    socket.once('error', reject);
  });
}

test('inspection history has independent per-board retention, paging and visual ID diff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-inspection-history-store-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'History retention');
  const history = createInspectionHistoryStore(db);
  try {
    for (let index = 0; index < 300; index += 1) {
      history.recordSnapshot(boardId, index % 2 ? 'peer:a' : 'vps', [{ id: `shape-${index}`, type: 'rect', geometry: { x: index, y: 0 }, style: {}, data: {} }]);
      history.recordEvent(boardId, 'peer:a', { type: 'local-edit', sequence: index + 1, observedAt: `clock-${index}` });
    }
    const snapshots = history.listSnapshots(boardId, { limit: 50 });
    const events = history.listEvents(boardId, { limit: 25 });
    assert.equal(snapshots.length, 32);
    assert.equal(new Set(snapshots.map((snapshot) => snapshot.replicaId)).size, 2, 'the newest row for each replica survives pruning');
    assert.equal(events.length, 25);
    assert.equal(events[0].event.sequence, 300);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inspection_events WHERE board_id=?').get(boardId).count, 256);
    assert.equal(history.listEvents(boardId, { before: events.at(-1).id, limit: 25 }).length, 25);
    const largeBoard = randomUUID();
    db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(largeBoard, 'Byte bounded');
    const largeElements = [{ id: 'large', type: 'text', geometry: { x: 0, y: 0 }, style: {}, data: { text: 'x'.repeat(900_000) } }];
    for (let index = 0; index < 19; index += 1) history.recordSnapshot(largeBoard, 'peer:large', largeElements);
    assert.equal(history.recordSnapshot(largeBoard, 'peer:large', [{ ...largeElements[0], data: { text: 'x'.repeat(1_100_000) } }]), null,
      'individual projections over 1 MiB are rejected');
    const largeTotals = db.prepare('SELECT COUNT(*) AS count, SUM(byte_length) AS bytes FROM inspection_snapshots WHERE board_id=?').get(largeBoard);
    assert.ok(largeTotals.bytes <= 16 * 1024 * 1024);
    assert.ok(largeTotals.count <= 32);
    const otherBoard = randomUUID();
    db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(otherBoard, 'No history');
    assert.deepEqual(history.listSnapshots(otherBoard), []);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }

  const diff = diffInspectionSnapshots(
    [{ id: 'keep', type: 'rect', geometry: { x: 0 }, style: {}, data: {} }, { id: 'remove', type: 'text', geometry: {}, style: {}, data: {} }],
    [{ id: 'keep', type: 'rect', geometry: { x: 5 }, style: {}, data: {} }, { id: 'add', type: 'arrow', geometry: {}, style: {}, data: {} }],
  );
  assert.deepEqual(diff.added.map((item) => item.id), ['add']);
  assert.deepEqual(diff.removed.map((item) => item.id), ['remove']);
  assert.equal(diff.changed[0].id, 'keep');
});

test('authorized history queries are board scoped and pruning does not affect late Yjs recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-inspection-history-api-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const member = addAccount(db, 'historymember');
  const outsider = addAccount(db, 'historyoutsider');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Late join remains durable');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, member.accountId);
  const updates = createBoardUpdateStore(db);
  const original = new Y.Doc();
  addElement(original, { id: 'durable-after-prune', type: 'rect', geometry: { x: 14, y: 20, width: 40, height: 30 }, style: { color: '#123456' } });
  updates.persistUpdate({ boardId, updateId: randomUUID(), originAccountId: member.accountId, bytes: Y.encodeStateAsUpdate(original) });
  original.destroy();
  const history = createInspectionHistoryStore(db);
  for (let index = 0; index < 40; index += 1) history.recordSnapshot(boardId, 'peer:retained', [{ id: `preview-${index}`, type: 'rect', geometry: { x: index, y: 0, width: 1, height: 1 }, style: {}, data: {} }]);

  const server = await createAppServer({ db, boardUpdateStore: updates });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let socket;
  let secondSocket;
  try {
    await assert.rejects(connect(url, boardId, outsider.cookie));
    const opened = await connect(url, boardId, member.cookie);
    socket = opened.socket;
    const { reader: read } = opened;
    await read.next((message) => message.type === 'welcome');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inspection_snapshots WHERE board_id=? AND replica_id='vps'").get(boardId).count, 1,
      'the initial VPS projection is captured once');
    const second = await connect(url, boardId, member.cookie);
    secondSocket = second.socket;
    await second.reader.next((message) => message.type === 'welcome');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inspection_snapshots WHERE board_id=? AND replica_id='vps'").get(boardId).count, 1,
      'a second observer does not create a duplicate VPS snapshot');
    assert.equal(server.replicaDiagnostics.publishServerEvent(boardId, 'durable-persisted', {
      replicaId: 'vps:process-test', sequence: 77, observedAt: 'vps-clock:77', updateBytes: 29,
    }), true);
    const serverEvent = await read.next((message) => message.type === 'event' && message.event.sequence === 77);
    assert.equal(serverEvent.replicaId, 'vps:process-test');
    assert.equal(serverEvent.event.observedAt, 'vps-clock:77');
    socket.send(JSON.stringify({ type: 'history-list', kind: 'snapshots', requestId: 'list-1', limit: 5, replicaId: 'peer:retained' }));
    const page = await read.next((message) => message.type === 'history-page' && message.requestId === 'list-1');
    assert.equal(page.rows.length, 5);
    socket.send(JSON.stringify({ type: 'history-snapshot', requestId: 'snapshot-1', snapshotId: page.rows[0].id }));
    const historic = await read.next((message) => message.type === 'history-snapshot' && message.requestId === 'snapshot-1');
    assert.ok(historic.snapshot.elements[0].id.startsWith('preview-'));

    const lateJoin = new Y.Doc();
    const syncSocket = new WebSocket(url.replace(/^http/, 'ws') + `/api/boards/${boardId}/sync`, { headers: { cookie: member.cookie } });
    await once(syncSocket, 'open');
    const syncResponse = new Promise((resolve) => syncSocket.once('message', (bytes) => resolve(JSON.parse(bytes.toString()))));
    syncSocket.send(JSON.stringify({ type: 'sync', stateVector: Buffer.from(Y.encodeStateVector(lateJoin)).toString('base64') }));
    const sync = await syncResponse;
    Y.applyUpdate(lateJoin, Buffer.from(sync.update, 'base64'));
    assert.deepEqual(readBoardElements(lateJoin).map(({ id }) => id), ['durable-after-prune']);
    const syncClosed = once(syncSocket, 'close');
    syncSocket.close(1000, 'test complete');
    await syncClosed;
    lateJoin.destroy();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id=?').get(boardId).count, 1,
      'inspection retention never prunes operational recovery updates');
    db.prepare('DELETE FROM memberships WHERE board_id=? AND account_id=?').run(boardId, member.accountId);
    socket.send(JSON.stringify({ type: 'history-list', kind: 'events', requestId: 'after-revoke' }));
    const [closeCode] = await once(socket, 'close');
    assert.equal(closeCode, 1008, 'membership is rechecked on each history request after websocket authorization');
  } finally {
    for (const active of [socket, secondSocket].filter((item) => item && item.readyState !== WebSocket.CLOSED)) {
      const closed = once(active, 'close'); active.terminate(); await closed;
    }
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
