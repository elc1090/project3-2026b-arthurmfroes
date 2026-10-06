import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = new URL('..', import.meta.url).pathname;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'replica-panel-browser-test');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

async function waitForBoardPage(context, baseUrl, boardId) {
  const page = await context.newPage();
  const pageErrors = [];
  const failedResponses = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push('console: ' + message.text()); });
  page.replicaTestErrors = pageErrors;
  page.on('response', (response) => { if (response.status() >= 400) failedResponses.push([response.status(), response.url()]); });
  await page.goto(baseUrl + '/boards/' + boardId);
  try {
    await page.locator('#board-workspace').waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    const state = await page.evaluate(async () => ({
      message: document.querySelector('#message')?.textContent,
      account: document.querySelector('#account-name')?.textContent,
      authHidden: document.querySelector('#auth-panel')?.hidden,
      boardTitle: document.querySelector('#board-title')?.textContent,
      accessMessage: document.querySelector('#board-access-message')?.textContent,
      readyState: document.readyState,
      appLoaded: performance.getEntriesByType('resource').some((resource) => resource.name.endsWith('/app.js')),
      session: await fetch('/api/auth/session').then((response) => response.json()).catch((error) => String(error)),
    }));
    throw new Error('Board page did not open: ' + JSON.stringify({ state, pageErrors, failedResponses, pageUrl: page.url() }), { cause: error });
  }
  await page.locator('#replica-panel-status').getByText(/Canal de diagnóstico ativo/).waitFor({ timeout: 10_000 });
  const metricsPanel = page.locator('#sync-experiment [data-sync-experiment]');
  await metricsPanel.getByText('Tráfego desta réplica').waitFor();
  await metricsPanel.getByRole('button', { name: 'Zerar contadores' }).click();
  await metricsPanel.getByText('Contadores zerados nesta réplica.').waitFor();
  assert.match(await metricsPanel.locator('pre').textContent(), /websocket: enviados/);
  return page;
}

async function drawRectangle(page) {
  const canvas = page.locator('#board-canvas');
  await canvas.scrollIntoViewIfNeeded();
  await page.locator('[data-board-tool="rectangle"]').click();
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 32, bounds.y + 36);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 120, bounds.y + 96, { steps: 4 });
  await page.mouse.up();
}

async function waitForPreview(page, replicaId, count) {
  await page.waitForFunction(({ id, expected }) => {
    const card = [...document.querySelectorAll('.replica-preview-card')].find((item) => item.dataset.replicaId === id);
    return card?.dataset.elementCount === String(expected);
  }, { id: replicaId, expected: count }, { timeout: 15_000 });
}

test('two browser replicas stay ahead of the VPS preview while server sync is paused', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-replica-panel-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const alice = addAccount(db, 'panelalice');
  const bob = addAccount(db, 'panelbob');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Replica panel browser test');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, alice.accountId);
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, bob.accountId);
  await build({
    absWorkingDir: root,
    entryPoints: ['src/public/board-session-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/board.bundle.js'),
  });

  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this focused browser test');
  let aliceContext;
  let bobContext;
  try {
    aliceContext = await chromium.launchPersistentContext(join(directory, 'profile-alice'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    bobContext = await chromium.launchPersistentContext(join(directory, 'profile-bob'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await Promise.all([
      aliceContext.addCookies([{ name: 'whiteboard_session', value: alice.token, url: baseUrl }]),
      bobContext.addCookies([{ name: 'whiteboard_session', value: bob.token, url: baseUrl }]),
    ]);
    const alicePage = await waitForBoardPage(aliceContext, baseUrl, boardId);
    const bobPage = await waitForBoardPage(bobContext, baseUrl, boardId);
    try {
      await Promise.all([alicePage, bobPage].map((page) => page.waitForFunction(() =>
        /P2P: [1-9][0-9]* peer\(s\) conectado\(s\)/.test(document.querySelector('#replica-peer-state').textContent),
      null, { timeout: 20_000 })));
    } catch (error) {
      const states = await Promise.all([alicePage, bobPage].map((page) => page.evaluate(() => ({
        peerState: document.querySelector('#replica-peer-state').textContent,
        diagnosticStatus: document.querySelector('#replica-panel-status').textContent,
        cardIds: [...document.querySelectorAll('.replica-preview-card')].map((card) => card.dataset.replicaId),
      }))));
      throw new Error('Direct peer did not connect: ' + JSON.stringify({ states, errors: [alicePage.replicaTestErrors, bobPage.replicaTestErrors] }), { cause: error });
    }

    await Promise.all([alicePage, bobPage].map((page) => page.locator('#replica-pause-server').click()));
    await Promise.all([alicePage, bobPage].map((page) => page.getByText('Conexão VPS: pausada neste navegador').waitFor()));
    await alicePage.locator('[data-board-template-add]').click();
    await waitForPreview(alicePage, 'local', 1);
    await bobPage.waitForFunction(() =>
      [...document.querySelectorAll('.replica-preview-card')].some((card) =>
        card.dataset.replicaId.startsWith('peer:') && card.dataset.elementTypes.includes('image')),
    null, { timeout: 15_000 });
    await alicePage.waitForFunction(() => {
      const canvas = [...document.querySelectorAll('.replica-preview-card[data-replica-id^="peer:"] canvas')][0];
      if (!canvas) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let darkPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) darkPixels += 1;
      }
      return darkPixels > 300;
    }, null, { timeout: 15_000 });
    await drawRectangle(alicePage);

    await waitForPreview(alicePage, 'local', 2);
    await waitForPreview(bobPage, 'local', 2);
    await alicePage.waitForFunction(() =>
      [...document.querySelectorAll('.replica-preview-card')].some((card) =>
        card.dataset.replicaId.startsWith('peer:') && card.dataset.elementCount === '2'),
    null, { timeout: 15_000 });
    await bobPage.waitForFunction(() =>
      [...document.querySelectorAll('.replica-preview-card')].some((card) =>
        card.dataset.replicaId.startsWith('peer:') && card.dataset.elementCount === '2'),
    null, { timeout: 15_000 });
    await waitForPreview(alicePage, 'vps', 0);
    await waitForPreview(bobPage, 'vps', 0);
    const pendingActionHandle = await bobPage.waitForFunction(() =>
      document.querySelector('#board-sync-status tr[data-pending="true"]')?.dataset.actionId ?? null,
    null, { timeout: 10_000 });
    const statusActionId = await pendingActionHandle.jsonValue();
    assert.equal(typeof statusActionId, 'string');
    await bobPage.waitForFunction((actionId) => {
      const row = [...document.querySelectorAll('#board-sync-status tr[data-action-id]')]
        .find((item) => item.dataset.actionId === actionId);
      return row?.querySelector('[data-flag="peer"]')?.textContent === 'Sim'
        && row?.querySelector('[data-flag="durable"]')?.textContent === '—'
        && row?.dataset.pending === 'true';
    }, statusActionId, { timeout: 10_000 });
    await bobPage.waitForFunction(() => [...document.querySelectorAll('.board-timeline__events li')]
      .some((row) => row.dataset.eventType === 'update-peer-room'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0,
      'diagnostic snapshots do not enter the durable VPS store');
    const previews = await alicePage.locator('.replica-preview-card').evaluateAll((cards) =>
      cards.map((card) => ({ id: card.dataset.replicaId, count: card.dataset.elementCount, types: card.dataset.elementTypes || '' })),
    );
    assert.equal(previews.filter((card) => card.id === 'local' && card.count === '2' && card.types.includes('rect') && card.types.includes('image')).length, 1);
    assert.equal(previews.filter((card) => card.id.startsWith('peer:') && card.count === '2' && card.types.includes('rect') && card.types.includes('image')).length, 1);
    assert.equal(previews.filter((card) => card.id === 'vps' && card.count === '0').length, 1,
      'the displayed peer states differ from the older durable VPS replica');

    await alicePage.locator('#replica-pause-peer').click();
    await alicePage.getByText('P2P: desconectado ou pausado').waitFor();
    await alicePage.getByText('Conexão VPS: pausada neste navegador').waitFor();
    await alicePage.locator('#replica-resume-peer').click();
    await alicePage.waitForFunction(() =>
      /P2P: [1-9][0-9]* peer\(s\) conectado\(s\)/.test(document.querySelector('#replica-peer-state').textContent),
    null, { timeout: 20_000 });
    await alicePage.getByText('Conexão VPS: pausada neste navegador').waitFor();

    await Promise.all([alicePage, bobPage].map((page) => page.evaluate(() => {
      window.__replicaEvents = [];
      document.querySelector('#replica-panel').addEventListener('replica-diagnostic-event', (event) => window.__replicaEvents.push(event.detail));
    })));
    await Promise.all([alicePage, bobPage].map((page) => page.locator('#replica-resume-server').click()));
    await Promise.all([alicePage, bobPage].map((page) => waitForPreview(page, 'vps', 2)));
    await bobPage.waitForFunction((actionId) => {
      const row = [...document.querySelectorAll('#board-sync-status tr[data-action-id]')]
        .find((item) => item.dataset.actionId === actionId);
      return row?.querySelector('[data-flag="server"]')?.textContent === 'Sim'
        && row?.querySelector('[data-flag="durable"]')?.textContent === 'Sim'
        && row?.dataset.pending !== 'true';
    }, statusActionId, { timeout: 10_000 });
    await Promise.all([alicePage, bobPage].map((page) => page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.board-timeline__events li')];
      return rows.some((row) => row.dataset.eventType === 'server-received')
        && rows.some((row) => row.dataset.eventType === 'durable-persisted');
    }, null, { timeout: 10_000 })));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count > 0, true,
      'resuming server sync persists the peer edit and updates the VPS preview');
    await bobPage.waitForFunction(() => window.__replicaEvents.some((entry) => entry.event?.type === 'durable-persisted'), null, { timeout: 5_000 });
    const durableEvent = await bobPage.evaluate(() => window.__replicaEvents.filter((entry) => entry.event?.type === 'durable-persisted').at(-1));
    assert.match(durableEvent.replicaId, /^vps:[0-9a-f-]{36}$/i);
    assert.equal(Number.isSafeInteger(durableEvent.event.sequence), true);
    assert.equal(typeof durableEvent.event.observedAt, 'string');
    assert.equal(typeof durableEvent.event.updateBytes, 'number');
    assert.equal(Object.hasOwn(durableEvent.event, 'update'), false);
    const durableTimelineRow = bobPage.locator(`.board-timeline__events li[data-event-type="durable-persisted"][data-sequence="${durableEvent.event.sequence}"]`).last();
    assert.equal(await durableTimelineRow.getAttribute('data-sequence'), String(durableEvent.event.sequence));
    const durableTimelineText = await durableTimelineRow.textContent();
    assert.match(durableTimelineText, /réplica vps/);
    assert.ok(durableTimelineText.includes(durableEvent.event.observedAt));
  } finally {
    await aliceContext?.close();
    await bobContext?.close();
    await server.signaling.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
