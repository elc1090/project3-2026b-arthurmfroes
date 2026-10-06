import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createSyncExperimentComparison, exportSyncExperimentCsv, exportSyncExperimentJson } from '../src/client/sync-experiment.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sync experiment test</title></head>
<body>
  <div id="toolbar"><button id="rectangle-tool" data-board-tool="rectangle">Rectangle</button></div>
  <canvas id="board-canvas" width="320" height="240" style="width:320px;height:240px"></canvas>
  <script type="module">
    import { mountBoardCanvas, mountSyncExperimentUI, openBoardSession } from '/board.bundle.js';
    const query = new URL(location.href).searchParams;
    const boardId = query.get('boardId');
    window.__events = [];
    try {
      window.__session = await openBoardSession(boardId, {
        initialPeerPaused: query.get('mode') === 'server-only',
        onEvent: (type, detail) => window.__events.push({ type, detail }),
      });
      window.__canvas = mountBoardCanvas({
        boardSession: window.__session,
        displayName: query.get('name'),
        doc: window.__session.doc,
        canvas: document.querySelector('#board-canvas'),
        toolbar: document.querySelector('#toolbar'),
      });
      window.__mountSyncExperimentUI = mountSyncExperimentUI;
      document.body.dataset.ready = 'true';
    } catch (error) { document.body.dataset.error = String(error); }
  </script>
</body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-experiment-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 120_000).toISOString());
  return { accountId, token };
}

function createBoard(db, accounts, label) {
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, label);
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  for (const account of accounts) addMember.run(boardId, account.accountId);
  return boardId;
}

async function openPage(context, baseUrl, boardId, mode, name) {
  await context.route('**/__sync-experiment*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  const page = await context.newPage();
  const query = new URLSearchParams({ boardId, mode, name });
  await page.goto(`${baseUrl}/__sync-experiment?${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.error, null, { timeout: 10_000 });
  const error = await page.locator('body').getAttribute('data-error');
  assert.equal(error, null, error ?? undefined);
  await page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 });
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

test('same Canvas edit script exports measured hybrid and server-only traffic and convergence', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-sync-experiment-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const alice = addAccount(db, 'experimentsalice');
  const bob = addAccount(db, 'experimentsbob');
  const updateStore = createBoardUpdateStore(db);
  await build({
    absWorkingDir: root,
    entryPoints: ['src/public/board-session-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/board.bundle.js'),
  });
  const server = await createAppServer({ db, boardUpdateStore: updateStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium'].find(path => existsSync(path));
  assert.ok(browserPath, 'a local Chromium executable is required for the real-browser experiment');

  async function runMode(mode) {
    const boardId = createBoard(db, [alice, bob], `Traffic experiment ${mode}`);
    const aliceContext = await chromium.launchPersistentContext(join(directory, `${mode}-alice`), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const bobContext = await chromium.launchPersistentContext(join(directory, `${mode}-bob`), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    let alicePage;
    let bobPage;
    try {
      await Promise.all([
        aliceContext.addCookies([{ name: 'whiteboard_session', value: alice.token, url: baseUrl }]),
        bobContext.addCookies([{ name: 'whiteboard_session', value: bob.token, url: baseUrl }]),
      ]);
      alicePage = await openPage(aliceContext, baseUrl, boardId, mode, 'Alice');
      bobPage = await openPage(bobContext, baseUrl, boardId, mode, 'Bob');

      if (mode === 'hybrid') {
        await Promise.all([
          alicePage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
          bobPage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
        ]);
      } else {
        assert.equal(await alicePage.evaluate(() => window.__session.p2pPeerCount), 0);
        assert.equal(await bobPage.evaluate(() => window.__session.p2pPeerCount), 0);
      }

      // Exercise hook teardown/reattach before the timed window; handshake bytes
      // after this reconnection must be counted, then excluded from the scenario.
      if (mode === 'hybrid') {
        await Promise.all([
          alicePage.evaluate(() => window.__session.pausePeerSync()),
          bobPage.evaluate(() => window.__session.pausePeerSync()),
        ]);
        await Promise.all([
          alicePage.waitForFunction(() => window.__session.p2pPeerCount === 0),
          bobPage.waitForFunction(() => window.__session.p2pPeerCount === 0),
        ]);
        await Promise.all([
          alicePage.evaluate(() => window.__session.resumePeerSync()),
          bobPage.evaluate(() => window.__session.resumePeerSync()),
        ]);
        await Promise.all([
          alicePage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
          bobPage.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 }),
        ]);
        const reconnectMetrics = await alicePage.evaluate(() => window.__session.experimentMetrics.webrtc.sent.messages);
        assert.ok(reconnectMetrics > 0, 'reconnected WebRTC datachannel frames remain instrumented');
        await Promise.all([alicePage, bobPage].map(page => page.waitForTimeout(150)));
      }

      await Promise.all([
        alicePage.evaluate(() => window.__session.resetExperimentMetrics()),
        bobPage.evaluate(() => window.__session.resetExperimentMetrics()),
      ]);
      assert.deepEqual(await Promise.all([alicePage, bobPage].map(page => page.evaluate(() => window.__session.serverStatus))),
        ['connected', 'connected'], 'the direct comparison keeps the VPS WebSocket active in both modes');
      const start = performance.now();

      await drawRectangle(alicePage, 25, 30);
      await bobPage.waitForFunction(() => window.__session.doc.getMap('elements').size === 1, null, { timeout: 10_000 });
      const firstVisibleMs = performance.now() - start;
      await bobPage.waitForFunction(() => window.__events.some(({ type, detail }) =>
        type === 'update-observed' && ['peer-room', 'server'].includes(detail.sourcePath)), null, { timeout: 5_000 });
      const firstArrivalPath = await bobPage.evaluate(() => window.__events.find(({ type, detail }) =>
        type === 'update-observed' && ['peer-room', 'server'].includes(detail.sourcePath))?.detail.sourcePath ?? null);
      assert.ok(firstArrivalPath, 'the first arrival path comes from the observed update event');
      if (mode === 'server-only') assert.equal(firstArrivalPath, 'server');
      const peerVisibleMs = mode === 'hybrid' && firstArrivalPath === 'peer-room' ? firstVisibleMs : null;

      await drawRectangle(bobPage, 120, 75);
      const allClientsConvergedPromise = Promise.all([
        alicePage.waitForFunction(() => window.__session.doc.getMap('elements').size === 2, null, { timeout: 15_000 }),
        bobPage.waitForFunction(() => window.__session.doc.getMap('elements').size === 2, null, { timeout: 15_000 }),
      ]).then(() => performance.now() - start);
      const vpsDurablePromise = Promise.all([
        alicePage.waitForFunction(() => window.__events.filter(({ type }) => type === 'durable-ack').length >= 1,
          null, { timeout: 15_000 }),
        bobPage.waitForFunction(() => window.__events.filter(({ type }) => type === 'durable-ack').length >= 1,
          null, { timeout: 15_000 }),
      ]).then(() => new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        const poll = () => {
          const serverDoc = updateStore.loadDocument(boardId);
          const elementCount = serverDoc.getMap('elements').size;
          serverDoc.destroy();
          if (elementCount === 2) return resolve(performance.now() - start);
          if (performance.now() >= deadline) return reject(new Error(`durable server state has ${elementCount} experiment elements`));
          setTimeout(poll, 20);
        };
        poll();
      }));
      const [allClientsConvergedMs, vpsDurableMs] = await Promise.all([
        allClientsConvergedPromise,
        vpsDurablePromise,
      ]);
      const serverUpdateRows = db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count;
      const replicas = {
        alice: await alicePage.evaluate(() => window.__session.experimentMetrics),
        bob: await bobPage.evaluate(() => window.__session.experimentMetrics),
      };
      return {
        mode,
        vpsWebSocket: 'active',
        p2p: mode === 'hybrid' ? 'active' : 'paused',
        replicas,
        firstVisibleMs,
        firstArrivalPath,
        peerVisibleMs,
        allClientsConvergedMs,
        vpsDurableMs,
        serverUpdateRows,
      };
    } finally {
      await Promise.all([
        alicePage?.evaluate(() => window.__session.destroy()).catch(() => {}),
        bobPage?.evaluate(() => window.__session.destroy()).catch(() => {}),
      ]);
      await Promise.all([aliceContext.close(), bobContext.close()]);
    }
  }

  try {
    const runs = [await runMode('hybrid'), await runMode('server-only')];
    const comparison = createSyncExperimentComparison({
      scenario: 'Same two rectangle actions with VPS WebSocket active in both modes; wait for client convergence and VPS durable ACK',
      separateDemonstration: {
        scenario: 'hybrid-vps-paused',
        evidenceTest: 'test/board-session.browser.test.js',
        evidenceCase: 'two isolated Chrome profiles exchange through WebRTC with board WS paused, then persist after resume',
        includedInComparison: false,
      },
      runs,
    });
    const json = exportSyncExperimentJson(comparison);
    const csv = exportSyncExperimentCsv(comparison);
    assert.equal(JSON.parse(json).runs.length, 2);
    assert.equal(JSON.parse(json).separateDemonstration.includedInComparison, false);
    assert.deepEqual(JSON.parse(json).runs.map(run => [run.vpsWebSocket, run.p2p]), [
      ['active', 'active'],
      ['active', 'paused'],
    ]);
    assert.match(csv, /hybrid,active,active,alice,webrtc,sent/);
    assert.match(csv, /server-only,active,paused,bob,websocket,received/);
    assert.match(comparison.trafficScope, /excludes WS\/TCP\/TLS\/SCTP\/DTLS\/IP overhead/);
    if (process.env.SYNC_EXPERIMENT_OUTPUT_DIR) {
      await mkdir(process.env.SYNC_EXPERIMENT_OUTPUT_DIR, { recursive: true });
      await Promise.all([
        writeFile(join(process.env.SYNC_EXPERIMENT_OUTPUT_DIR, 'sync-experiment.json'), json),
        writeFile(join(process.env.SYNC_EXPERIMENT_OUTPUT_DIR, 'sync-experiment.csv'), csv),
      ]);
    }

    const [hybrid, serverOnly] = runs;
    assert.ok(hybrid.firstVisibleMs > 0, 'hybrid run records the first visible arrival regardless of transport winner');
    assert.ok(hybrid.firstVisibleMs > 0 && ['peer-room', 'server'].includes(hybrid.firstArrivalPath));
    assert.equal(hybrid.peerVisibleMs, hybrid.firstArrivalPath === 'peer-room' ? hybrid.firstVisibleMs : null);
    assert.ok(serverOnly.firstVisibleMs > 0);
    assert.equal(serverOnly.firstArrivalPath, 'server');
    assert.equal(serverOnly.peerVisibleMs, null, 'server-only has no peer arrival measurement');
    assert.ok(hybrid.allClientsConvergedMs > 0 && serverOnly.allClientsConvergedMs > 0);
    assert.ok(hybrid.vpsDurableMs > 0 && serverOnly.vpsDurableMs > 0);
    assert.ok(hybrid.replicas.alice.webrtc.sent.updateMessages + hybrid.replicas.bob.webrtc.sent.updateMessages > 0);
    assert.ok(hybrid.replicas.alice.webrtc.sent.awarenessBytes + hybrid.replicas.bob.webrtc.sent.awarenessBytes > 0,
      'WebRTC Awareness traffic is counted separately from Yjs update messages');
    assert.equal(serverOnly.replicas.alice.webrtc.sent.bytes + serverOnly.replicas.bob.webrtc.sent.bytes, 0);
    for (const run of runs) {
      assert.ok(run.replicas.alice.websocket.sent.bytes > 0 && run.replicas.alice.websocket.received.bytes > 0);
      assert.ok(run.replicas.alice.websocket.sent.updateMessages + run.replicas.bob.websocket.sent.updateMessages > 0);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
