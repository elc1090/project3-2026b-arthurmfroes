import * as Y from 'yjs';

const SERVER_ORIGIN = Symbol('board-server-update');
const MAX_UPDATE_BYTES = 3 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];

function recordExperimentMetric(metrics, direction, payload, message) {
  try { metrics?.recordWebSocket(direction, payload, message); } catch { /* measurement must not affect sync */ }
}

/** Synchronize one Y.Doc with the authenticated durable server replica. */
export function createServerSyncProvider(doc, boardId, {
  WebSocketImpl = globalThis.WebSocket,
  locationHref = globalThis.location?.href,
  initialServerPaused = false,
  onEvent = () => {},
  eventTracker = null,
  experimentMetrics = null,
} = {}) {
  if (!doc || typeof doc.on !== 'function') throw new TypeError('A Y.Doc is required');
  if (typeof boardId !== 'string' || boardId.length === 0) throw new TypeError('boardId must be a non-empty string');
  if (typeof WebSocketImpl !== 'function' || !locationHref) {
    throw new Error('A browser WebSocket and location are required');
  }

  const url = new URL(`/api/boards/${encodeURIComponent(boardId)}/sync`, locationHref);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const pending = new Map();
  let socket = null;
  let paused = initialServerPaused;
  let destroyed = false;
  let syncReady = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let currentStatus = paused ? 'paused' : 'connecting';

  const setStatus = (status) => {
    if (currentStatus === status) return;
    currentStatus = status;
    onEvent('server-status', status);
  };

  function sendJson(message) {
    if (socket?.readyState !== WebSocketImpl.OPEN) return false;
    const payload = JSON.stringify(message);
    socket.send(payload);
    recordExperimentMetric(experimentMetrics, 'sent', payload, message);
    return true;
  }

  function sendUpdate(updateId, bytes) {
    if (bytes.byteLength > MAX_UPDATE_BYTES) {
      onEvent('error', new RangeError('A board update exceeds the server sync limit'));
      return false;
    }
    pending.set(updateId, { bytes });
    return sendJson({ type: 'update', updateId, update: encodeBytes(bytes) });
  }

  function queueDocumentUpdate(bytes) {
    if (bytes.byteLength <= 2) return;
    const updateId = createUpdateId();
    pending.set(updateId, { bytes });
    if (syncReady) sendUpdate(updateId, bytes);
  }

  function onDocumentUpdate(update, origin) {
    if (origin === SERVER_ORIGIN) return;
    queueDocumentUpdate(update);
  }

  function onSocketMessage(event) {
    let message;
    const payload = typeof event.data === 'string' ? event.data : String(event.data);
    try {
      message = JSON.parse(payload);
    } catch (error) {
      recordExperimentMetric(experimentMetrics, 'received', payload);
      onEvent('error', error);
      return;
    }
    recordExperimentMetric(experimentMetrics, 'received', payload, message);

    if (message.type === 'sync') {
      try {
        const serverVector = decodeBytes(message.stateVector);
        const serverUpdate = decodeBytes(message.update);
        if (serverUpdate.byteLength > 2 && eventTracker) {
          void eventTracker.observeSyncBatch(serverUpdate, { state: 'initial-server-diff' })
            .catch((error) => onEvent('error', error));
        }
        Y.applyUpdate(doc, serverUpdate, SERVER_ORIGIN);
        for (const [updateId, pendingUpdate] of pending) {
          if (!sendUpdate(updateId, pendingUpdate.bytes)) break;
        }
        const localDiff = Y.encodeStateAsUpdate(doc, serverVector);
        if (localDiff.byteLength > 2) {
          const updateId = createUpdateId();
          sendUpdate(updateId, localDiff);
        }
        syncReady = true;
        reconnectAttempt = 0;
        setStatus('connected');
      } catch (error) {
        onEvent('error', error);
        socket?.close(1007, 'Invalid synchronization response');
      }
      return;
    }

    if (message.type === 'update') {
      try {
        const update = decodeBytes(message.update);
        if (update.byteLength > 2 && eventTracker) {
          void eventTracker.observeUpdate(update, {
            sourcePath: 'server',
            serverUpdateId: message.updateId,
            actionKind: 'server-update',
          }).catch((error) => onEvent('error', error));
        }
        Y.applyUpdate(doc, update, SERVER_ORIGIN);
      } catch (error) {
        onEvent('error', error);
      }
      return;
    }

    if (message.type === 'durable-ack') {
      pending.delete(message.updateId);
      const ack = eventTracker
        ? eventTracker.emit('durable-ack', { ...message, sourcePath: 'server' })
        : message;
      onEvent('durable-ack', ack);
      return;
    }

    if (message.type === 'error') onEvent('error', new Error(message.error ?? 'Board sync failed'));
  }

  function scheduleReconnect() {
    if (destroyed || paused || reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (destroyed || paused || socket) return;
    setStatus('connecting');
    try {
      const nextSocket = new WebSocketImpl(url);
      socket = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        syncReady = false;
        sendJson({ type: 'sync', stateVector: encodeBytes(Y.encodeStateVector(doc)) });
      });
      nextSocket.addEventListener('message', (event) => {
        if (socket === nextSocket) onSocketMessage(event);
      });
      nextSocket.addEventListener('error', () => {
        if (socket === nextSocket) setStatus('disconnected');
      });
      nextSocket.addEventListener('close', () => {
        if (socket !== nextSocket) return;
        socket = null;
        syncReady = false;
        setStatus(paused ? 'paused' : 'disconnected');
        scheduleReconnect();
      });
    } catch (error) {
      socket = null;
      setStatus('disconnected');
      onEvent('error', error);
      scheduleReconnect();
    }
  }

  doc.on('update', onDocumentUpdate);
  if (!paused) connect();

  return Object.freeze({
    get status() { return currentStatus; },
    origin: SERVER_ORIGIN,
    pause() {
      if (destroyed || paused) return;
      paused = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      syncReady = false;
      if (socket) {
        const current = socket;
        socket = null;
        current.close(1000, 'Server sync paused');
      }
      setStatus('paused');
    },
    resume() {
      if (destroyed || !paused) return;
      paused = false;
      connect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      doc.off('update', onDocumentUpdate);
      if (socket) {
        const current = socket;
        socket = null;
        current.close(1000, 'Board session closed');
      }
      pending.clear();
    },
  });
}

function encodeBytes(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function decodeBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('The server sent malformed Yjs bytes');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createUpdateId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
