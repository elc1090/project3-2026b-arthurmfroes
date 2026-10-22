import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { persistenceFixture } from './fixtures/room-persistence-server.js';
import { createPersistenceTraceStore } from '../src/server/persistence-trace-store.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { openDatabase } from '../src/server/main.js';
const event = (boardId, sequence = 1, changes = {}) => ({ version: 1, eventId: `event-${sequence}`, boardId, traceSessionId: 'tab-1', docClientId: '100', sequence, type: 'candidate-drawn', observedAt: '2026-10-22T10:00:00Z', monotonicMs: sequence, data: { candidate: { id: '100', token: `generation-${sequence}`, priority: sequence, eligible: true, reason: 'initial' } }, ...changes });

test('trace store retains bounded diagnostic records, survives restart and deduplicates even after pruning', async () => {
  const f = await persistenceFixture();
  try {
    const actor = { key: f.users[0].id, accountId: f.users[0].id, username: 'member0', source: 'client' };
    let store = createPersistenceTraceStore(f.db, { serverEvents: 2, serverBytes: 8192 });
    for (let i = 1; i <= 4; i++) store.append(f.boardId, actor, [event(f.boardId, i)]);
    let page = store.list(f.boardId);
    assert.equal(page.rows.length, 2); assert.equal(page.dropped, 2); assert.ok(page.prunedThrough > 0);
    const retry = store.append(f.boardId, actor, [event(f.boardId, 1)]); assert.deepEqual(retry.expired, ['event-1']);
    store.append(f.boardId, actor, [event(f.boardId, 4)]); assert.equal(store.list(f.boardId).rows.length, 2);
    assert.throws(() => store.append(f.boardId, actor, [event(f.boardId, 4, { monotonicMs: 999 })]), /Conflicting/);
    assert.equal(store.list(f.boardId, { before: page.rows[0].id }).rows[0].event.sequence, 3);
    assert.equal(store.list('unknown-board').rows.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM board_updates').get().n, 0);
    createBoardUpdateStore(f.db).checkpointBoard(f.boardId);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM persistence_trace_events').get().n, 2);
    const other = await openDatabase(`${f.directory}/board.sqlite`);
    store = createPersistenceTraceStore(other); assert.equal(store.list(f.boardId).rows.length, 2); other.close();
    store = createPersistenceTraceStore(f.db, { serverEvents: 100, serverBytes: 600 });
    store.append(f.boardId, actor, [event(f.boardId, 5)]); assert.ok(store.list(f.boardId).totals.bytes <= 600);
  } finally { await f.close(); }
});

test('trace API binds the authenticated actor, validates payloads and isolates members and boards', async () => {
  const f = await persistenceFixture(); const url = `${f.baseUrl}/api/boards/${f.boardId}/persistence-trace`;
  const send = (events, user = f.users[0]) => f.request({ events }, user, url);
  try {
    assert.equal((await f.request(null, null, url)).status, 401);
    assert.equal((await f.request(null, f.users[2], url)).status, 403);
    const e = event(f.boardId); assert.equal((await send([e])).status, 200);
    assert.equal((await send([e])).status, 200);
    const data = await (await f.request(null, f.users[0], url)).json();
    assert.equal(data.rows.length, 1); assert.equal(data.rows[0].username, 'member0'); assert.equal(data.rows[0].source, 'client');
    assert.equal((await send([{ ...e, username: 'member1' }])).status, 400);
    assert.equal((await send([{ ...e, type: 'server-committed' }])).status, 400);
    assert.equal((await send([{ ...e, boardId: 'other' }])).status, 400);
    assert.equal((await send([{ ...e, data: { update: 'secret-content' } }])).status, 400);
    assert.equal((await send(Array.from({ length: 33 }, (_, i) => event(f.boardId, i)))).status, 400);
    const oversized = await send(Array(30).fill({ ...e, data: { reason: 'x'.repeat(3000) } }));
    assert.equal(oversized.status, 413);
    const batchId = randomUUID();
    const actor = { key: f.users[0].id, accountId: f.users[0].id, username: 'member0', source: 'client' };
    createPersistenceTraceStore(f.db).append(f.boardId, actor, [event(f.boardId, 2, { electionViewId: 'view', type: 'election-view', data: { candidates: [], representative: null } }), event(f.boardId, 3, { batchId, electionViewId: 'view', attemptId: 'attempt', type: 'batch-send', data: {} })]);
    const detail = await (await f.request(null, f.users[0], `${url}?batchId=${batchId}`)).json();
    assert.equal(detail.detail.length, 2); assert.equal(detail.detail.some((r) => r.event.type === 'election-view'), true);
    const streamed = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ events: [event(f.boardId, 6)] });
      const req = httpRequest(url, { method: 'POST', headers: { cookie: `whiteboard_session=${f.users[0].token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write(body.slice(0, 5));
      setTimeout(() => { f.db.prepare('DELETE FROM memberships WHERE board_id = ? AND account_id = ?').run(f.boardId, f.users[0].id); req.end(body.slice(5)); }, 20);
    });
    assert.equal(streamed, 403);
  } finally { await f.close(); }
});

test('lost ACK retry deduplicates content; legacy requests and failed diagnostic storage still commit', async () => {
  const Y = await import('yjs'); const { encodeBytes } = await import('../src/shared/persistence-coverage.js');
  const f = await persistenceFixture(); const doc = new Y.Doc();
  try {
    doc.getMap('board').set('value', 1);
    const batchId = randomUUID(); const body = { batchId, update: encodeBytes(Y.encodeStateAsUpdate(doc)), trace: { attemptId: 'attempt-1', electionViewId: 'view-1', traceSessionId: 'tab', docClientId: String(doc.clientID) } };
    const first = await f.request(body); assert.equal(first.status, 200); await first.arrayBuffer();
    // Discard the response at the application, then retry exactly the same content.
    const retry = await f.request({ ...body, trace: { ...body.trace, attemptId: 'attempt-2' } });
    assert.equal(retry.status, 200); await retry.arrayBuffer();
    const rows = createPersistenceTraceStore(f.db).batchDetails(f.boardId, batchId);
    assert.equal(rows.filter((r) => r.event.type === 'server-committed').length, 2);
    assert.deepEqual(rows.filter((r) => r.event.type === 'server-committed').map((r) => r.event.data.deduplicated), [false, true]);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM board_updates').get().n, 1);
    f.db.exec('DROP TABLE persistence_trace_events');
    doc.getMap('board').set('value', 2);
    const legacy = await f.request({ batchId: randomUUID(), update: encodeBytes(Y.encodeStateAsUpdate(doc)) });
    assert.equal(legacy.status, 200); assert.ok((await legacy.json()).receipt.signature);
    const recovered = createBoardUpdateStore(f.db).loadDocument(f.boardId);
    assert.equal(recovered.getMap('board').get('value'), 2); recovered.destroy();
  } finally { doc.destroy(); await f.close(); }
});

test('interrupted response records commit without pretending the ACK was emitted or received', async () => {
  const { Readable } = await import('node:stream'); const { EventEmitter } = await import('node:events');
  const Y = await import('yjs'); const { encodeBytes } = await import('../src/shared/persistence-coverage.js');
  const { createRoomPersistenceHandler } = await import('../src/server/room-persistence.js');
  const f = await persistenceFixture(); const doc = new Y.Doc();
  try {
    doc.getMap('board').set('interrupted', true);
    const body = { batchId: randomUUID(), update: encodeBytes(Y.encodeStateAsUpdate(doc)), trace: { attemptId: 'interrupted' } };
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = `/api/boards/${f.boardId}/persistence`; req.method = 'POST'; req.headers = { cookie: `whiteboard_session=${f.users[0].token}` };
    const res = new EventEmitter(); res.writeHead = (status) => { res.status = status; }; res.end = () => res.emit('close');
    const trace = createPersistenceTraceStore(f.db);
    const handler = createRoomPersistenceHandler(f.db, createBoardUpdateStore(f.db), undefined, undefined, trace);
    await handler(req, res); assert.equal(res.status, 200);
    assert.deepEqual(trace.batchDetails(f.boardId, body.batchId).map((r) => r.event.type), ['server-received', 'server-committed']);
    const retry = await f.request(body); assert.equal(retry.status, 200); await retry.text();
    assert.equal(trace.batchDetails(f.boardId, body.batchId).filter((r) => r.event.type === 'server-committed').at(-1).event.data.deduplicated, true);
    const oldId = randomUUID(); await (await f.request({ batchId: oldId, update: body.update })).text();
    f.db.prepare('DELETE FROM persistence_trace_events WHERE batch_id = ?').run(oldId);
    assert.ok(trace.knownBatches(f.boardId).some((b) => b.batchId === oldId)); assert.equal(trace.batchDetails(f.boardId, oldId).length, 0);
  } finally { doc.destroy(); await f.close(); }
});
