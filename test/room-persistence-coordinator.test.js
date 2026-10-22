import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createRoomPersistence } from '../src/client/room-persistence.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { persistenceFixture } from './fixtures/room-persistence-server.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await wait(10); }
  assert.fail(message);
}
function peerPair(docs) {
  const all = new Map(); const peers = [];
  for (const doc of docs) {
    const aw = new EventEmitter(); aw.clientID = doc.clientID;
    aw.getStates = () => all;
    aw.setLocalStateField = (key, value) => {
      all.set(aw.clientID, { ...all.get(aw.clientID), [key]: value });
      for (const other of peers) other.emit('change', { added: [], updated: [aw.clientID], removed: [] });
    };
    peers.push(aw);
  }
  docs.forEach((doc, i) => doc.on('update', (bytes, origin) => {
    if (origin === 'fake-peer') return;
    docs.forEach((other, j) => { if (i !== j) Y.applyUpdate(other, bytes, 'fake-peer'); });
  }));
  return peers.map((awareness) => ({ awareness }));
}
const timing = { batchMs: 40, ackMs: 120, mandateMs: 1500, staleMs: 200, recoveryMs: 350, tickMs: 10 };

async function setup(f, docs, options = {}) {
  const sent = docs.map(() => []); const events = docs.map(() => []);
  const cs = docs.map((doc, i) => createRoomPersistence(doc, f.boardId, {
    locationHref: f.baseUrl, timing, random: () => i + 1,
    onEvent: (type, detail) => events[i].push({ type, detail }),
    fetchImpl: (url, init) => {
      const body = JSON.parse(init.body);
      if (body.update) sent[i].push(body);
      return fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[i].token}` } });
    }, ...options,
  }));
  await until(() => cs.every((c) => c.status === 'connected'), 'bootstrap should connect');
  return { cs, sent, events };
}

test('stable room batches through one representative and peer ACK covers original edits only', async () => {
  const f = await persistenceFixture(); const docs = [new Y.Doc(), new Y.Doc()];
  let cs;
  try {
    const providers = peerPair(docs); const state = await setup(f, docs); cs = state.cs;
    cs.forEach((c, i) => c.attachProvider(providers[i]));
    docs[1].getMap('board').set('fromBob', 1);
    docs[0].getMap('board').set('fromAlice', 1);
    await until(() => cs.every((c) => c.persistenceStatus.pending === 0), 'all original edits get confirmed');
    assert.ok(state.sent[0].length > 0); assert.equal(state.sent[1].length, 0, 'follower sends no content');
    assert.ok(state.events[1].some((e) => e.type === 'durable-ack' && e.detail.sourcePath === 'peer-receipt'));
    const stored = createBoardUpdateStore(f.db).loadDocument(f.boardId);
    assert.deepEqual(stored.getMap('board').toJSON(), { fromBob: 1, fromAlice: 1 }); stored.destroy();
    docs[1].getMap('board').delete('fromBob');
    assert.ok(cs[1].persistenceStatus.pending > 0);
    await until(() => cs.every((c) => c.persistenceStatus.pending === 0), 'delete gets its own receipt');
    cs[0].destroy();
    // Remove document transport to model a closed peer as well as expired awareness.
    docs[1].getMap('board').set('afterExit', 2);
    await until(() => state.sent[1].length > 0 && cs[1].persistenceStatus.pending === 0, 'remaining peer takes over');
  } finally { cs?.forEach((c) => c.destroy()); docs.forEach((d) => d.destroy()); await f.close(); }
});

test('in-flight batch does not confirm later edit, forged peer receipt is ignored, and paused client stays pending', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); const events = []; let release; let captured; let hold = true;
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, timing: { ...timing, ackMs: 1000 }, onEvent: (type, detail) => events.push({ type, detail }),
    fetchImpl: async (url, init) => {
      const response = await fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } });
      if (JSON.parse(init.body).update && hold) {
        hold = false; captured = await response.clone().json();
        await new Promise((resolve) => { release = resolve; });
      }
      return response;
    },
  });
  try {
    await until(() => c.status === 'connected', 'bootstrap');
    doc.getMap('board').set('first', 1);
    await until(() => release, 'batch sent');
    doc.getMap('board').set('second', 2);
    c.pause(); release(); await wait(40);
    assert.ok(c.persistenceStatus.pending >= 2, 'pause prevents even a valid in-flight receipt from confirming');
    c.resume();
    await until(() => c.persistenceStatus.pending === 0, 'resume persists later edits');
    const provider = peerPair([doc, new Y.Doc()])[0]; c.attachProvider(provider);
    c.pause(); doc.getMap('board').set('third', 3); c.resume();
    const fake = structuredClone(captured.receipt); fake.payload.coverage.vector[doc.clientID] = 999;
    provider.awareness.getStates().set(1234, { roomPersistence: { receipt: fake } });
    provider.awareness.emit('change', { added: [1234], updated: [], removed: [] });
    await wait(5); assert.ok(c.persistenceStatus.pending > 0, 'forged receipt does not confirm');
    await until(() => c.persistenceStatus.pending === 0, 'real ACK confirms');
  } finally { c.destroy(); doc.destroy(); await f.close(); }
});

test('timeout renews candidacy, retries preserve pending state, mandate rotates, and destroy stops work', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); let block = false; let requests = 0; const elections = [];
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, timing: { ...timing, mandateMs: 150 },
    onEvent: (type, detail) => { if (type === 'persistence-election') elections.push(detail); },
    fetchImpl: (url, init) => {
      requests++;
      if (block && JSON.parse(init.body).update) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } });
    },
  });
  const aw = peerPair([doc])[0]; c.attachProvider(aw);
  try {
    await until(() => c.status === 'connected', 'bootstrap');
    const token = aw.awareness.getStates().get(doc.clientID).roomPersistence.candidate.token;
    block = true; doc.getMap('board').set('pending', 1);
    await until(() => c.status === 'disconnected', 'ACK timeout is visible');
    assert.ok(c.persistenceStatus.pending > 0);
    block = false;
    await until(() => c.persistenceStatus.pending === 0, 'retry confirms');
    await until(() => aw.awareness.getStates().get(doc.clientID)?.roomPersistence?.candidate?.token !== token, 'mandate/candidacy renewed');
    c.destroy(); const count = requests; await wait(80); assert.equal(requests, count);
  } finally { c.destroy(); doc.destroy(); await f.close(); }
});

test('a healthy candidate renews its random draw when the mandate expires', async () => {
  const f = await persistenceFixture(); const doc = new Y.Doc(); let draws = 0;
  const c = createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, timing: { ...timing, mandateMs: 100 }, random: () => ++draws,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[0].token}` } }),
  });
  const provider = peerPair([doc])[0]; c.attachProvider(provider);
  try {
    const token = provider.awareness.getStates().get(doc.clientID).roomPersistence.candidate.token;
    await until(() => draws >= 2, 'mandate renews priority');
    assert.notEqual(provider.awareness.getStates().get(doc.clientID).roomPersistence.candidate.token, token);
  } finally { c.destroy(); doc.destroy(); await f.close(); }
});

test('another peer takes over after a representative request times out', async () => {
  const f = await persistenceFixture(); const docs = [new Y.Doc(), new Y.Doc()]; const events = []; const uploaded = [0, 0];
  const providers = peerPair(docs);
  const cs = docs.map((doc, i) => createRoomPersistence(doc, f.boardId, { locationHref: f.baseUrl, timing, random: () => i + 1,
    onEvent: (type) => events.push([i, type]),
    fetchImpl: (url, init) => {
      if (JSON.parse(init.body).update) {
        uploaded[i]++;
        if (i === 0) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('simulated timeout')), { once: true }));
      }
      return fetch(url, { ...init, headers: { ...init.headers, cookie: `whiteboard_session=${f.users[i].token}` } });
    },
  }));
  try {
    await until(() => cs.every((c) => c.status === 'connected'), 'bootstrap');
    cs.forEach((c, i) => c.attachProvider(providers[i]));
    docs[1].getMap('board').set('survivesTimeout', 1);
    await until(() => uploaded[1] > 0 && cs.every((c) => c.persistenceStatus.pending === 0), 'other candidate persists and distributes receipt');
    assert.ok(uploaded[0] > 0); assert.ok(events.some(([i, type]) => i === 0 && type === 'error'));
  } finally { cs.forEach((c) => c.destroy()); docs.forEach((d) => d.destroy()); await f.close(); }
});
