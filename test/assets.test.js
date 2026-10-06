import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import * as Y from 'yjs';
import { addElement, readBoardElements } from '../src/shared/board-model.js';
import { createAppServer, openDatabase } from '../src/server/main.js';
import { MAX_IMAGE_BYTES } from '../src/server/assets.js';

async function serve(db, assetStorageDirectory) {
  const server = await createAppServer({ db, assetStorageDirectory });
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

test('board image assets use binary storage, asset IDs, and membership-gated upload/download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-assets-'));
  const db = await openDatabase(join(directory, 'assets.sqlite'));
  let app;
  try {
    app = await serve(db, join(directory, 'asset-files'));
    const owner = await registerAndLogin(app.baseUrl, 'asset-owner');
    const member = await registerAndLogin(app.baseUrl, 'asset-member');
    const outsider = await registerAndLogin(app.baseUrl, 'asset-outsider');
    const otherOwner = await registerAndLogin(app.baseUrl, 'asset-other');
    const board = await createBoard(app.baseUrl, owner.cookie, 'Image board');
    const otherBoard = await createBoard(app.baseUrl, otherOwner.cookie, 'Other image board');

    const accessRequest = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(accessRequest.status, 201);
    const accepted = await fetch(`${app.baseUrl}/api/boards/${board.id}/access-requests/${member.account.id}/accept`, {
      method: 'POST', headers: { cookie: owner.cookie },
    });
    assert.equal(accepted.status, 200);

    const imageBytes = await readFile(new URL('../whiteboard/templates/completo_multi_fsm_10_estados.png', import.meta.url));
    const upload = await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: imageBytes,
    });
    assert.equal(upload.status, 201);
    const { asset } = await upload.json();
    assert.equal(asset.byteLength, imageBytes.length);
    assert.equal(asset.mimeType, 'image/png');
    assert.match(asset.assetId, /^[0-9a-f-]{36}$/i);
    assert.equal(asset.href, `/api/boards/${board.id}/assets/${asset.assetId}`);
    assert.equal(upload.headers.get('cache-control'), 'no-store');
    assert.equal(db.prepare('SELECT byte_length AS byteLength FROM assets WHERE id = ?').get(asset.assetId).byteLength, imageBytes.length);

    const ownerDownload = await fetch(`${app.baseUrl}${asset.href}`, { headers: { cookie: owner.cookie } });
    assert.equal(ownerDownload.status, 200);
    assert.equal(ownerDownload.headers.get('content-type'), 'image/png');
    assert.equal(ownerDownload.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()), imageBytes);
    const memberDownload = await fetch(`${app.baseUrl}${asset.href}`, { headers: { cookie: member.cookie } });
    assert.equal(memberDownload.status, 200);
    assert.deepEqual(Buffer.from(await memberDownload.arrayBuffer()), imageBytes);

    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: imageBytes,
    })).status, 401);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { cookie: outsider.cookie, 'content-type': 'image/png' }, body: imageBytes,
    })).status, 403);
    assert.equal((await fetch(`${app.baseUrl}${asset.href}`, { headers: { cookie: outsider.cookie } })).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${otherBoard.id}/assets/${asset.assetId}`, {
      headers: { cookie: otherOwner.cookie },
    })).status, 404, 'an asset ID is scoped to its board');

    const badSignature = await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: Buffer.from('not a PNG'),
    });
    assert.equal(badSignature.status, 415);
    const wrongMime = await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/svg+xml' }, body: imageBytes,
    });
    assert.equal(wrongMime.status, 415);
    const tooLarge = await fetch(`${app.baseUrl}/api/boards/${board.id}/assets`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' },
      body: Buffer.concat([imageBytes, Buffer.alloc(MAX_IMAGE_BYTES)]),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);

    const doc = new Y.Doc();
    try {
      assert.throws(() => addElement(doc, {
        id: 'inline-image', type: 'image', geometry: { x: 0, y: 0, width: 1, height: 1 },
        data: { dataUrl: 'data:image/png;base64,AA==' },
      }), /assetId/);
      addElement(doc, {
        id: 'asset-image', type: 'image', geometry: { x: 25, y: 40, width: 300, height: 200 },
        data: { assetId: asset.assetId, mimeType: asset.mimeType },
      });
      const elements = readBoardElements(doc);
      assert.deepEqual(elements[0], {
        id: 'asset-image', type: 'image',
        geometry: { x: 25, y: 40, width: 300, height: 200 },
        style: {}, data: { assetId: asset.assetId, mimeType: 'image/png' },
      });
      assert.throws(() => addElement(doc, {
        id: 'inline-image-2', type: 'image', geometry: { x: 0, y: 0, width: 1, height: 1 },
        data: { assetId: asset.assetId, bytes: [0x89, 0x50] },
      }), /inline image bytes/);
    } finally {
      doc.destroy();
    }

    const revokeOwner = await fetch(`${app.baseUrl}/api/boards/${board.id}/members/${owner.account.id}/revoke`, {
      method: 'POST', headers: { cookie: member.cookie },
    });
    assert.equal(revokeOwner.status, 200);
    assert.equal((await fetch(`${app.baseUrl}${asset.href}`, { headers: { cookie: owner.cookie } })).status, 403);
    assert.equal((await fetch(`${app.baseUrl}${asset.href}`, { headers: { cookie: member.cookie } })).status, 200);
  } finally {
    if (app) await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
