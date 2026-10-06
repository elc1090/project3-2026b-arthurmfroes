import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import * as Y from 'yjs';
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

function createBoardUpdate(elementId, text) {
  const doc = new Y.Doc();
  addElement(doc, {
    id: elementId,
    type: 'text',
    geometry: { x: 1, y: 2, width: 100, height: 24 },
    data: { text },
  });
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

test('nonmember access requests stay pending until a non-creator member accepts them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-access-'));
  const filename = join(directory, 'access.sqlite');
  let db = await openDatabase(filename);
  let app = await serve(db);

  try {
    const alice = await registerAndLogin(app.baseUrl, 'alice');
    const bob = await registerAndLogin(app.baseUrl, 'bob');
    const charlie = await registerAndLogin(app.baseUrl, 'charlie');
    const boardA = await createBoard(app.baseUrl, alice.cookie, 'Shared architecture');
    const boardB = await createBoard(app.baseUrl, bob.cookie, 'Private datapath');

    const store = createBoardUpdateStore(db);
    store.persistUpdate({
      updateId: 'board-a-content', boardId: boardA.id, originAccountId: alice.account.id,
      bytes: createBoardUpdate('architecture-note', 'A content'),
    });
    store.persistUpdate({
      updateId: 'board-b-content', boardId: boardB.id, originAccountId: bob.account.id,
      bytes: createBoardUpdate('datapath-note', 'B content'),
    });

    const discovered = await fetch(`${app.baseUrl}/api/boards?search=architecture`, { headers: { cookie: charlie.cookie } });
    assert.deepEqual((await discovered.json()).boards, [{ ...boardA, isMember: false }]);
    const directPage = await fetch(`${app.baseUrl}${boardA.href}`, { headers: { cookie: charlie.cookie } });
    assert.equal(directPage.status, 200);
    assert.match(await directPage.text(), /Solicitar acesso/);
    const metadata = await fetch(`${app.baseUrl}/api/boards/${boardA.id}`, { headers: { cookie: charlie.cookie } });
    assert.deepEqual((await metadata.json()).board, { ...boardA, isMember: false });
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: charlie.cookie } })).status, 403);

    const bobRequest = await requestAccess(app.baseUrl, boardA.id, bob.cookie);
    assert.equal(bobRequest.status, 201);
    assert.equal((await bobRequest.json()).pending, true);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: bob.cookie } })).status, 403);
    const alicePending = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests`, { headers: { cookie: alice.cookie } });
    const aliceRequests = (await alicePending.json()).requests;
    assert.equal(aliceRequests.length, 1);
    assert.equal(aliceRequests[0].accountId, bob.account.id);
    assert.equal(aliceRequests[0].username, 'bob');
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests`, { headers: { cookie: bob.cookie } })).status, 403);

    const acceptBob = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests/${bob.account.id}/accept`, {
      method: 'POST', headers: { cookie: alice.cookie },
    });
    assert.equal(acceptBob.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE board_id = ? AND account_id = ?').get(boardA.id, bob.account.id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_requests WHERE board_id = ? AND account_id = ?').get(boardA.id, bob.account.id).count, 0);
    const bobContent = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: bob.cookie } });
    assert.equal((await bobContent.json()).elements[0].data.text, 'A content');

    const charlieRequest = await requestAccess(app.baseUrl, boardA.id, charlie.cookie);
    assert.equal(charlieRequest.status, 201);
    const pendingState = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-request`, { headers: { cookie: charlie.cookie } });
    assert.deepEqual(await pendingState.json(), { pending: true });
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: charlie.cookie } })).status, 403);

    const acceptCharlie = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/access-requests/${charlie.account.id}/accept`, {
      method: 'POST', headers: { cookie: bob.cookie },
    });
    assert.equal(acceptCharlie.status, 200, 'a current member who did not create the board can accept the request');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE board_id = ? AND account_id = ?').get(boardA.id, charlie.account.id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_requests WHERE board_id = ? AND account_id = ?').get(boardA.id, charlie.account.id).count, 0);

    const charlieContent = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: charlie.cookie } });
    assert.equal((await charlieContent.json()).elements[0].data.text, 'A content');
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: charlie.cookie } })).status, 403);
    const bobBoardContent = await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: bob.cookie } });
    assert.equal((await bobBoardContent.json()).elements[0].data.text, 'B content');

    await app.close();
    db.close();
    db = await openDatabase(filename);
    app = await serve(db);
    const afterRestart = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: charlie.cookie } });
    assert.equal((await afterRestart.json()).elements[0].data.text, 'A content');
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: charlie.cookie } })).status, 403);
  } finally {
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
