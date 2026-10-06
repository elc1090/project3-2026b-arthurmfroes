import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  attachWebrtcPayloadMetrics,
  createSyncExperimentComparison,
  createSyncExperimentMetrics,
  exportSyncExperimentCsv,
  exportSyncExperimentJson,
} from '../src/client/sync-experiment.js';
import { mountSyncExperimentUI } from '../src/client/sync-experiment-ui.js';

class FakePeer extends EventEmitter {
  sent = [];
  failNext = false;

  send(payload) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('datachannel closed');
    }
    this.sent.push(payload);
  }
}

class FakeProvider extends EventEmitter {
  room = { webrtcConns: new Map() };
}

class FakeElement {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.removed = false;
  }

  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener(); }
  remove() { this.removed = true; }
  findButton(label) { return this.children.find(child => child.textContent === label); }
}

class FakeDocument {
  createElement() { return new FakeElement(this); }
}

test('payload metrics separate WebSocket envelopes, Yjs updates, and Awareness', () => {
  const metrics = createSyncExperimentMetrics();
  const sentUpdate = JSON.stringify({ type: 'update', updateId: 'u1', update: 'AQID' });
  const receivedSync = JSON.stringify({ type: 'sync', stateVector: '', update: 'AQID' });
  const receivedAck = JSON.stringify({ type: 'durable-ack', updateId: 'u1' });

  metrics.recordWebSocket('sent', sentUpdate, JSON.parse(sentUpdate));
  metrics.recordWebSocket('received', receivedSync, JSON.parse(receivedSync));
  metrics.recordWebSocket('received', receivedAck, JSON.parse(receivedAck));
  metrics.recordWebRtc('sent', new Uint8Array([0, 2, 9, 8])); // sync / Yjs update
  metrics.recordWebRtc('received', new Uint8Array([1, 4, 5])); // Awareness
  metrics.recordWebRtc('received', new Uint8Array([0, 0])); // sync step 1 control

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.websocket.sent.bytes, new TextEncoder().encode(sentUpdate).byteLength);
  assert.equal(snapshot.websocket.sent.updateMessages, 1);
  assert.equal(snapshot.websocket.sent.otherBytes, 0);
  assert.equal(snapshot.websocket.received.updateMessages, 1, 'a nonempty server sync diff carries one update message');
  assert.equal(snapshot.websocket.received.otherBytes, new TextEncoder().encode(receivedAck).byteLength);
  assert.equal(snapshot.webrtc.sent.updateMessages, 1);
  assert.equal(snapshot.webrtc.sent.syncBytes, 4);
  assert.equal(snapshot.webrtc.received.awarenessMessages, 1);
  assert.equal(snapshot.webrtc.received.awarenessBytes, 3);
  assert.equal(snapshot.webrtc.received.updateMessages, 0);
  assert.equal(snapshot.webrtc.received.messages, 2);

  metrics.reset();
  assert.equal(metrics.snapshot().websocket.sent.bytes, 0);
  assert.equal(metrics.snapshot().webrtc.received.messages, 0);
});

test('WebRTC update count excludes an empty sync-step-2 state payload', () => {
  const metrics = createSyncExperimentMetrics();
  metrics.recordWebRtc('received', new Uint8Array([0, 1, 2, 0, 0]));
  metrics.recordWebRtc('received', new Uint8Array([0, 1, 3, 9, 8, 7]));
  assert.equal(metrics.snapshot().webrtc.received.updateMessages, 1);
  assert.equal(metrics.snapshot().webrtc.received.messages, 2);
});

test('WebRTC instrumentation counts successful peer sends and detaches on close or cleanup', () => {
  const provider = new FakeProvider();
  const metrics = createSyncExperimentMetrics();
  const cleanup = attachWebrtcPayloadMetrics(provider, metrics);
  const firstPeer = new FakePeer();
  provider.room.webrtcConns.set('peer-a', { peer: firstPeer });
  provider.emit('peers', [{ added: ['peer-a'] }]);

  firstPeer.send(new Uint8Array([0, 2, 1, 2]));
  firstPeer.emit('data', new Uint8Array([1, 0]));
  firstPeer.failNext = true;
  assert.throws(() => firstPeer.send(new Uint8Array([0, 2, 3])), /datachannel closed/);
  assert.deepEqual(metrics.snapshot().webrtc.sent, {
    bytes: 4,
    messages: 1,
    updateMessages: 1,
    awarenessBytes: 0,
    awarenessMessages: 0,
    syncBytes: 4,
    otherBytes: 0,
  }, 'a send that throws is not reported as traffic');
  assert.equal(metrics.snapshot().webrtc.received.awarenessMessages, 1);

  firstPeer.emit('close');
  firstPeer.send(new Uint8Array([0, 2, 3]));
  assert.equal(metrics.snapshot().webrtc.sent.messages, 1, 'closed peers are no longer observed');

  const reconnectPeer = new FakePeer();
  provider.room.webrtcConns.set('peer-b', { peer: reconnectPeer });
  provider.emit('peers', [{ added: ['peer-b'] }]);
  reconnectPeer.send(new Uint8Array([0, 2, 4]));
  assert.equal(metrics.snapshot().webrtc.sent.messages, 2, 'a replacement connection is instrumented');

  cleanup();
  assert.equal(firstPeer.listenerCount('data'), 0);
  assert.equal(reconnectPeer.listenerCount('data'), 0);
  reconnectPeer.send(new Uint8Array([0, 2, 5]));
  assert.equal(metrics.snapshot().webrtc.sent.messages, 2, 'cleanup restores the original send method');
});

test('a failing measurement callback cannot change WebRTC send or receive behavior', () => {
  const provider = new FakeProvider();
  const peer = new FakePeer();
  provider.room.webrtcConns.set('peer-a', { peer });
  const cleanup = attachWebrtcPayloadMetrics(provider, {
    recordWebRtc() { throw new Error('metrics offline'); },
  });
  assert.doesNotThrow(() => peer.send(new Uint8Array([0, 2, 1])));
  assert.equal(peer.sent.length, 1);
  assert.doesNotThrow(() => peer.emit('data', new Uint8Array([0, 2, 1])));
  cleanup();
});

test('experiment comparison exports paired modes as JSON and CSV', () => {
  const replicas = { alice: createSyncExperimentMetrics().snapshot() };
  const comparison = createSyncExperimentComparison({
    scenario: 'same "script"',
    createdAt: '2026-01-01T00:00:00.000Z',
    separateDemonstration: { scenario: 'hybrid-vps-paused', evidenceTest: 'test/board-session.browser.test.js' },
    runs: [
      { mode: 'hybrid', vpsWebSocket: 'active', p2p: 'active', replicas, firstVisibleMs: 3.5, firstArrivalPath: 'peer-room', peerVisibleMs: 3.5, allClientsConvergedMs: 5, vpsDurableMs: 8, serverUpdateRows: 2 },
      { mode: 'server-only', vpsWebSocket: 'active', p2p: 'paused', replicas, firstVisibleMs: 4, firstArrivalPath: 'server', peerVisibleMs: null, allClientsConvergedMs: 7, vpsDurableMs: 6, serverUpdateRows: 2 },
    ],
  });
  const json = exportSyncExperimentJson(comparison);
  assert.equal(JSON.parse(json).runs.length, 2);
  assert.equal(JSON.parse(json).separateDemonstration.scenario, 'hybrid-vps-paused');
  assert.match(json, /WS\/TCP\/TLS\/SCTP\/DTLS\/IP overhead/);
  const csv = exportSyncExperimentCsv(comparison);
  assert.match(csv, /^scenario,trafficScope,mode,vpsWebSocket,p2p,replica,channel,direction,bytes,messages,updateMessages/);
  assert.match(csv, /"same ""script""/);
  assert.match(csv, /"same ""script""",WebSocket UTF-8 JSON and WebRTC datachannel payload bytes; excludes WS\/TCP\/TLS\/SCTP\/DTLS\/IP overhead and retransmissions,server-only,active,paused,alice,webrtc,sent,0,0,0,0,0,0,0,4,server,,7,6,2/);
});

test('live metrics panel refreshes, resets, and exports one replica as JSON and CSV', () => {
  const metrics = createSyncExperimentMetrics();
  metrics.recordWebRtc('sent', new Uint8Array([0, 2, 1]));
  const session = {
    get experimentMetrics() { return metrics.snapshot(); },
    resetExperimentMetrics() { metrics.reset(); },
  };
  const document = new FakeDocument();
  const container = new FakeElement(document);
  const downloads = [];
  const panel = mountSyncExperimentUI({
    session,
    container,
    boardId: 'board-1',
    replicaId: 'replica-a',
    download: (...args) => downloads.push(args),
  });
  const root = container.children[0];
  const [heading, scope, summary, resetButton, jsonButton, csvButton, status] = root.children;
  assert.equal(heading.textContent, 'Tráfego desta réplica');
  assert.match(scope.textContent, /não inclui overhead/i);
  assert.match(summary.textContent, /webrtc: enviados 3 B \/ 1 updates/);

  jsonButton.click();
  csvButton.click();
  assert.equal(JSON.parse(downloads[0][1]).metrics.webrtc.sent.updateMessages, 1);
  assert.match(downloads[1][1], /live-replica-sync-metrics,board-1,replica-a,.*excludes WS\/TCP\/TLS\/SCTP\/DTLS\/IP overhead/);
  assert.equal(downloads[0][0], 'sync-metrics.json');
  assert.equal(downloads[1][0], 'sync-metrics.csv');

  resetButton.click();
  assert.equal(metrics.snapshot().webrtc.sent.bytes, 0);
  assert.equal(status.textContent, 'Contadores zerados nesta réplica.');
  assert.match(summary.textContent, /webrtc: enviados 0 B \/ 0 updates/);
  panel.destroy();
  assert.equal(root.removed, true);
});
