import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createAppServer, openDatabase } from '../src/server/main.js';

async function listen(db) {
  const server = await createAppServer({ db, signalingState: undefined });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await server.signaling.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function register(baseUrl, username) {
  const password = `${username} secure password`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 201);
  const account = (await response.json()).account;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  return { account, cookie: login.headers.get('set-cookie').split(';')[0] };
}

async function createBoard(baseUrl, cookie, title) {
  const response = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).board;
}

async function requestSignaling(baseUrl, boardId, cookie) {
  const response = await fetch(`${baseUrl}/api/boards/${boardId}/signaling`, { headers: { cookie } });
  return { response, body: await response.json() };
}

async function connect(baseUrl, cookie) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/signaling`, { headers: { cookie } });
  await once(socket, 'open');
  return socket;
}

function nextMessage(socket) {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
}

async function sendAndRead(socket, message) {
  const result = nextMessage(socket);
  socket.send(JSON.stringify(message));
  return result;
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

test('private signaling checks sessions, membership, board isolation, and board epochs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-signaling-'));
  const db = await openDatabase(join(directory, 'signaling.sqlite'));
  let app;
  const sockets = [];
  try {
    app = await listen(db);
    const founder = await register(app.baseUrl, 'signal-founder');
    const member = await register(app.baseUrl, 'signal-member');
    const outsider = await register(app.baseUrl, 'signal-outsider');
    const boardA = await createBoard(app.baseUrl, founder.cookie, 'Signal A');
    const boardB = await createBoard(app.baseUrl, founder.cookie, 'Signal B');

    const access = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(access.status, 201);
    const accepted = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests/${member.account.id}/accept`, {
      method: 'POST', headers: { cookie: founder.cookie },
    });
    assert.equal(accepted.status, 200);

    const founderA = await requestSignaling(app.baseUrl, boardA.id, founder.cookie);
    const memberA = await requestSignaling(app.baseUrl, boardA.id, member.cookie);
    const founderB = await requestSignaling(app.baseUrl, boardB.id, founder.cookie);
    assert.equal(founderA.response.status, 200);
    assert.deepEqual(memberA.body, founderA.body, 'members receive the same room and password for the current board epoch');
    assert.equal(founderB.response.status, 200);
    assert.notEqual(founderA.body.topic, founderB.body.topic, 'different boards receive isolated topics');
    assert.equal((await requestSignaling(app.baseUrl, boardA.id, outsider.cookie)).response.status, 403);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardA.id}/signaling`)).status, 401);

    const founderSocket = await connect(app.baseUrl, founder.cookie);
    const memberSocket = await connect(app.baseUrl, member.cookie);
    const outsiderSocket = await connect(app.baseUrl, outsider.cookie);
    sockets.push(founderSocket, memberSocket, outsiderSocket);

    const unauthenticatedSocket = new WebSocket(`${app.baseUrl.replace(/^http/, 'ws')}/api/signaling`);
    unauthenticatedSocket.on('error', () => {});
    const [, unauthorizedResponse] = await once(unauthenticatedSocket, 'unexpected-response');
    assert.equal(unauthorizedResponse.statusCode, 401, 'the signaling websocket requires a valid session');
    unauthenticatedSocket.terminate();

    assert.deepEqual(await sendAndRead(founderSocket, { type: 'subscribe', topics: [founderA.body.topic] }), {
      type: 'subscribed', topics: [founderA.body.topic],
    });
    assert.deepEqual(await sendAndRead(memberSocket, { type: 'subscribe', topics: [memberA.body.topic] }), {
      type: 'subscribed', topics: [memberA.body.topic],
    });
    assert.equal((await sendAndRead(outsiderSocket, { type: 'subscribe', topics: [founderA.body.topic] })).error, 'not_member');
    assert.equal((await sendAndRead(outsiderSocket, {
      type: 'publish', topic: founderA.body.topic, data: { type: 'announce', from: 'outsider' },
    })).error, 'not_subscribed');

    const peerSignal = nextMessage(memberSocket);
    const ownSignal = nextMessage(founderSocket);
    founderSocket.send(JSON.stringify({
      type: 'publish', topic: founderA.body.topic, data: { type: 'announce', from: 'founder' },
    }));
    assert.equal((await peerSignal).data.from, 'founder');
    assert.equal((await ownSignal).data.from, 'founder');

    assert.deepEqual(await sendAndRead(founderSocket, { type: 'subscribe', topics: [founderB.body.topic] }), {
      type: 'subscribed', topics: [founderB.body.topic],
    });
    const receivedTopics = [];
    memberSocket.on('message', (data) => receivedTopics.push(JSON.parse(data.toString()).topic));
    const founderBoardBSignal = nextMessage(founderSocket);
    founderSocket.send(JSON.stringify({
      type: 'publish', topic: founderB.body.topic, data: { type: 'announce', from: 'founder' },
    }));
    assert.equal((await founderBoardBSignal).topic, founderB.body.topic);
    await delay(50);
    assert.deepEqual(receivedTopics, [], 'board B signaling is not delivered to a board A subscriber');

    const revoke = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/members/${founder.account.id}/revoke`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).epoch, 2);

    assert.equal((await sendAndRead(memberSocket, {
      type: 'publish', topic: memberA.body.topic, data: { type: 'announce', from: 'member' },
    })).error, 'stale_epoch', 'a remaining member cannot signal on the old epoch');
    assert.equal((await sendAndRead(founderSocket, {
      type: 'publish', topic: founderA.body.topic, data: { type: 'announce', from: 'founder' },
    })).error, 'not_member', 'a revoked account cannot publish on its old epoch');

    const nextMemberA = await requestSignaling(app.baseUrl, boardA.id, member.cookie);
    assert.equal(nextMemberA.response.status, 200);
    assert.equal(nextMemberA.body.epoch, 2);
    assert.notEqual(nextMemberA.body.topic, memberA.body.topic);
    assert.equal((await sendAndRead(memberSocket, {
      type: 'subscribe', topics: [memberA.body.topic],
    })).error, 'unknown_topic', 'the old room is no longer available');
    assert.equal((await sendAndRead(founderSocket, {
      type: 'subscribe', topics: [nextMemberA.body.topic],
    })).error, 'not_member', 'the revoked account cannot subscribe to the new epoch');
    assert.equal((await sendAndRead(founderSocket, {
      type: 'publish', topic: nextMemberA.body.topic, data: { type: 'announce', from: 'founder' },
    })).error, 'not_subscribed');
    assert.equal((await sendAndRead(founderSocket, {
      type: 'publish', topic: memberA.body.topic, data: { type: 'announce', from: 'founder' },
    })).error, 'not_subscribed');
  } finally {
    for (const socket of sockets) await closeSocket(socket);
    if (app) await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
