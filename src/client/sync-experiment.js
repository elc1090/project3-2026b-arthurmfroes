const CHANNELS = ['websocket', 'webrtc'];
const DIRECTIONS = ['sent', 'received'];

function emptyCounters() {
  return {
    bytes: 0,
    messages: 0,
    updateMessages: 0,
    awarenessBytes: 0,
    awarenessMessages: 0,
    syncBytes: 0,
    otherBytes: 0,
  };
}

function emptySnapshot() {
  return Object.fromEntries(CHANNELS.map(channel => [channel, Object.fromEntries(
    DIRECTIONS.map(direction => [direction, emptyCounters()]),
  )]));
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function payloadLength(value) {
  if (typeof value === 'string') return utf8Length(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return utf8Length(JSON.stringify(value));
}

function removeEventListener(emitter, type, listener) {
  if (typeof emitter.off === 'function') emitter.off(type, listener);
  else emitter.removeListener?.(type, listener);
}

/**
 * Counts application payloads only. WebSocket counts UTF-8 JSON envelopes;
 * WebRTC counts bytes passed to/received from y-webrtc's SimplePeer datachannel.
 * Neither total includes TCP/TLS or SCTP/DTLS/IP framing or retransmissions.
 */
export function createSyncExperimentMetrics() {
  let totals = emptySnapshot();

  function record(channel, direction, bytes, category, { update = false } = {}) {
    if (!totals[channel] || !DIRECTIONS.includes(direction) || !Number.isSafeInteger(bytes) || bytes < 0) return;
    const counter = totals[channel][direction];
    counter.bytes += bytes;
    counter.messages += 1;
    if (category === 'awareness') {
      counter.awarenessBytes += bytes;
      counter.awarenessMessages += 1;
    } else if (category === 'sync') {
      counter.syncBytes += bytes;
    } else {
      counter.otherBytes += bytes;
    }
    if (update) counter.updateMessages += 1;
  }

  return Object.freeze({
    recordWebSocket(direction, payload, message = null) {
      let update = false;
      const category = message?.type === 'sync' || message?.type === 'update' ? 'sync' : 'other';
      if (message?.type === 'update') update = true;
      if (message?.type === 'sync' && typeof message.update === 'string') {
        try { update = decodeBase64Length(message.update) > 2; } catch { /* malformed payload is still counted */ }
      }
      record('websocket', direction, payloadLength(payload), category, { update });
    },
    recordWebRtc(direction, payload) {
      const bytes = toUint8Array(payload);
      const classification = classifyYWebrtcMessage(bytes);
      record('webrtc', direction, bytes.byteLength, classification.category, { update: classification.update });
    },
    snapshot() {
      return structuredClone(totals);
    },
    reset() {
      totals = emptySnapshot();
    },
  });
}

/**
 * y-webrtc 10.3.0 creates `room.webrtcConns` before emitting `peers` and sends
 * every datachannel frame through `conn.peer.send()`. This isolated adapter
 * wraps that public SimplePeer method and its `data` event; Awareness frames
 * are classified separately from Yjs sync frames. Reconnection attaches fresh
 * peers, while close/destroy restores each wrapped method and listener.
 */
export function attachWebrtcPayloadMetrics(provider, metrics) {
  if (!provider || !metrics) return () => {};
  const hooks = new Map();
  let destroyed = false;

  function detach(peer) {
    const hook = hooks.get(peer);
    if (!hook) return;
    hooks.delete(peer);
    removeEventListener(peer, 'data', hook.onData);
    removeEventListener(peer, 'close', hook.onClose);
    if (peer.send === hook.wrappedSend) {
      if (hook.originalOwnDescriptor) Object.defineProperty(peer, 'send', hook.originalOwnDescriptor);
      else delete peer.send;
    }
  }

  function attachAvailableConnections() {
    if (destroyed) return;
    for (const connection of provider.room?.webrtcConns?.values?.() ?? []) {
      const peer = connection.peer;
      if (!peer || hooks.has(peer) || typeof peer.send !== 'function' || typeof peer.on !== 'function') continue;
      const originalSend = peer.send;
      const originalOwnDescriptor = Object.getOwnPropertyDescriptor(peer, 'send');
      const wrappedSend = function measuredSend(payload, ...args) {
        const result = originalSend.call(this, payload, ...args);
        try { metrics.recordWebRtc('sent', payload); } catch { /* measurement must not affect sync */ }
        return result;
      };
      const onData = payload => {
        try { metrics.recordWebRtc('received', payload); } catch { /* measurement must not affect sync */ }
      };
      const onClose = () => detach(peer);
      hooks.set(peer, { wrappedSend, originalOwnDescriptor, onData, onClose });
      peer.send = wrappedSend;
      peer.on('data', onData);
      peer.once?.('close', onClose);
    }
  }

  const onPeers = () => attachAvailableConnections();
  provider.on?.('peers', onPeers);
  attachAvailableConnections();

  return () => {
    if (destroyed) return;
    destroyed = true;
    removeEventListener(provider, 'peers', onPeers);
    for (const peer of hooks.keys()) detach(peer);
  };
}

/** Build a JSON-safe paired-run comparison; times are runner-monotonic ms. */
export function createSyncExperimentComparison({
  scenario,
  runs,
  separateDemonstration = null,
  createdAt = new Date().toISOString(),
}) {
  if (!Array.isArray(runs) || runs.length !== 2
    || !runs.some(run => run.mode === 'hybrid') || !runs.some(run => run.mode === 'server-only')) {
    throw new TypeError('A comparison requires one hybrid run and one server-only run');
  }
  const comparison = {
    schemaVersion: 1,
    scenario: String(scenario ?? 'scripted board edits'),
    createdAt,
    timingClock: 'orchestrator-monotonic-ms',
    trafficScope: 'WebSocket UTF-8 JSON and WebRTC datachannel payload bytes; excludes WS/TCP/TLS/SCTP/DTLS/IP overhead and retransmissions',
    runs: structuredClone(runs),
  };
  if (separateDemonstration) comparison.separateDemonstration = structuredClone(separateDemonstration);
  return comparison;
}

export function exportSyncExperimentJson(comparison) {
  return JSON.stringify(comparison, null, 2);
}

/** Snapshot export for one live browser replica, separate from paired runs. */
export function createLiveSyncMetricsSnapshot({ boardId = null, replicaId = null, metrics, capturedAt = new Date().toISOString() }) {
  if (!metrics?.websocket || !metrics?.webrtc) throw new TypeError('A session metrics snapshot is required');
  return {
    schemaVersion: 1,
    kind: 'live-replica-sync-metrics',
    boardId,
    replicaId,
    capturedAt,
    trafficScope: 'WebSocket UTF-8 JSON and WebRTC datachannel payload bytes; excludes WS/TCP/TLS/SCTP/DTLS/IP overhead and retransmissions',
    metrics: structuredClone(metrics),
  };
}

export function exportLiveSyncMetricsCsv(snapshot) {
  const rows = [[
    'kind', 'boardId', 'replicaId', 'capturedAt', 'trafficScope', 'channel', 'direction', 'bytes', 'messages',
    'updateMessages', 'awarenessBytes', 'awarenessMessages', 'syncBytes', 'otherBytes',
  ].join(',')];
  for (const channel of CHANNELS) {
    for (const direction of DIRECTIONS) {
      const counter = snapshot.metrics?.[channel]?.[direction] ?? emptyCounters();
      rows.push([
        csvCell(snapshot.kind), csvCell(snapshot.boardId), csvCell(snapshot.replicaId), csvCell(snapshot.capturedAt),
        csvCell(snapshot.trafficScope),
        channel, direction, counter.bytes, counter.messages, counter.updateMessages,
        counter.awarenessBytes, counter.awarenessMessages, counter.syncBytes, counter.otherBytes,
      ].join(','));
    }
  }
  return rows.join('\n');
}

/** Flatten each replica/channel/direction into CSV; Awareness is its own column. */
export function exportSyncExperimentCsv(comparison) {
  const columns = [
    'scenario', 'trafficScope', 'mode', 'vpsWebSocket', 'p2p', 'replica', 'channel', 'direction', 'bytes', 'messages', 'updateMessages',
    'awarenessBytes', 'awarenessMessages', 'syncBytes', 'otherBytes',
    'firstVisibleMs', 'firstArrivalPath', 'peerVisibleMs', 'allClientsConvergedMs', 'vpsDurableMs', 'serverUpdateRows',
  ];
  const rows = [columns.join(',')];
  for (const run of comparison.runs) {
    const replicas = Object.entries(run.replicas ?? {});
    for (const [replica, metrics] of replicas) {
      for (const channel of CHANNELS) {
        for (const direction of DIRECTIONS) {
          const counters = metrics?.[channel]?.[direction] ?? emptyCounters();
          rows.push([
            csvCell(comparison.scenario), csvCell(comparison.trafficScope), csvCell(run.mode),
            csvCell(run.vpsWebSocket), csvCell(run.p2p), csvCell(replica), channel, direction,
            counters.bytes, counters.messages, counters.updateMessages,
            counters.awarenessBytes, counters.awarenessMessages, counters.syncBytes, counters.otherBytes,
            nullableNumber(run.firstVisibleMs), csvCell(run.firstArrivalPath), nullableNumber(run.peerVisibleMs),
            nullableNumber(run.allClientsConvergedMs),
            nullableNumber(run.vpsDurableMs), run.serverUpdateRows ?? '',
          ].join(','));
        }
      }
    }
  }
  return rows.join('\n');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : '';
}

function decodeBase64Length(value) {
  if (typeof atob === 'function') return atob(value).length;
  return Buffer.from(value, 'base64').byteLength;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array();
}

function readVarUint(bytes, offset) {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length && shift <= 28) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  return null;
}

function classifyYWebrtcMessage(bytes) {
  const outer = readVarUint(bytes, 0);
  if (!outer) return { category: 'other', update: false };
  if (outer.value === 1 || outer.value === 3) return { category: 'awareness', update: false };
  if (outer.value !== 0) return { category: 'other', update: false };
  const sync = readVarUint(bytes, outer.offset);
  if (!sync) return { category: 'sync', update: false };
  // y-protocols sync step 2/update append a length-prefixed Yjs byte payload.
  if (sync.value === 2) return { category: 'sync', update: true };
  if (sync.value === 1) {
    const stateLength = readVarUint(bytes, sync.offset);
    return { category: 'sync', update: Boolean(stateLength && stateLength.value > 2) };
  }
  return { category: 'sync', update: false };
}
