import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
<html><head><meta charset="utf-8"><title>Image UI test</title></head>
<body>
  <div id="board-toolbar">
    <button type="button" data-board-image-add>Adicionar imagem</button>
    <input type="file" data-board-image-picker>
    <button type="button" data-board-template-add>Inserir modelo</button>
    <button type="button" data-board-undo>Desfazer</button>
    <button type="button" data-board-redo>Refazer</button>
    <p data-board-image-status></p>
  </div>
  <canvas id="board-canvas" width="800" height="480"></canvas>
  <script type="module">
    import { createBoardDocument, mountBoardCanvas } from '/board.bundle.js';
    const query = new URL(location.href).searchParams;
    const initialElements = JSON.parse(query.get('elements') || '[]');
    const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    window.__draws = [];
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...geometry) {
      window.__draws.push(geometry);
      return nativeDrawImage.call(this, image, ...geometry);
    };
    window.__doc = createBoardDocument(initialElements);
    window.__mounted = mountBoardCanvas({
      boardId: query.get('boardId'),
      doc: window.__doc,
      canvas: document.querySelector('#board-canvas'),
      toolbar: document.querySelector('#board-toolbar'),
    });
    window.__elements = () => {
      const maps = window.__doc.getMap('elements');
      return window.__doc.getArray('order').toArray().flatMap(id => {
        const record = maps.get(id);
        if (!record || record.get('deleted')) return [];
        return [{
          id,
          type: record.get('type'),
          geometry: record.get('geometry'),
          style: Object.fromEntries(record.get('style').entries()),
          data: Object.fromEntries(record.get('data').entries()),
        }];
      });
    };
    document.body.dataset.ready = 'true';
  </script>
</body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-image-ui-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

async function openImagePage(context, baseUrl, boardId, elements = []) {
  await context.route('**/__image-ui*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  const page = await context.newPage();
  const query = new URLSearchParams({ boardId, elements: JSON.stringify(elements) });
  await page.goto(`${baseUrl}/__image-ui?${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  return page;
}

test('two authorized browser profiles render the same asset and exercise file, paste, template, and undo', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-image-ui-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const owner = addAccount(db, 'imageowner');
  const member = addAccount(db, 'imagemember');
  const outsider = addAccount(db, 'imageoutsider');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Image UI test');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, owner.accountId);
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, member.accountId);

  await build({
    absWorkingDir: root,
    entryPoints: [existsSync(join(root, 'src/public/board-session-entry.js'))
      ? 'src/public/board-session-entry.js'
      : 'src/public/board-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/board.bundle.js'),
  });
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this focused browser test');
  let ownerContext;
  let memberContext;
  try {
    ownerContext = await chromium.launchPersistentContext(join(directory, 'profile-owner'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    memberContext = await chromium.launchPersistentContext(join(directory, 'profile-member'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await Promise.all([
      ownerContext.addCookies([{ name: 'whiteboard_session', value: owner.token, url: baseUrl }]),
      memberContext.addCookies([{ name: 'whiteboard_session', value: member.token, url: baseUrl }]),
    ]);

    const ownerPage = await openImagePage(ownerContext, baseUrl, boardId);
    await ownerPage.locator('[data-board-template-add]').click();
    await ownerPage.waitForFunction(() => window.__elements().length === 1 && window.__draws.length > 0, null, { timeout: 15_000 });
    const firstElement = (await ownerPage.evaluate(() => window.__elements()))[0];
    assert.deepEqual(firstElement.geometry, { x: 183, y: 15, width: 434, height: 450 });
    const ownerImageStatus = await ownerPage.evaluate(async assetId => (await fetch(
      `/api/boards/${encodeURIComponent(new URL(location.href).searchParams.get('boardId'))}/assets/${encodeURIComponent(assetId)}`,
      { cache: 'no-store' },
    )).status, firstElement.data.assetId);
    assert.equal(ownerImageStatus, 200, 'the owner loads the image through the authorized asset route');
    assert.ok(await ownerPage.evaluate(() => {
      const { data } = document.querySelector('#board-canvas').getContext('2d').getImageData(183, 15, 434, 450);
      return data.some((channel, index) => index % 4 === 3 && channel > 0);
    }), 'the browser Canvas contains rendered image pixels');

    const memberPage = await openImagePage(memberContext, baseUrl, boardId, [firstElement]);
    await memberPage.waitForFunction(() => window.__draws.length > 0, null, { timeout: 15_000 });
    const memberElement = (await memberPage.evaluate(() => window.__elements()))[0];
    assert.deepEqual(memberElement.geometry, firstElement.geometry, 'both profiles use the same Yjs image geometry');
    assert.equal(memberElement.data.assetId, firstElement.data.assetId);
    const memberImageStatus = await memberPage.evaluate(async assetId => (await fetch(
      `/api/boards/${encodeURIComponent(new URL(location.href).searchParams.get('boardId'))}/assets/${encodeURIComponent(assetId)}`,
      { cache: 'no-store' },
    )).status, firstElement.data.assetId);
    assert.equal(memberImageStatus, 200, 'another board member loads the same asset');
    assert.deepEqual(await memberPage.evaluate(() => window.__draws[0]), [183, 15, 434, 450]);
    assert.ok(await memberPage.evaluate(() => {
      const { data } = document.querySelector('#board-canvas').getContext('2d').getImageData(183, 15, 434, 450);
      return data.some((channel, index) => index % 4 === 3 && channel > 0);
    }), 'the second authorized profile renders the shared image pixels');

    const outsiderResponse = await fetch(`${baseUrl}/api/boards/${boardId}/assets/${firstElement.data.assetId}`, {
      headers: { cookie: `whiteboard_session=${outsider.token}` },
    });
    assert.equal(outsiderResponse.status, 403, 'a nonmember cannot retrieve the uploaded bytes');

    const legacyPage = await openImagePage(ownerContext, baseUrl, '');
    assert.ok(await legacyPage.locator('[data-board-image-add]').isDisabled());
    assert.ok(await legacyPage.locator('[data-board-image-picker]').isDisabled());
    assert.ok(await legacyPage.locator('[data-board-template-add]').isDisabled());
    await legacyPage.close();

    await ownerPage.locator('[data-board-template-add]').click();
    await ownerPage.waitForFunction(() => window.__elements().length === 2, null, { timeout: 15_000 });
    const secondTemplate = (await ownerPage.evaluate(() => window.__elements()))[1];
    assert.deepEqual(secondTemplate.geometry, { x: 697, y: 15, width: 434, height: 450 },
      'a second template is placed to the right of existing content');

    await ownerPage.locator('[data-board-image-picker]').setInputFiles(templatePath);
    await ownerPage.waitForFunction(() => window.__elements().length === 3, null, { timeout: 15_000 });
    const fileGeometry = (await ownerPage.evaluate(() => window.__elements()))[2].geometry;
    assert.ok(Math.abs(fileGeometry.x + fileGeometry.width / 2 - 400) < 1);
    assert.ok(Math.abs(fileGeometry.y + fileGeometry.height / 2 - 240) < 1);
    await ownerPage.evaluate(async () => {
      const blob = await (await fetch('/api/templates/fsm-reference')).blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'clipboard.png', { type: blob.type }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await ownerPage.waitForFunction(() => window.__elements().length === 4, null, { timeout: 15_000 });
    const ownerElements = await ownerPage.evaluate(() => window.__elements());
    assert.ok(ownerElements.every(element => element.type === 'image' && element.data.assetId));
    assert.ok(ownerElements.some(element => element.geometry.x === 183 && element.geometry.y === 15));
    const clipboardGeometry = ownerElements[3].geometry;
    assert.ok(Math.abs(clipboardGeometry.x + clipboardGeometry.width / 2 - 400) < 1);
    assert.ok(Math.abs(clipboardGeometry.y + clipboardGeometry.height / 2 - 240) < 1);
    assert.ok(await ownerPage.locator('[data-board-undo]').isEnabled());
    await ownerPage.locator('[data-board-undo]').click();
    await ownerPage.waitForFunction(() => window.__elements().length === 3, null, { timeout: 5_000 });
    assert.ok(await ownerPage.evaluate(() => window.__draws.length >= 2), 'Canvas.drawImage rendered fetched bitmap data');
  } finally {
    await ownerContext?.close();
    await memberContext?.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
