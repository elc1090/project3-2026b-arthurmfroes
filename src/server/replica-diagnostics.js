import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { readBoardElements } from '../shared/board-model.js';
import { getAuthenticatedSession } from './auth.js';
import { authorizeBoardMembership } from './boards.js';
import { createInspectionHistoryStore } from './inspection-history-store.js';

const REPLICAS_PATH = /^\/api\/boards\/([^/]+)\/replicas$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PEERS_PER_BOARD = 8;
const MAX_ELEMENTS_PER_SNAPSHOT = 10_000;
const REPLICA_REFRESH_MS = 1_000;
const ELEMENT_TYPES = new Set(['image', 'rect', 'mux', 'alu', 'path', 'line', 'arrow', 'text']);

/**
 * Attach an authenticated diagnostics channel, separate from board sync.
 * It carries renderable JSON projections and metadata only; Yjs update bytes
 * are neither accepted nor produced here. The VPS view is reconstructed from
 * durable SQLite/checkpoint state on a short polling interval.
 */
export function attachReplicaDiagnostics(server, { db, updateStore, refreshIntervalMs = REPLICA_REFRESH_MS }) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const rooms = new Map();
  const history = createInspectionHistoryStore(db);
  let disposed = false;

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    const match = url.pathname.match(REPLICAS_PATH);
    if (!match) return;

    let boardId;
    try {
      boardId = decodeURIComponent(match[1]);
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    const session = getAuthenticatedSession(request, db);
    if (!session) {
      rejectUpgrade(socket, 401);
      return;
    }
    const authorization = authorizeBoardMembership(db, boardId, session.accountId);
    if (authorization.status !== 'authorized') {
      rejectUpgrade(socket, authorization.status === 'not_found' ? 404 : 403);
      return;
    }
    const room = rooms.get(boardId);
    if ((room?.connections.size ?? 0) >= MAX_PEERS_PER_BOARD) {
      rejectUpgrade(socket, 429);
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (ws) => {
      const targetRoom = getRoom(boardId);
      const requestedReplicaId = url.searchParams.get('replicaId');
      const candidateReplicaId = /^[0-9a-f-]{36}$/i.test(requestedReplicaId ?? '')
        ? `peer:${requestedReplicaId}`
        : `peer:${randomUUID()}`;
      const replicaId = [...targetRoom.connections].some((connection) => connection.replicaId === candidateReplicaId)
        ? `peer:${randomUUID()}`
        : candidateReplicaId;
      const connection = {
        ws,
        request,
        accountId: session.accountId,
        username: session.username,
        replicaId,
        boardId,
        room: targetRoom,
        elements: [],
      };
      connection.room.connections.add(connection);
      ws.on('message', (data, isBinary) => handleMessage(connection, data, isBinary));
      ws.once('close', () => removeConnection(connection));
      ws.once('error', () => removeConnection(connection));
      sendJson(ws, { type: 'welcome', replicaId: connection.replicaId, refreshIntervalMs });
      refreshVps(connection.room, true);
    });
  });

  const poll = setInterval(() => {
    for (const room of rooms.values()) {
      for (const connection of room.connections) closeUnauthorized(connection);
      refreshVps(room);
    }
  }, refreshIntervalMs);
  poll.unref?.();
  server.once('close', dispose);
  return Object.freeze({ dispose, publishServerEvent });

  function publishServerEvent(boardId, type, detail = {}) {
    if (!['server-received', 'durable-persisted'].includes(type)) return false;
    const room = rooms.get(boardId);
    const event = {
      type,
      actionId: detail.actionId,
      updateId: detail.updateId,
      updateBytes: detail.updateBytes,
      sequence: detail.sequence,
      observedAt: detail.observedAt,
      committedAt: detail.committedAt,
      sourcePath: detail.sourcePath,
      firstArrivalPath: detail.firstArrivalPath,
    };
    const replicaId = typeof detail.replicaId === 'string' ? detail.replicaId : 'vps';
    history.recordEvent(boardId, replicaId, event);
    if (!room) return true;
    for (const connection of room.connections) {
      if (closeUnauthorized(connection) || connection.ws.readyState !== WebSocket.OPEN) continue;
      sendJson(connection.ws, { type: 'event', replicaId, event });
    }
    return true;
  }

  function getRoom(boardId) {
    let room = rooms.get(boardId);
    if (room) return room;
    room = { boardId, connections: new Set(), vpsElements: [], vpsFingerprint: '' };
    rooms.set(boardId, room);
    return room;
  }

  function isAuthorized(connection) {
    const session = getAuthenticatedSession(connection.request, db);
    return Boolean(session
      && session.accountId === connection.accountId
      && authorizeBoardMembership(db, connection.boardId, session.accountId).status === 'authorized');
  }

  function closeUnauthorized(connection) {
    if (isAuthorized(connection)) return false;
    if (connection.ws.readyState === WebSocket.OPEN) connection.ws.close(1008, 'Board access is no longer authorized');
    return true;
  }

  function handleMessage(connection, data, isBinary) {
    if (closeUnauthorized(connection)) return;
    if (isBinary || data.byteLength > MAX_MESSAGE_BYTES) {
      connection.ws.close(1009, 'Diagnostic message is too large or unsupported');
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      connection.ws.close(1007, 'Invalid diagnostic JSON');
      return;
    }

    if (message?.type === 'snapshot') {
      if (!validElements(message.elements)) {
        connection.ws.close(1008, 'Invalid replica projection');
        return;
      }
      const fingerprint = JSON.stringify(message.elements);
      if (fingerprint !== connection.fingerprint) {
        connection.elements = message.elements;
        connection.fingerprint = fingerprint;
        history.recordSnapshot(connection.boardId, connection.replicaId, connection.elements, {
          sequence: message.sequence,
          clock: message.clock,
        });
      }
      sendRoomState(connection.room);
      return;
    }

    if (message?.type === 'history-list') {
      const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
      const kind = message.kind === 'events' ? 'events' : message.kind === 'snapshots' ? 'snapshots' : null;
      if (!requestId || !kind) {
        sendJson(connection.ws, { type: 'history-error', requestId, error: 'Invalid history query.' });
        return;
      }
      const options = { before: message.before, limit: message.limit, replicaId: message.replicaId };
      const rows = kind === 'snapshots'
        ? history.listSnapshots(connection.boardId, options)
        : history.listEvents(connection.boardId, options);
      sendJson(connection.ws, { type: 'history-page', requestId, kind, rows, nextBefore: rows.length ? rows.at(-1).id : null });
      return;
    }

    if (message?.type === 'history-snapshot') {
      const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
      const snapshotId = Number(message.snapshotId);
      const snapshot = requestId && Number.isSafeInteger(snapshotId) && snapshotId > 0
        ? history.readSnapshot(connection.boardId, snapshotId)
        : null;
      sendJson(connection.ws, { type: 'history-snapshot', requestId, snapshot });
      return;
    }

    // Event metadata is retained within the inspection-history bound and sent
    // to current observers. Raw Yjs update bytes are never accepted or stored.
    if (message?.type === 'event' && validDiagnosticEvent(message.event)) {
      history.recordEvent(connection.boardId, connection.replicaId, message.event);
      const payload = JSON.stringify({
        type: 'event',
        replicaId: connection.replicaId,
        username: connection.username,
        event: message.event,
      });
      for (const recipient of connection.room.connections) {
        if (recipient !== connection && !closeUnauthorized(recipient) && recipient.ws.readyState === WebSocket.OPEN) {
          recipient.ws.send(payload);
        }
      }
      return;
    }

    connection.ws.close(1008, 'Unsupported diagnostic message');
  }

  function validElements(elements) {
    if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS_PER_SNAPSHOT) return false;
    for (const element of elements) {
      if (!element || typeof element !== 'object' || Array.isArray(element)
        || typeof element.id !== 'string' || element.id.length === 0 || element.id.length > 200
        || !ELEMENT_TYPES.has(element.type)
        || !isPlainObject(element.geometry) || !isPlainObject(element.style) || !isPlainObject(element.data)
        || !validGeometry(element.type, element.geometry)
        || (element.style.color !== undefined && (typeof element.style.color !== 'string' || element.style.color.length > 80))
        || (element.style.strokeWidth !== undefined && !finiteInRange(element.style.strokeWidth, 0, 10_000))) return false;
      if (element.type === 'text' && (typeof element.data.text !== 'string' || element.data.text.length > 20_000)) return false;
      if (element.type === 'image' && (typeof element.data.assetId !== 'string' || element.data.assetId.length > 200)) return false;
    }
    return true;
  }

  function validGeometry(type, geometry) {
    const pointValid = (point) => isPlainObject(point)
      && finiteInRange(point.x, -10_000_000, 10_000_000)
      && finiteInRange(point.y, -10_000_000, 10_000_000);
    if (['image', 'rect', 'mux', 'alu'].includes(type)) {
      return finiteInRange(geometry.x, -10_000_000, 10_000_000)
        && finiteInRange(geometry.y, -10_000_000, 10_000_000)
        && finiteInRange(geometry.width, 0, 10_000_000)
        && finiteInRange(geometry.height, 0, 10_000_000);
    }
    if (type === 'path') return Array.isArray(geometry.points)
      && geometry.points.length >= 1 && geometry.points.length <= 50_000
      && geometry.points.every(pointValid);
    if (['line', 'arrow'].includes(type)) return ['x1', 'y1', 'x2', 'y2']
      .every((key) => finiteInRange(geometry[key], -10_000_000, 10_000_000));
    return type === 'text'
      && finiteInRange(geometry.x, -10_000_000, 10_000_000)
      && finiteInRange(geometry.y, -10_000_000, 10_000_000);
  }

  function validDiagnosticEvent(event) {
    if (!isPlainObject(event)) return false;
    const encoded = JSON.stringify(event);
    return Buffer.byteLength(encoded) <= 8_192
      && typeof event.type === 'string'
      && event.type.length > 0
      && !Object.hasOwn(event, 'update')
      && !Object.hasOwn(event, 'bytes')
      && !Object.hasOwn(event, 'updatePayload')
      && (!Object.hasOwn(event, 'updateBytes')
        || Number.isSafeInteger(event.updateBytes) && event.updateBytes >= 0 && event.updateBytes <= MAX_MESSAGE_BYTES);
  }

  function refreshVps(room, force = false) {
    if (disposed || room.connections.size === 0) return;
    let doc;
    try {
      doc = updateStore.loadDocument(room.boardId);
      const elements = readBoardElements(doc);
      const fingerprint = JSON.stringify(elements);
      const changed = fingerprint !== room.vpsFingerprint;
      if (force || changed) {
        room.vpsElements = elements;
        room.vpsFingerprint = fingerprint;
        if (changed) history.recordSnapshot(room.boardId, 'vps', elements);
        sendRoomState(room);
      }
    } catch {
      // A diagnostics refresh must never interfere with the independent sync path.
    } finally {
      doc?.destroy();
    }
  }

  function sendRoomState(room) {
    const payload = JSON.stringify({
      type: 'replicas',
      vps: { replicaId: 'vps', label: 'VPS persistida', elements: room.vpsElements },
      peers: [...room.connections].map((connection) => ({
        replicaId: connection.replicaId,
        username: connection.username,
        elements: connection.elements,
      })),
      projectionOnly: true,
    });
    for (const connection of room.connections) {
      if (!closeUnauthorized(connection) && connection.ws.readyState === WebSocket.OPEN) connection.ws.send(payload);
    }
  }

  function removeConnection(connection) {
    const room = connection.room;
    if (!room.connections.delete(connection)) return;
    if (disposed) return;
    if (room.connections.size === 0) {
      rooms.delete(room.boardId);
      return;
    }
    sendRoomState(room);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(poll);
    for (const client of webSockets.clients) client.terminate();
    rooms.clear();
    webSockets.close();
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function rejectUpgrade(socket, status) {
  socket.write(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function statusText(status) {
  return ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' })[status] ?? 'Error';
}
