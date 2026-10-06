import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { getAuthenticatedSession } from './auth.js';
import { authorizeBoardMembership } from './boards.js';

const SYNC_PATH = /^\/api\/boards\/([^/]+)\/sync$/;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_UPDATE_BYTES = 3 * 1024 * 1024;

/** Attach the authenticated per-board Yjs WebSocket endpoint to the app server. */
export function attachBoardSync(server, { db, updateStore, onSyncEvent = () => {} }) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const replicas = new Map();
  const replicaId = `vps:${randomUUID()}`;
  let eventSequence = 0;
  let disposed = false;

  function emitSyncEvent(type, detail) {
    eventSequence += 1;
    try {
      onSyncEvent(type, {
        boardId: detail.boardId,
        replicaId,
        sequence: eventSequence,
        observedAt: new Date().toISOString(),
        ...detail,
      });
    } catch {
      // Diagnostics must not change persistence or acknowledgement behavior.
    }
  }

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }

    const match = url.pathname.match(SYNC_PATH);
    // Unknown upgrade paths belong to sibling protocol handlers (for example,
    // signaling). The app-level dispatcher must reject any path no handler claims.
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

    let replica;
    try {
      replica = getReplica(boardId);
    } catch {
      rejectUpgrade(socket, 500);
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (ws) => {
      const connection = { ws, request, accountId: session.accountId, boardId, replica };
      replica.connections.add(connection);
      ws.on('message', (data, isBinary) => handleMessage(connection, data, isBinary));
      ws.once('close', () => replica.connections.delete(connection));
      ws.once('error', () => replica.connections.delete(connection));
    });
  });

  server.once('close', dispose);
  return dispose;

  function getReplica(boardId) {
    let replica = replicas.get(boardId);
    if (replica) return replica;
    const doc = updateStore.loadDocument(boardId);
    replica = { doc, connections: new Set() };
    replicas.set(boardId, replica);
    return replica;
  }

  function isAuthorized(connection) {
    const session = getAuthenticatedSession(connection.request, db);
    if (!session || session.accountId !== connection.accountId) return false;
    return authorizeBoardMembership(db, connection.boardId, session.accountId).status === 'authorized';
  }

  function closeIfUnauthorized(connection) {
    if (isAuthorized(connection)) return false;
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(1008, 'Board access is no longer authorized');
    }
    return true;
  }

  function handleMessage(connection, data, isBinary) {
    if (closeIfUnauthorized(connection)) return;
    if (isBinary || data.byteLength > MAX_MESSAGE_BYTES) {
      connection.ws.close(1009, 'Message is too large or has an unsupported format');
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      connection.ws.close(1007, 'Invalid JSON message');
      return;
    }

    try {
      if (message?.type === 'sync') {
        handleSyncRequest(connection, message);
        return;
      }
      if (message?.type === 'update') {
        handleUpdate(connection, message);
        return;
      }
      sendJson(connection.ws, { type: 'error', error: 'Unsupported board sync message.' });
    } catch (error) {
      sendJson(connection.ws, {
        type: 'error',
        code: error.code ?? 'INVALID_MESSAGE',
        error: error.code === 'UPDATE_ID_CONFLICT'
          ? 'This update ID is already used for different content.'
          : 'The board sync message could not be applied.',
      });
    }
  }

  function handleSyncRequest(connection, message) {
    const clientStateVector = decodeBytes(message.stateVector, 'stateVector', 64 * 1024);
    const serverStateVector = Y.encodeStateVector(connection.replica.doc);
    const update = Y.encodeStateAsUpdate(connection.replica.doc, clientStateVector);
    sendJson(connection.ws, {
      type: 'sync',
      stateVector: encodeBytes(serverStateVector),
      update: encodeBytes(update),
    });
  }

  function handleUpdate(connection, message) {
    if (typeof message.updateId !== 'string' || message.updateId.length === 0 || message.updateId.length > 200) {
      throw new TypeError('updateId must be a non-empty string');
    }
    const bytes = decodeBytes(message.update, 'update', MAX_UPDATE_BYTES);
    const replica = connection.replica;

    validateUpdate(replica.doc, bytes);
    const actionId = updateDigest(bytes);
    emitSyncEvent('server-received', {
      boardId: connection.boardId,
      actionId,
      updateId: message.updateId,
      updateBytes: bytes.byteLength,
      sourcePath: 'client',
      firstArrivalPath: 'client',
    });
    const ack = updateStore.persistUpdate({
      updateId: message.updateId,
      boardId: connection.boardId,
      originAccountId: connection.accountId,
      bytes,
    });
    emitSyncEvent('durable-persisted', {
      boardId: ack.boardId,
      actionId,
      updateId: ack.updateId,
      updateBytes: bytes.byteLength,
      committedAt: ack.committedAt,
      sourcePath: 'sqlite',
      firstArrivalPath: 'client',
    });

    // The store's ACK means bytes are committed; only then change the live replica.
    Y.applyUpdate(replica.doc, bytes, connection);
    broadcastUpdate(connection, message.updateId, actionId, bytes);
    sendJson(connection.ws, {
      type: 'durable-ack',
      boardId: ack.boardId,
      updateId: ack.updateId,
      actionId,
      committedAt: ack.committedAt,
    });
  }

  function validateUpdate(doc, bytes) {
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(candidate, bytes);
    } finally {
      candidate.destroy();
    }
  }

  function broadcastUpdate(sender, updateId, actionId, bytes) {
    const payload = {
      type: 'update',
      updateId,
      actionId,
      update: encodeBytes(bytes),
    };
    const serialized = JSON.stringify(payload);
    for (const connection of sender.replica.connections) {
      if (connection === sender) continue;
      if (closeIfUnauthorized(connection)) continue;
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(serialized);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const client of webSockets.clients) client.terminate();
    for (const replica of replicas.values()) replica.doc.destroy();
    replicas.clear();
    webSockets.close();
  }
}

function updateDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function encodeBytes(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be base64 bytes`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${label} must be valid base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maximumBytes) {
    const error = new RangeError(`${label} exceeds the allowed size`);
    error.code = 'MESSAGE_TOO_LARGE';
    throw error;
  }
  return new Uint8Array(bytes);
}

function rejectUpgrade(socket, status) {
  const statusText = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }[status];
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
