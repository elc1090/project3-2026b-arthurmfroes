import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Board timeline test</title></head>
<body><main id="timeline"></main><script type="module">
  import '/__timeline-bundle.js';
  const boardId = new URL(location.href).searchParams.get('boardId');
  window.__session = await window.openBoardSession(boardId);
  window.__timeline = window.mountBoardTimelineUI({
    session: window.__session,
    container: document.querySelector('#timeline'),
  });
  window.__add = element => window.addBoardElement(window.__session.doc, element);
  window.__color = (id, color) => window.setBoardElementStyle(window.__session.doc, id, 'color', color);
  document.body.dataset.ready = 'true';
</script></body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-timeline-browser-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

async function openPage(context, baseUrl, boardId, token, bundle) {
  await context.addCookies([{ name: 'whiteboard_session', value: token, url: baseUrl }]);
  await context.route('**/__timeline-fixture*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  await context.route('**/__timeline-bundle.js', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body: bundle,
  }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__timeline-fixture?boardId=${encodeURIComponent(boardId)}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 });
  return page;
}

test('timeline shows peer receipt before VPS persistence and correlates local size by observed update hash', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-event-timeline-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const alice = addAccount(db, 'timelinealice');
  const bob = addAccount(db, 'timelinebob');
  const carol = addAccount(db, 'timelinecarol');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Event timeline test');
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  addMember.run(boardId, alice.accountId);
  addMember.run(boardId, bob.accountId);
  addMember.run(boardId, carol.accountId);

  const bundlePath = join(directory, 'timeline-bundle.js');
  await build({
    absWorkingDir: root,
    entryPoints: ['test/fixtures/board-timeline-ui-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
  });
  const bundle = await readFile(bundlePath, 'utf8');
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for the real-browser timeline test');
  let aliceContext;
  let bobContext;
  let carolContext;
  try {
    aliceContext = await chromium.launchPersistentContext(join(directory, 'profile-alice'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    bobContext = await chromium.launchPersistentContext(join(directory, 'profile-bob'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const alicePage = await openPage(aliceContext, baseUrl, boardId, alice.token, bundle);
    const bobPage = await openPage(bobContext, baseUrl, boardId, bob.token, bundle);
    await Promise.all([alicePage, bobPage].map(page => page.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 })));

    await Promise.all([alicePage, bobPage].map(page => page.evaluate(() => window.__session.pauseServerSync())));
    await Promise.all([alicePage, bobPage].map(page => page.waitForFunction(() => window.__session.serverStatus === 'paused', null, { timeout: 5_000 })));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0);

    await alicePage.evaluate(() => window.__add({
      id: 'timeline-shape', type: 'rect', geometry: { x: 24, y: 38, width: 65, height: 44 },
      style: { color: '#2f6690', strokeWidth: 3 },
    }));
    await alicePage.evaluate(() => window.__color('timeline-shape', '#bb3e03'));
    await Promise.all([
      alicePage.waitForFunction(() => document.querySelectorAll('[data-event-type="update-local"]').length >= 2, null, { timeout: 10_000 }),
      bobPage.waitForFunction(() => document.querySelectorAll('[data-event-type="update-peer-room"]').length >= 2, null, { timeout: 15_000 }),
    ]);
    await Promise.all([
      alicePage.locator('[data-event-type="update-local"]').last().waitFor({ state: 'visible', timeout: 10_000 }),
      bobPage.locator('[data-event-type="update-peer-room"]').last().waitFor({ state: 'visible', timeout: 15_000 }),
    ]);
    await bobPage.waitForFunction(() => window.__session.doc.getMap('elements').get('timeline-shape')
      ?.get('style')?.get('color') === '#bb3e03', null, { timeout: 15_000 });
    const localRow = alicePage.locator('[data-event-type="update-local"]').last();
    const peerRow = bobPage.locator('[data-event-type="update-peer-room"]').last();
    const localHash = (await localRow.locator('[data-field="action-id"]').textContent()).replace('ID do update: ', '');
    const peerHash = (await peerRow.locator('[data-field="action-id"]').textContent()).replace('ID do update: ', '');
    assert.match(localHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(peerHash, localHash, 'the peer first observes the same unmerged update bytes');
    assert.match(await localRow.locator('[data-field="update-bytes"]').textContent(), /\d+ bytes/);
    assert.match(await peerRow.locator('[data-field="update-bytes"]').textContent(), /\d+ bytes/);
    assert.match(await peerRow.locator('[data-field="first-arrival-path"]').textContent(), /peer-room/);
    assert.ok(Number(await localRow.getAttribute('data-sequence')) > 0);
    assert.equal(await alicePage.locator('[data-event-type="durable-ack"]').count(), 0,
      'a P2P receipt must not appear as server persistence');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count, 0,
      'the server replica has not persisted the edit while its sync path is paused');

    await alicePage.evaluate(() => window.__session.resumeServerSync());
    const ackRow = alicePage.locator('[data-event-type="durable-ack"]').filter({ hasText: localHash }).last();
    await ackRow.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal((await ackRow.locator('[data-field="action-id"]').textContent()).replace('ID do update: ', ''), localHash);
    assert.equal(await ackRow.locator('[data-field="update-bytes"]').textContent(), await localRow.locator('[data-field="update-bytes"]').textContent(),
      'the timeline uses byte count only when the observed hash matches this update');
    assert.ok(Number(await ackRow.getAttribute('data-sequence')) > Number(await localRow.getAttribute('data-sequence')),
      'sequence numbers order observations within Alice only');
    assert.match(await alicePage.locator('.board-timeline').textContent(), /não impõe uma ordem global/);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(boardId).count > 0);
    await bobPage.waitForFunction(() => window.__session.doc.getMap('elements').has('timeline-shape'), null, { timeout: 10_000 });

    carolContext = await chromium.launchPersistentContext(join(directory, 'profile-carol'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const carolPage = await openPage(carolContext, baseUrl, boardId, carol.token, bundle);
    const syncBatchRow = carolPage.locator('[data-event-type="sync-batch"]').last();
    await syncBatchRow.waitFor({ state: 'visible', timeout: 15_000 });
    const syncBatchHash = (await syncBatchRow.locator('[data-field="action-id"]').textContent()).replace('ID do update: ', '');
    assert.notEqual(syncBatchHash, localHash,
      'the late-join state-vector batch has its own byte digest; it is not relabeled as the earlier individual update');
    assert.match(await syncBatchRow.locator('[data-field="update-bytes"]').textContent(), /\d+ bytes/);
    assert.match(await syncBatchRow.textContent(), /Lote de sincronização recebido via server/);

    const vpsActionId = `sha256:${'a'.repeat(64)}`;
    await alicePage.evaluate(actionId => {
      window.__timeline.appendEvent('server-received', {
        replicaId: 'vps:test', sequence: 40, observedAt: '2026-10-06T12:00:00.000Z',
        actionId, updateBytes: 321, firstArrivalPath: 'client',
      });
      window.__timeline.appendEvent('durable-persisted', {
        replicaId: 'vps:test', sequence: 41, observedAt: '2026-10-06T12:00:00.010Z',
        actionId, updateBytes: 321, committedAt: '2026-10-06T12:00:00.010Z',
      });
    }, vpsActionId);
    const serverReceivedRow = alicePage.locator('[data-event-type="server-received"]').last();
    const persistedRow = alicePage.locator('[data-event-type="durable-persisted"]').last();
    assert.match(await serverReceivedRow.textContent(), /VPS recebeu update/);
    assert.match(await persistedRow.textContent(), /VPS confirmou persistência/);
    assert.match(await persistedRow.textContent(), /relógio da réplica indicada/);
    assert.equal((await persistedRow.locator('[data-field="action-id"]').textContent()).includes(vpsActionId), true);

    await alicePage.evaluate(() => {
      const container = document.createElement('main');
      container.id = 'bounded-timeline-container';
      document.body.append(container);
      window.__boundedTimeline = window.mountBoardTimelineUI({
        session: window.__session, container, limit: 2,
      });
      const now = '2026-10-06T12:30:00.000Z';
      window.__boundedTimeline.appendEvent('update-observed', {
        replicaId: 'browser:test', sequence: 1, observedAt: now,
        actionId: `sha256:${'1'.repeat(64)}`, sourcePath: 'local', updateBytes: 11,
      });
      window.__boundedTimeline.appendEvent('update-observed', {
        replicaId: 'browser:test', sequence: 2, observedAt: now,
        actionId: `sha256:${'2'.repeat(64)}`, sourcePath: 'local', updateBytes: 22,
      });
      window.__boundedTimeline.appendEvent('update-observed', {
        replicaId: 'browser:test', sequence: 3, observedAt: now,
        actionId: `sha256:${'3'.repeat(64)}`, sourcePath: 'local', updateBytes: 33,
      });
      window.__boundedTimeline.appendEvent('durable-ack', {
        replicaId: 'browser:test', sequence: 4, observedAt: now,
        actionId: `sha256:${'1'.repeat(64)}`,
      });
      window.__boundedTimeline.appendEvent('durable-ack', {
        replicaId: 'browser:test', sequence: 5, observedAt: now,
        actionId: `sha256:${'3'.repeat(64)}`,
      });
    });
    const boundedTimeline = alicePage.locator('#bounded-timeline-container .board-timeline');
    assert.equal(await boundedTimeline.locator('.board-timeline__events > li').count(), 2,
      'the visible rows remain bounded by the requested limit');
    assert.equal(await boundedTimeline.locator('[data-event-type="durable-ack"]').nth(0).locator('[data-field="update-bytes"]').textContent(), 'Tamanho: indisponível',
      'a byte-size hash older than the retained cache is not guessed');
    assert.equal(await boundedTimeline.locator('[data-event-type="durable-ack"]').nth(1).locator('[data-field="update-bytes"]').textContent(), 'Tamanho: 33 bytes',
      'a recent matching update hash still supplies its observed byte count');

    await alicePage.evaluate(() => {
      window.__boundedTimeline.destroy();
      window.__timeline.destroy();
    });
    assert.equal(await alicePage.locator('#timeline .board-timeline').count(), 0, 'destroy removes the panel and its event listeners');
  } finally {
    await aliceContext?.close();
    await bobContext?.close();
    await carolContext?.close();
    await server.signaling.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
