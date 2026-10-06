import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const templatePath = join(root, 'whiteboard/templates/completo_multi_fsm_10_estados.png');
const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pending board image test</title></head>
<body>
  <input id="image-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
  <canvas id="preview" width="800" height="480"></canvas>
  <p id="status"></p>
  <script type="module">
    import * as api from '/pending-board-images.bundle.js';
    const boardId = new URL(location.href).searchParams.get('boardId');
    window.__session = await api.openBoardSession(boardId, { initialPeerPaused: true });
    window.__pending = [];
    window.__unsubscribe = await api.subscribePendingBoardImages(boardId, records => { window.__pending = records; });
    window.__insertFromFile = async (file) => {
      const dimensions = await api.readImageDimensions(file);
      const geometry = api.fileImageGeometry({
        imageWidth: dimensions.width, imageHeight: dimensions.height,
        canvasWidth: 800, centerX: 400, centerY: 240,
      });
      try {
        const asset = await api.uploadBoardImage(boardId, file);
        const id = crypto.randomUUID();
        api.addImageAssetReference(window.__session.doc, {
          asset, geometry,
          intrinsicWidth: dimensions.width, intrinsicHeight: dimensions.height,
          idFactory: () => id,
        });
        return { uploaded: true, elementId: id, geometry };
      } catch (error) {
        if (!api.shouldQueuePendingImage(error)) throw error;
        const pending = await api.enqueuePendingBoardImage(boardId, {
          file, geometry,
          intrinsicWidth: dimensions.width,
          intrinsicHeight: dimensions.height,
          elementId: crypto.randomUUID(),
        });
        return { uploaded: false, pendingId: pending.pendingId, geometry };
      }
    };
    window.__drawPendingPreview = async () => {
      const pending = window.__pending[0];
      if (!pending) return null;
      const canvas = document.querySelector('#preview');
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      const bitmap = await createImageBitmap(pending.blob);
      context.drawImage(bitmap, pending.geometry.x, pending.geometry.y, pending.geometry.width, pending.geometry.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let visiblePixels = 0;
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) visiblePixels += 1;
      bitmap.close();
      return { visiblePixels, geometry: pending.geometry, width: bitmap.width, height: bitmap.height };
    };
    window.__publishPending = () => api.publishPendingBoardImages(boardId, {
      upload: pending => api.uploadBoardImage(boardId, pending.blob),
      publish: ({ pending, asset }) => {
        const exists = api.getBoardMaps(window.__session.doc).elements.has(pending.elementId);
        const existing = exists ? api.readElement(window.__session.doc, pending.elementId) : null;
        if (existing) {
          if (existing.data.assetId !== asset.assetId) throw new Error('Pending image ID already has a different asset');
          return;
        }
        api.addImageAssetReference(window.__session.doc, {
          asset,
          geometry: pending.geometry,
          intrinsicWidth: pending.intrinsicWidth,
          intrinsicHeight: pending.intrinsicHeight,
          idFactory: () => pending.elementId,
        });
      },
    });
    document.querySelector('#image-file').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (file) {
        try {
          window.__insertResult = await window.__insertFromFile(file);
          document.body.dataset.inserted = 'true';
        } catch (error) {
          document.body.dataset.error = String(error);
        }
      }
    });
    document.body.dataset.ready = 'true';
  </script>
</body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-pending-image-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 120_000).toISOString());
  return { accountId, token };
}

async function openPage(context, baseUrl, boardId) {
  await context.route('**/__pending-image-test*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__pending-image-test?${new URLSearchParams({ boardId })}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  return page;
}

test('offline paste survives profile closure and publishes to another authorized member after reconnect', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-pending-image-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const owner = addAccount(db, 'pendingowner');
  const member = addAccount(db, 'pendingmember');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Offline image recovery');
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  addMember.run(boardId, owner.accountId);
  addMember.run(boardId, member.accountId);

  await build({
    absWorkingDir: root,
    entryPoints: ['test/fixtures/pending-board-images-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/pending-board-images.bundle.js'),
  });
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this focused offline browser test');
  const ownerProfile = join(directory, 'owner-profile');
  let ownerContext;
  let memberContext;
  try {
    ownerContext = await chromium.launchPersistentContext(ownerProfile, {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await ownerContext.addCookies([{ name: 'whiteboard_session', value: owner.token, url: baseUrl }]);
    const ownerPage = await openPage(ownerContext, baseUrl, boardId);
    await ownerPage.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 5_000 });
    await ownerContext.setOffline(true);
    await ownerPage.waitForFunction(() => navigator.onLine === false, null, { timeout: 5_000 });
    await ownerPage.locator('#image-file').setInputFiles(templatePath);
    await ownerPage.waitForFunction(() => document.body.dataset.inserted === 'true', null, { timeout: 10_000 });
    assert.equal(await ownerPage.evaluate(() => window.__insertResult.uploaded), false);
    assert.equal(await ownerPage.evaluate(() => window.__session.doc.getArray('order').length), 0,
      'the offline image has no shared Yjs reference');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
    const pendingPreview = await ownerPage.evaluate(() => window.__drawPendingPreview());
    assert.ok(pendingPreview.visiblePixels > 0, 'the local Blob is decodable and can be shown to its author');
    assert.deepEqual(pendingPreview.geometry, await ownerPage.evaluate(() => window.__pending[0].geometry));

    await ownerPage.evaluate(() => window.__session.destroy());
    await ownerContext.close();
    ownerContext = null;

    ownerContext = await chromium.launchPersistentContext(ownerProfile, {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await ownerContext.addCookies([{ name: 'whiteboard_session', value: owner.token, url: baseUrl }]);
    const reopenedOwnerPage = await openPage(ownerContext, baseUrl, boardId);
    await reopenedOwnerPage.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 5_000 });
    assert.equal(await reopenedOwnerPage.evaluate(() => window.__session.doc.getArray('order').length), 0,
      'the reopened board still has no shared image reference before upload');
    assert.equal(await reopenedOwnerPage.evaluate(() => window.__pending.length), 1,
      'the pending Blob survives closing and reopening the browser profile');
    const restoredPreview = await reopenedOwnerPage.evaluate(() => window.__drawPendingPreview());
    assert.ok(restoredPreview.visiblePixels > 0);
    assert.deepEqual(restoredPreview.geometry, pendingPreview.geometry);

    memberContext = await chromium.launchPersistentContext(join(directory, 'member-profile'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await memberContext.addCookies([{ name: 'whiteboard_session', value: member.token, url: baseUrl }]);
    const memberPage = await openPage(memberContext, baseUrl, boardId);
    await memberPage.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 5_000 });
    assert.equal(await memberPage.evaluate(() => window.__session.doc.getArray('order').length), 0,
      'other members cannot see an unuploaded pending image');

    const publishResult = await reopenedOwnerPage.evaluate(() => window.__publishPending());
    assert.equal(publishResult.length, 1);
    await memberPage.waitForFunction(() => window.__session.doc.getArray('order').length === 1, null, { timeout: 10_000 });
    const publishedElement = await memberPage.evaluate(() => window.__pending.length);
    assert.equal(publishedElement, 0, 'the local-only pending queue is empty after successful publication');
    const record = db.prepare('SELECT id AS assetId FROM assets WHERE board_id = ?').get(boardId);
    assert.ok(record?.assetId);
    const memberAssetResponse = await memberPage.evaluate(async ({ boardId: id, assetId }) => {
      const response = await fetch(`/api/boards/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`);
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    }, {
      boardId, assetId: record.assetId,
    });
    assert.equal(memberAssetResponse.status, 200);
    assert.ok(await memberAssetResponse.bytes > 0);
    const memberElement = await memberPage.evaluate(() => {
      const id = window.__session.doc.getArray('order').get(0);
      const record = window.__session.doc.getMap('elements').get(id);
      return { id, geometry: record.get('geometry'), assetId: record.get('data').get('assetId') };
    });
    assert.deepEqual(memberElement.geometry, pendingPreview.geometry);
    assert.equal(memberElement.assetId, record.assetId);
  } finally {
    await ownerContext?.close();
    await memberContext?.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
