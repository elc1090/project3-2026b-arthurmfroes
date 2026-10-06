import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import * as Y from 'yjs';
import { addElement, readBoardElements } from '../src/shared/board-model.js';
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
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(register.status, 201);
  const { account } = await register.json();
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  return { account, cookie: login.headers.get('set-cookie').split(';')[0] };
}

async function createBoard(baseUrl, cookie, title) {
  const response = await fetch(`${baseUrl}/api/boards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).board;
}

function updateWithElement(id, label) {
  const doc = new Y.Doc();
  addElement(doc, {
    id,
    type: 'text',
    geometry: { x: 10, y: 20, width: 120, height: 30 },
    data: { text: label },
  });
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

test('board links, membership, catalog search, and Yjs content stay isolated across SQLite restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-boards-'));
  const filename = join(directory, 'boards.sqlite');
  let db = await openDatabase(filename);
  let app = await serve(db);

  try {
    const alice = await registerAndLogin(app.baseUrl, 'alice');
    const bob = await registerAndLogin(app.baseUrl, 'bob');
    const boardA = await createBoard(app.baseUrl, alice.cookie, 'Alice Architecture');
    const boardB = await createBoard(app.baseUrl, bob.cookie, 'Bob Datapath');

    assert.notEqual(boardA.id, boardB.id);
    assert.equal(boardA.href, `/boards/${boardA.id}`);
    assert.equal(boardB.href, `/boards/${boardB.id}`);
    assert.deepEqual(db.prepare('SELECT account_id FROM memberships WHERE board_id = ?').all(boardA.id), [{ account_id: alice.account.id }]);
    assert.deepEqual(db.prepare('SELECT account_id FROM memberships WHERE board_id = ?').all(boardB.id), [{ account_id: bob.account.id }]);

    const search = await fetch(`${app.baseUrl}/api/boards?search=datapath`, { headers: { cookie: alice.cookie } });
    assert.deepEqual((await search.json()).boards, [{ ...boardB, isMember: false }]);

    const directPage = await fetch(`${app.baseUrl}${boardB.href}`, { headers: { cookie: alice.cookie } });
    assert.equal(directPage.status, 200);
    assert.match(await directPage.text(), /board-detail/);
    const directMetadata = await fetch(`${app.baseUrl}/api/boards/${boardB.id}`, { headers: { cookie: alice.cookie } });
    assert.deepEqual((await directMetadata.json()).board, { ...boardB, isMember: false });
    const deniedContent = await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: alice.cookie } });
    assert.equal(deniedContent.status, 403);

    const updateStore = createBoardUpdateStore(db);
    const elementA = 'alice-element';
    const elementB = 'bob-element';
    updateStore.persistUpdate({
      updateId: 'alice-update', boardId: boardA.id, originAccountId: alice.account.id,
      bytes: updateWithElement(elementA, 'Alice content'),
    });
    updateStore.persistUpdate({
      updateId: 'bob-update', boardId: boardB.id, originAccountId: bob.account.id,
      bytes: updateWithElement(elementB, 'Bob content'),
    });

    await app.close();
    db.close();
    db = await openDatabase(filename);
    app = await serve(db);

    const recoveredA = await fetch(`${app.baseUrl}/api/boards/${boardA.id}/content`, { headers: { cookie: alice.cookie } });
    assert.deepEqual((await recoveredA.json()).elements, [
      { id: elementA, type: 'text', geometry: { x: 10, y: 20, width: 120, height: 30 }, style: {}, data: { text: 'Alice content' } },
    ]);
    const recoveredB = await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: bob.cookie } });
    assert.deepEqual((await recoveredB.json()).elements, [
      { id: elementB, type: 'text', geometry: { x: 10, y: 20, width: 120, height: 30 }, style: {}, data: { text: 'Bob content' } },
    ]);

    const catalogAfterRestart = await fetch(`${app.baseUrl}/api/boards`, { headers: { cookie: alice.cookie } });
    assert.deepEqual((await catalogAfterRestart.json()).boards, [
      { ...boardA, isMember: true },
      { ...boardB, isMember: false },
    ]);
    const stillDenied = await fetch(`${app.baseUrl}/api/boards/${boardB.id}/content`, { headers: { cookie: alice.cookie } });
    assert.equal(stillDenied.status, 403);

    const recoveredStore = createBoardUpdateStore(db);
    const docA = recoveredStore.loadDocument(boardA.id);
    const docB = recoveredStore.loadDocument(boardB.id);
    try {
      assert.deepEqual(readBoardElements(docA).map(({ id }) => id), [elementA]);
      assert.deepEqual(readBoardElements(docB).map(({ id }) => id), [elementB]);
    } finally {
      docA.destroy();
      docB.destroy();
    }
  } finally {
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
