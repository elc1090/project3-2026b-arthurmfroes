import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { openPersistenceTraceQueue } from '../src/client/persistence-trace-queue.js';
import { createPersistenceTrace } from '../src/client/persistence-trace.js';
import { createRoomPersistence } from '../src/client/room-persistence.js';
import { createSyncExperimentMetrics } from '../src/client/sync-experiment.js';
import { persistenceFixture } from './fixtures/room-persistence-server.js';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, ms = 3000) { const start = Date.now(); while (Date.now() - start < ms) { if (await fn()) return; await wait(5); } assert.fail(message); }
const sample = (sequence) => ({ version: 1, eventId: `e-${sequence}`, boardId: 'board', traceSessionId: 'tab', docClientId: '100', sequence, type: 'trace-gap', observedAt: new Date().toISOString(), monotonicMs: sequence, data: { dropped: 1, reason: 'test' } });

test('local trace queue survives reopening, is account scoped, bounds count and bytes and confirms only collected IDs', async () => {
  const indexedDB = new IDBFactory(); const opts = { indexedDB, limits: { localEvents: 2, localBytes: 10000 } };
  let q = openPersistenceTraceQueue('alice', 'board', opts);
  await q.append(sample(1)); await q.append(sample(2)); await q.append(sample(3));
  assert.equal((await q.read()).dropped, 1); await q.close();
  q = openPersistenceTraceQueue('alice', 'board', opts);
  assert.deepEqual((await q.read()).events.map((e) => e.sequence), [2, 3]);
  await q.acknowledge(['e-2']); assert.deepEqual((await q.read()).events.map((e) => e.sequence), [3]);
  const other = openPersistenceTraceQueue('bob', 'board', opts); assert.equal((await other.read()).pending, 0); await other.close(); await q.close();
  const tiny = openPersistenceTraceQueue('alice', 'tiny', { indexedDB, limits: { localBytes: 100 } });
  await tiny.append(sample(1)); assert.equal((await tiny.read()).pending, 0); assert.equal((await tiny.read()).dropped, 1); await tiny.close();
});

test('collector retries offline reports after reopen, separates traffic and stops on revocation/destruction', async () => {
  const indexedDB = new IDBFactory(); let offline = true; const submitted = []; const metrics = createSyncExperimentMetrics();
  const fetchImpl = async (_url, init) => {
    if (offline) throw new Error('offline');
    const events = JSON.parse(init.body).events; submitted.push(...events);
    return new Response(JSON.stringify({ accepted: events.map((e) => e.eventId), expired: [] }));
  };
  let trace = createPersistenceTrace('board', '100', { accountId: 'alice', username: 'Alice', locationHref: 'http://localhost', fetchImpl, metrics, intervalMs: 10000, queueOptions: { indexedDB } });
  trace.record('candidate-drawn', { data: { candidate: { id: '100', token: 'token', priority: 1, eligible: true, reason: 'initial' } } });
  await trace.flush(); assert.equal(trace.status.available, false); await trace.destroy();
  offline = false;
  trace = createPersistenceTrace('board', '101', { accountId: 'alice', locationHref: 'http://localhost', fetchImpl, metrics, intervalMs: 10000, queueOptions: { indexedDB } });
  await trace.flush({ reconnect: true });
  assert.equal(submitted.length, 1); assert.equal(trace.status.pending, 0);
  assert.ok(metrics.snapshot().diagnostic.sent.bytes > 0); assert.equal(metrics.snapshot().http.sent.updateMessages, 0);
  await trace.flush(); assert.equal(submitted.length, 1, 'no empty heartbeat submission'); await trace.destroy();
  let deniedCalls = 0;
  trace = createPersistenceTrace('board', '102', { accountId: 'alice', locationHref: 'http://localhost', fetchImpl: async () => { deniedCalls++; return new Response('{}', { status: 403 }); }, queueOptions: { indexedDB } });
  trace.record('trace-gap', { data: { dropped: 1, reason: 'test' } });
  await trace.flush(); await trace.flush({ reconnect: true }); assert.equal(deniedCalls, 1); await trace.destroy();
  const broken = createPersistenceTrace('board', '103', { accountId: 'alice', locationHref: 'http://localhost', queueOptions: { indexedDB: null } });
  broken.record('trace-gap', { data: { dropped: 1, reason: 'test' } });
  await until(() => !broken.status.available, 'storage failure is visible'); await broken.destroy();
});

test('election trace records draws, full candidate views and tie-break without recording each heartbeat', async () => {
  const doc = new Y.Doc(); const records = []; let clock = 0; let timer;
  const trace = { identity: { traceSessionId: 'trace' }, record: (type, detail) => records.push({ type, ...detail }) };
  const c = createRoomPersistence(doc, 'board', { initialServerPaused: true, locationHref: 'http://localhost', trace,
    random: () => 42, now: () => clock, schedule: (fn) => { timer = fn; return 1; }, cancel: () => {} });
  const awareness = new EventEmitter(); awareness.clientID = doc.clientID; const states = new Map();
  awareness.getStates = () => states; awareness.setLocalStateField = (key, value) => states.set(doc.clientID, { [key]: value });
  c.attachProvider({ awareness });
  for (let i = 1; i <= 20; i++) states.set(i, { roomPersistence: { heartbeat: 1, candidate: { id: String(i), token: `candidate-${i}`, priority: 42, born: 0 } } });
  awareness.emit('change', { added: [...states.keys()], updated: [], removed: [] });
  const count = records.length;
  for (let i = 0; i < 30; i++) { for (let id = 1; id <= 20; id++) states.get(id).roomPersistence.heartbeat++; awareness.emit('change', { added: [], updated: [...states.keys()], removed: [] }); timer(); }
  assert.equal(records.length, count);
  const view = records.filter((r) => r.type === 'election-view').at(-1);
  assert.equal(view.data.candidates.length, 21); assert.equal(view.data.rule, 'lowest-priority-then-id');
  assert.equal(view.data.representative, ['1', '2', '3'].sort((a,b) => a.localeCompare(b))[0]);
  clock = 31000; await c.tick(); assert.equal(records.filter((r) => r.type === 'candidate-drawn').length, 2);
  assert.equal(records.some((r) => r.type === 'election-view' && r.data.candidates.some((v) => v.reason === 'expired')), true);
  c.destroy(); doc.destroy();
});

test('instrumented upload correlates sender election, server stages and original receipt coverage', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); const records = []; let seq = 0;
  const trace = { identity: { traceSessionId: 'trace' }, record(type, detail) { records.push({ type, ...detail }); return { eventId: String(++seq) }; } };
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, trace, timing: { batchMs: 30, tickMs: 10 },
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } }) });
  try {
    await until(() => c.status === 'connected', 'bootstrap'); doc.getMap('board').set('x', 1);
    await until(() => c.persistenceStatus.pending === 0 && records.some((r) => r.type === 'ack-verified'), 'persisted and ACK trace recorded');
    const send = records.find((r) => r.type === 'batch-send'); const ack = records.find((r) => r.type === 'ack-verified');
    assert.equal(send.batchId, ack.batchId); assert.equal(send.attemptId, ack.attemptId); assert.ok(ack.receiptId);
    assert.equal(records.some((r) => r.type === 'ack-received'), true); assert.ok(ack.data.elapsedMs >= 0);
    const rows = f.db.prepare('SELECT type, event_json FROM persistence_trace_events WHERE batch_id = ? ORDER BY id').all(send.batchId);
    assert.deepEqual(rows.map((r) => r.type), ['server-received', 'server-committed', 'server-ack-sent']);
    assert.ok(rows.every((r) => JSON.parse(r.event_json).attemptId === send.attemptId));
  } finally { c.destroy(); doc.destroy(); await f.close(); }
});

test('timeout keeps batch identity, creates new attempts, records late receipt and direct recovery', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); const records = []; let held; let release; let calls = 0; let bootstrap;
  const trace = { identity: { traceSessionId: 'retry-tab' }, record(type, detail) { records.push({ type, ...detail }); } };
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, trace,
    timing: { batchMs: 30, ackMs: 100, staleMs: 100, recoveryMs: 200, tickMs: 10 },
    fetchImpl: async (url, init) => {
      const content = Boolean(JSON.parse(init.body).update);
      if (!content && held) return bootstrap.clone();
      const response = await fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } });
      if (!content) bootstrap = response.clone();
      if (content && ++calls === 1) { held = new Response(await response.text()); await new Promise((resolve) => { release = resolve; }); return held; }
      return response;
    } });
  try {
    await until(() => c.status === 'connected', 'bootstrap'); c.setPeerEnabled(false); doc.getMap('board').set('first', 1);
    await until(() => held && records.some((r) => r.type === 'attempt-failed'), 'ACK deadline recorded');
    // Model a stale recovery response while the original ACK is delayed.
    doc.getMap('board').set('second', 2);
    await until(() => records.filter((r) => r.type === 'batch-send').length >= 2, 'batch retry');
    const sends = records.filter((r) => r.type === 'batch-send');
    assert.equal(sends[0].batchId, sends[1].batchId); assert.notEqual(sends[0].attemptId, sends[1].attemptId);
    assert.equal(sends[1].data.retry, true); assert.equal(sends[0].data.reason, 'direct-recovery');
    release();
    await until(() => records.some((r) => r.type === 'ack-received' && r.attemptId === sends[0].attemptId), 'late ACK recorded separately');
    assert.equal(records.find((r) => r.type === 'attempt-failed').data.reason, 'timeout');
    assert.ok(records.some((r) => r.type === 'candidate-drawn' && r.data.reason === 'request-failed'));
    await until(() => c.persistenceStatus.pending === 0, 'newer edit eventually persists');
  } finally { release?.(); c.destroy(); doc.destroy(); await f.close(); }
});

test('collector groups bounded submissions, exports diagnostic bytes separately and isolates boards', async () => {
  const { createLiveSyncMetricsSnapshot, exportLiveSyncMetricsCsv, exportSyncExperimentJson } = await import('../src/client/sync-experiment.js');
  const indexedDB = new IDBFactory(); const bodies = []; const metrics = createSyncExperimentMetrics();
  const options = { accountId: 'alice', locationHref: 'http://localhost', queueOptions: { indexedDB }, metrics,
    fetchImpl: async (_url, init) => { bodies.push(init.body); const { events } = JSON.parse(init.body); return Response.json({ accepted: events.map((e) => e.eventId), expired: [] }); } };
  const a = createPersistenceTrace('board-a', '1', options); const b = createPersistenceTrace('board-b', '2', options);
  try {
    for (let i = 0; i < 70; i++) a.record('trace-gap', { data: { dropped: 1, reason: 'fixture' } });
    await a.flush({ reconnect: true }); await a.flush({ reconnect: true }); await a.flush({ reconnect: true });
    assert.deepEqual(bodies.map((body) => JSON.parse(body).events.length), [32,32,6]);
    assert.ok(bodies.every((body) => new TextEncoder().encode(body).length <= 65536)); assert.equal(b.status.pending, 0);
    const snapshot = createLiveSyncMetricsSnapshot({ metrics: metrics.snapshot() });
    assert.ok(exportLiveSyncMetricsCsv(snapshot).includes('diagnostic,sent,'));
    assert.ok(JSON.parse(exportSyncExperimentJson(snapshot)).metrics.diagnostic.sent.bytes > 0);
    assert.equal(snapshot.metrics.http.sent.updateMessages, 0); assert.equal(snapshot.metrics.diagnostic.sent.updateMessages, 0);
  } finally { await a.destroy(); await b.destroy(); }
  const count = bodies.length; await a.flush({ reconnect: true }); assert.equal(bodies.length, count);
});

test('trace rejects forged receipts and explains edits outside the original receipt coverage', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); const records = []; let release; let captured; let hold = true;
  const trace = { identity: { traceSessionId: 'coverage-tab' }, record(type, detail) { records.push({ type, ...detail }); } };
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, trace, timing: { batchMs: 100, ackMs: 2000, tickMs: 10 },
    fetchImpl: async (url, init) => {
      const res = await fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } });
      if (JSON.parse(init.body).update && hold) { hold = false; captured = await res.clone().json(); await new Promise((resolve) => { release = resolve; }); }
      return res;
    } });
  const awareness = new EventEmitter(); awareness.clientID = doc.clientID; const states = new Map();
  awareness.getStates = () => states; awareness.setLocalStateField = (key, value) => states.set(doc.clientID, { [key]: value });
  try {
    await until(() => c.status === 'connected', 'bootstrap'); c.attachProvider({ awareness }); doc.getMap('board').set('first', 1);
    await until(() => release, 'held receipt'); doc.getMap('board').set('later', 2);
    const fake = structuredClone(captured.receipt); fake.payload.coverage.vector[doc.clientID] = 999999;
    states.set(1234, { roomPersistence: { receipt: fake } }); awareness.emit('change', { added: [1234], updated: [], removed: [] });
    await until(() => records.some((r) => r.type === 'ack-rejected'), 'forged ACK rejection recorded');
    assert.equal(c.persistenceStatus.pending, 2); release();
    await until(() => records.some((r) => r.type === 'ack-verified' && r.data.remainingUpdates === 1), 'uncovered edit explicitly remains pending');
    assert.ok(records.some((r) => r.type === 'receipt-forwarded'));
    await until(() => c.persistenceStatus.pending === 0, 'later edit gets independent coverage');
  } finally { release?.(); c.destroy(); doc.destroy(); await f.close(); }
});

test('collector obeys normal interval and bounded retry backoff without changing the content channel', async () => {
  const indexedDB = new IDBFactory(); let clock = 0; let calls = 0; let fail = true;
  const trace = createPersistenceTrace('retry-board', '100', { accountId: 'alice', locationHref: 'http://localhost', now: () => clock, queueOptions: { indexedDB },
    fetchImpl: async (_url, init) => { calls++; return fail ? new Response('{}', {status: 503}) : Response.json({accepted: JSON.parse(init.body).events.map((e) => e.eventId), expired: []}); } });
  try {
    trace.record('trace-gap', {data: {dropped: 1, reason: 'test'}});
    await trace.flush(); assert.equal(calls, 1);
    for (const delay of [1000,2000,5000,10000,30000,30000]) {
      const before = calls; clock += delay - 1; await trace.flush(); assert.equal(calls, before);
      clock++; await trace.flush(); assert.equal(calls, before + 1);
    }
    fail = false; clock += 30000; await trace.flush(); assert.equal(trace.status.pending, 0);
    trace.record('trace-gap', {data: {dropped: 1, reason: 'test'}});
    const before = calls; clock += 9999; await trace.flush(); assert.equal(calls, before);
    clock++; await trace.flush(); assert.equal(calls, before + 1);
  } finally { await trace.destroy(); }
});
