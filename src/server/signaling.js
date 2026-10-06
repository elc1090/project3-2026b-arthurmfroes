import { createHmac, randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { getAuthenticatedSession } from './auth.js';

const SIGNALING_PATH = '/api/signaling';
const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readBoardAccess(db, boardId, accountId) {
  return db.prepare(`
    SELECT boards.epoch,
      EXISTS(SELECT 1 FROM memberships WHERE board_id = boards.id AND account_id = ?) AS is_member
    FROM boards WHERE boards.id = ?
  `).get(accountId, boardId);
}

function authError(response, status, message) {
  sendJson(response, status, { error: message });
  return true;
}

export function createSignalingState(secret = randomBytes(32)) {
  return { secret, rooms: new Map(), boardTopics: new Map() };
}

function roomMaterial(state, boardId, epoch) {
  const input = `${boardId}:${epoch}`;
  const topic = `t3-${createHmac('sha256', state.secret).update(`topic:${input}`).digest('base64url')}`;
  const password = createHmac('sha256', state.secret).update(`password:${input}`).digest('base64url');
  return { topic, password };
}

export function handleSignalingHttpRequest(request, response, db, state) {
  const url = new URL(request.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/signaling$/);
  if (!match) return false;
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' }).end();
    return true;
  }

  let boardId;
  try {
    boardId = decodeURIComponent(match[1]);
  } catch {
    return authError(response, 400, 'ID de quadro inválido.');
  }
  const session = getAuthenticatedSession(request, db);
  if (!session) return authError(response, 401, 'Entre na sua conta para sinalizar.');
  const access = readBoardAccess(db, boardId, session.accountId);
  if (!access) return authError(response, 404, 'Quadro não encontrado.');
  if (!access.is_member) return authError(response, 403, 'Você não é membro deste quadro.');

  const { topic, password } = roomMaterial(state, boardId, access.epoch);
  const previousTopic = state.boardTopics.get(boardId);
  if (previousTopic && previousTopic !== topic) state.rooms.delete(previousTopic);
  state.boardTopics.set(boardId, topic);
  state.rooms.set(topic, { boardId, epoch: access.epoch });
  sendJson(response, 200, { topic, password, epoch: access.epoch });
  return true;
}

function sendSocketError(socket, error, topic) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'error', error, ...(topic ? { topic } : {}) }));
}

function removeTopic(socket, topic) {
  socket.topics.delete(topic);
  const subscribers = socket.serverState.subscribers.get(topic);
  if (subscribers) {
    subscribers.delete(socket);
    if (subscribers.size === 0) socket.serverState.subscribers.delete(topic);
  }
}

function removeSocket(socket) {
  for (const topic of [...socket.topics]) removeTopic(socket, topic);
}

function currentMembership(socket, room) {
  const session = getAuthenticatedSession(socket.signalingRequest, socket.serverState.db);
  if (!session) return { status: 'session_expired' };
  const access = readBoardAccess(socket.serverState.db, room.boardId, session.accountId);
  if (!access) return { status: 'board_missing' };
  if (!access.is_member) return { status: 'not_member' };
  if (access.epoch !== room.epoch) return { status: 'stale_epoch' };
  return { status: 'authorized' };
}

function topicAuthorization(socket, topic) {
  const room = socket.serverState.state.rooms.get(topic);
  if (!room) return { status: 'unknown_topic' };
  return { ...currentMembership(socket, room), room };
}

function dispatchMessage(socket, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    sendSocketError(socket, 'invalid_message');
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    sendSocketError(socket, 'invalid_message');
    return;
  }

  if (message.type === 'ping') {
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (message.type === 'unsubscribe') {
    for (const topic of Array.isArray(message.topics) ? message.topics : []) {
      if (typeof topic === 'string') removeTopic(socket, topic);
    }
    return;
  }
  if (message.type === 'subscribe') {
    const topics = Array.isArray(message.topics) ? message.topics : [];
    if (topics.length > 32) {
      sendSocketError(socket, 'too_many_topics');
      return;
    }
    const accepted = [];
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      const auth = topicAuthorization(socket, topic);
      if (auth.status !== 'authorized') {
        sendSocketError(socket, auth.status, topic);
        continue;
      }
      socket.topics.add(topic);
      const subscribers = socket.serverState.subscribers.get(topic) ?? new Set();
      subscribers.add(socket);
      socket.serverState.subscribers.set(topic, subscribers);
      accepted.push(topic);
    }
    if (accepted.length > 0) socket.send(JSON.stringify({ type: 'subscribed', topics: accepted }));
    return;
  }
  if (message.type === 'publish') {
    const topic = message.topic;
    if (typeof topic !== 'string' || !socket.topics.has(topic)) {
      sendSocketError(socket, 'not_subscribed', typeof topic === 'string' ? topic : undefined);
      return;
    }
    const auth = topicAuthorization(socket, topic);
    if (auth.status !== 'authorized') {
      removeTopic(socket, topic);
      sendSocketError(socket, auth.status, topic);
      return;
    }
    const data = message.data;
    const isSignalObject = data && typeof data === 'object' && ['announce', 'signal'].includes(data.type);
    const isEncryptedSignal = typeof data === 'string' && /^[A-Za-z0-9_+\/=.-]+$/.test(data);
    if (!isSignalObject && !isEncryptedSignal) {
      sendSocketError(socket, 'invalid_signal', topic);
      return;
    }

    const subscribers = socket.serverState.subscribers.get(topic);
    if (!subscribers) return;
    const forwarded = JSON.stringify({ ...message, clients: subscribers.size });
    for (const receiver of [...subscribers]) {
      const receiverAuth = topicAuthorization(receiver, topic);
      if (receiverAuth.status !== 'authorized') {
        removeTopic(receiver, topic);
        sendSocketError(receiver, receiverAuth.status, topic);
        continue;
      }
      if (receiver.readyState === WebSocket.OPEN) receiver.send(forwarded);
    }
    return;
  }
  sendSocketError(socket, 'unsupported_message');
}

export function attachSignaling(server, db, state = createSignalingState()) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNALING_MESSAGE_BYTES, perMessageDeflate: false });
  const subscribers = new Map();
  const socketServerState = { db, state, subscribers };

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== SIGNALING_PATH) return;

    if (!getAuthenticatedSession(request, db)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      client.signalingRequest = request;
      client.serverState = socketServerState;
      client.topics = new Set();
      client.on('message', (data) => dispatchMessage(client, data));
      client.on('close', () => removeSocket(client));
      client.on('error', () => removeSocket(client));
      wss.emit('connection', client, request);
    });
  });

  return {
    state,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.close();
      wss.close(resolve);
    }),
  };
}
