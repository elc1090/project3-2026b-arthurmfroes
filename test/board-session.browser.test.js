import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Board session test</title></head>
<body>
  <div id="toolbar"><button id="rectangle-tool" type="button" data-board-tool="rectangle">Rectangle</button></div>
  <canvas id="board-canvas" width="320" height="240" style="width:320px;height:240px"></canvas>
  <script type="module">
    import { mountBoardCanvas, openBoardSession } from '/board.bundle.js';
    const boardId = new URL(location.href).searchParams.get('boardId');
    const initialServerPaused = new URL(location.href).searchParams.get('pauseServerSync') === 'true';
    const initialPeerPaused = new URL(location.href).searchParams.get('pausePeerSync') === 'true';
    window.__durableAcks = [];
    window.__sessionErrors = [];
    try {
      window.__session = await openBoardSession(boardId, { initialServerPaused, initialPeerPaused });
      window.__session.on('durable-ack', ack => window.__durableAcks.push(ack));
      window.__session.on('error', error => window.__sessionErrors.push(String(error)));
      window.__canvas = mountBoardCanvas({
        doc: window.__session.doc,
        canvas: document.querySelector('#board-canvas'),
        toolbar: document.querySelector('#toolbar'),
      });
      document.body.dataset.ready = 'true';
    } catch (error) {
      document.body.dataset.error = String(error);
    }
  </script>
</body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-browser-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

async function openTestPage(context, baseUrl, boardId, { pauseServerSync = false, pausePeerSync = false } = {}) {
  await context.route('**/__board-session-test*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  const page = await context.newPage();
  const query = new URLSearchParams({ boardId });
  if (pauseServerSync) query.set('pauseServerSync', 'true');
  if (pausePeerSync) query.set('pausePeerSync', 'true');
  await page.goto(`${baseUrl}/__board-session-test?${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.error, null, { timeout: 10_000 });
  const error = await page.locator('body').getAttribute('data-error');
  assert.equal(error, null, error ?? undefined);
  return page;
}

async function drawRectangle(page, x, y) {
  await page.locator('#rectangle-tool').click();
  const box = await page.locator('#board-canvas').boundingBox();
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 35, box.y + y + 30);
  await page.mouse.up();
}

async function waitForElementCount(page, count) {
  await page.waitForFunction((expected) => window.__session.doc.getMap('elements').size === expected, count, { timeout: 10_000 });
}

test('two isolated Chrome profiles exchange through WebRTC with board WS paused, then persist after resume', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-browser-transport-'));
  const dbPath = join(directory, 'board.sqlite');
  const db = await openDatabase(dbPath);
  const alice = addAccount(db, 'profilealice');
  const bob = addAccount(db, 'profilebob');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'P2P transport test');
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  addMember.run(boardId, alice.accountId);
  addMember.run(boardId, bob.accountId);

  await build({
    absWorkingDir: root,
    entryPoints: ['src/public/board-session-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/board.bundle.js'),
  });

  const server = await createAppServer({ db });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium'].find((path) => existsSync(path));
  assert.ok(browserPath, 'a local Chromium executable is required for the real-browser transport test');

  let aliceContext;
  let bobContext;
  try {
    const profileA = join(directory, 'profile-a');
    const profileB = join(directory, 'profile-b');
    aliceContext = await chromium.launchPersistentContext(profileA, {
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    bobContext = await chromium.launchPersistentContext(profileB, {
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await Promise.all([
      aliceContext.addCookies([{ name: 'whiteboard_session', value: alice.token, url: baseUrl }]),
      bobContext.addCookies([{ name: 'whiteboard_session', value: bob.token, url: baseUrl }]),
    ]);

    let alicePage = await openTestPage(aliceContext, baseUrl, boardId);
    const bobPage = await openTestPage(bobContext, baseUrl, boardId);
    await alicePage.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 5_000 });
    await bobPage.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 5_000 });

    await alicePage.evaluate(() => {
      window.__broadcastProbe = [];
      window.__probeChannel = new BroadcastChannel('t3-profile-isolation-probe');
      window.__probeChannel.onmessage = (event) => window.__broadcastProbe.push(event.data);
    });
    await bobPage.evaluate(() => {
      const channel = new BroadcastChannel('t3-profile-isolation-probe');
      channel.postMessage('must stay in profile B');
      channel.close();
    });
    await alicePage.waitForTimeout(250);
    assert.deepEqual(await alicePage.evaluate(() => window.__broadcastProbe), [], 'BroadcastChannel must not cross the two browser profiles');

    await Promise.all([
      alicePage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
      bobPage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
    ]);
    assert.deepEqual((await alicePage.evaluate(() => window.__session.p2pStatus)).bcPeers, []);
    assert.deepEqual((await bobPage.evaluate(() => window.__session.p2pStatus)).bcPeers, []);

    await Promise.all([
      alicePage.evaluate(() => window.__session.pauseServerSync()),
      bobPage.evaluate(() => window.__session.pauseServerSync()),
    ]);
    await Promise.all([
      alicePage.waitForFunction(() => window.__session.serverStatus === 'paused'),
      bobPage.waitForFunction(() => window.__session.serverStatus === 'paused'),
    ]);

    await drawRectangle(alicePage, 30, 40);
    await waitForElementCount(alicePage, 1);
    await bobPage.waitForFunction(() => window.__session.doc.getMap('elements').size === 1, null, { timeout: 15_000 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0,
      'the VPS sync path must stay paused while the peer receives the edit');
    assert.equal(await alicePage.evaluate(() => window.__durableAcks.length), 0,
      'peer receipt must not be reported as a durable server acknowledgement');

    await Promise.all([
      alicePage.evaluate(() => window.__session.pausePeerSync()),
      bobPage.evaluate(() => window.__session.pausePeerSync()),
    ]);
    await Promise.all([
      alicePage.waitForFunction(() => window.__session.p2pPeerCount === 0, null, { timeout: 5_000 }),
      bobPage.waitForFunction(() => window.__session.p2pPeerCount === 0, null, { timeout: 5_000 }),
    ]);
    await drawRectangle(alicePage, 180, 150);
    await waitForElementCount(alicePage, 2);
    assert.equal(await bobPage.evaluate(() => window.__session.doc.getMap('elements').size), 1,
      'the second edit stays only in Alice while both network paths are paused');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0);
    assert.equal(await alicePage.evaluate(() => window.__durableAcks.length), 0);

    await alicePage.evaluate(() => window.__session.destroy());
    await alicePage.close();
    alicePage = await openTestPage(aliceContext, baseUrl, boardId, { pauseServerSync: true, pausePeerSync: true });
    assert.equal(await alicePage.evaluate(() => window.__session.doc.getMap('elements').size), 2,
      'the reopened profile must restore its local IndexedDB document');
    assert.equal(await bobPage.evaluate(() => window.__session.doc.getMap('elements').size), 1,
      'the other replica remains behind until a provider reconnects');
    await Promise.all([
      alicePage.evaluate(() => window.__session.resumePeerSync()),
      bobPage.evaluate(() => window.__session.resumePeerSync()),
    ]);
    await Promise.all([
      alicePage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
      bobPage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
    ]);
    await bobPage.waitForFunction(() => window.__session.doc.getMap('elements').size === 2, null, { timeout: 15_000 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0);
    assert.equal(await alicePage.evaluate(() => window.__durableAcks.length), 0);

    await Promise.all([
      alicePage.evaluate(() => window.__session.resumeServerSync()),
      bobPage.evaluate(() => window.__session.resumeServerSync()),
    ]);
    try {
      await Promise.race([
        alicePage.waitForFunction(() => window.__durableAcks.length > 0, null, { timeout: 5_000 }),
        bobPage.waitForFunction(() => window.__durableAcks.length > 0, null, { timeout: 5_000 }),
      ]);
    } catch (error) {
      const clientStates = await Promise.all([alicePage, bobPage].map((page) => page.evaluate(() => ({
        serverStatus: window.__session.serverStatus,
        durableAcks: window.__durableAcks,
        errors: window.__sessionErrors,
        elements: window.__session.doc.getMap('elements').size,
      }))));
      throw new Error(`No durable ACK after server resume: ${JSON.stringify(clientStates)}; stored updates=${db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count}`, { cause: error });
    }
    const durableAcks = await Promise.all([alicePage, bobPage].map((page) => page.evaluate(() => window.__durableAcks)));
    assert.equal(durableAcks.some((acks) => acks.length > 0 && acks.every((ack) => Boolean(ack.committedAt))), true);

    const recovered = createBoardUpdateStore(db).loadDocument(boardId);
    try {
      assert.equal(recovered.getMap('elements').size, 2, 'both P2P edits must be present in durable server storage after reconnection');
      await waitForElementCount(bobPage, 2);
    } finally {
      recovered.destroy();
    }
  } finally {
    await aliceContext?.close();
    await bobContext?.close();
    await server.signaling.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
