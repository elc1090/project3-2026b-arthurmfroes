import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { addElement } from '../src/shared/board-model.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';

async function serve(db) {
  const server = await createAppServer({ db });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function registerAndLogin(baseUrl, username) {
  const password = `${username} secure password`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(registration.status, 201);
  const { account } = await registration.json();
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

async function requestAccess(baseUrl, boardId, cookie) {
  return fetch(`${baseUrl}/api/boards/${boardId}/access-requests`, { method: 'POST', headers: { cookie } });
}

function rejectedSyncStatus(baseUrl, boardId, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/boards/${boardId}/sync`, {
      headers: { cookie },
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      response.resume();
      socket.terminate();
    });
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('Revoked member reconnected to board synchronization'));
    });
    socket.once('error', reject);
  });
}

test('any other member can revoke the creator and advance the board epoch atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-revocation-'));
  const filename = join(directory, 'revocation.sqlite');
  let db = await openDatabase(filename);
  let app = await serve(db);

  try {
    const founder = await registerAndLogin(app.baseUrl, 'founder');
    const member = await registerAndLogin(app.baseUrl, 'member');
    const requester = await registerAndLogin(app.baseUrl, 'requester');
    const board = await createBoard(app.baseUrl, founder.cookie, 'Revocable board');

    const doc = new Y.Doc();
    addElement(doc, {
      id: 'durable-note', type: 'text', geometry: { x: 1, y: 2, width: 100, height: 24 },
      data: { text: 'board content' },
    });
    createBoardUpdateStore(db).persistUpdate({
      updateId: 'revocation-test-update', boardId: board.id, originAccountId: founder.account.id,
      bytes: Y.encodeStateAsUpdate(doc),
    });
    doc.destroy();

    const initialRequest = await requestAccess(app.baseUrl, board.id, member.cookie);
    assert.equal(initialRequest.status, 201);
    const initialAccept = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests/${member.account.id}/accept`, {
      method: 'POST', headers: { cookie: founder.cookie },
    });
    assert.equal(initialAccept.status, 200);

    const membersBefore = await fetch(`${app.baseUrl}/api/boards/${board.id}/members`, { headers: { cookie: member.cookie } });
    assert.deepEqual((await membersBefore.json()).members.map(({ accountId }) => accountId).sort(), [founder.account.id, member.account.id].sort());
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/members`, { headers: { cookie: requester.cookie } })).status, 403);

    const selfRevoke = await fetch(`${app.baseUrl}/api/boards/${board.id}/members/${member.account.id}/revoke`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(selfRevoke.status, 400);
    assert.equal(db.prepare('SELECT epoch FROM boards WHERE id = ?').get(board.id).epoch, 1);

    const revokeFounder = await fetch(`${app.baseUrl}/api/boards/${board.id}/members/${founder.account.id}/revoke`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(revokeFounder.status, 200);
    assert.equal((await revokeFounder.json()).epoch, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE board_id = ? AND account_id = ?').get(board.id, founder.account.id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE board_id = ? AND account_id = ?').get(board.id, member.account.id).count, 1);
    assert.equal(db.prepare('SELECT epoch FROM boards WHERE id = ?').get(board.id).epoch, 2);

    const catalog = await fetch(`${app.baseUrl}/api/boards?search=revocable`, { headers: { cookie: founder.cookie } });
    assert.deepEqual((await catalog.json()).boards, [{ ...board, isMember: false }]);
    const detail = await fetch(`${app.baseUrl}/api/boards/${board.id}`, { headers: { cookie: founder.cookie } });
    assert.deepEqual((await detail.json()).board, { ...board, isMember: false });
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/content`, { headers: { cookie: founder.cookie } })).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/members`, { headers: { cookie: founder.cookie } })).status, 403);
    assert.equal(await rejectedSyncStatus(app.baseUrl, board.id, founder.cookie), 403);

    const pending = await requestAccess(app.baseUrl, board.id, requester.cookie);
    assert.equal(pending.status, 201);
    const revokedAccept = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests/${requester.account.id}/accept`, {
      method: 'POST', headers: { cookie: founder.cookie },
    });
    assert.equal(revokedAccept.status, 403, 'the revoked creator cannot approve a later request');

    await app.close();
    db.close();
    db = await openDatabase(filename);
    app = await serve(db);

    assert.equal(db.prepare('SELECT epoch FROM boards WHERE id = ?').get(board.id).epoch, 2);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/content`, { headers: { cookie: founder.cookie } })).status, 403);
    assert.equal(await rejectedSyncStatus(app.baseUrl, board.id, founder.cookie), 403);
    const founderCatalogAfterRestart = await fetch(`${app.baseUrl}/api/boards`, { headers: { cookie: founder.cookie } });
    assert.deepEqual((await founderCatalogAfterRestart.json()).boards, [{ ...board, isMember: false }]);
    const stillPending = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests`, { headers: { cookie: member.cookie } });
    assert.equal((await stillPending.json()).requests[0].accountId, requester.account.id);

    const memberAccept = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests/${requester.account.id}/accept`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(memberAccept.status, 200, 'a remaining member can accept after restart');
    const requesterContent = await fetch(`${app.baseUrl}/api/boards/${board.id}/content`, { headers: { cookie: requester.cookie } });
    assert.equal((await requesterContent.json()).elements[0].data.text, 'board content');
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/content`, { headers: { cookie: founder.cookie } })).status, 403);
  } finally {
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
