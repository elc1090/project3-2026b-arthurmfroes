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
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Board revocation test</title></head>
<body><script type="module">
  import { openBoardSession } from '/board.bundle.js';
  const boardId = new URL(location.href).searchParams.get('boardId');
  window.__events = [];
  try {
    window.__session = await openBoardSession(boardId);
    for (const type of ['membership-revoked', 'session-expired', 'p2p-status', 'p2p-peers-removed']) {
      window.__session.on(type, detail => window.__events.push({ type, detail }));
    }
    window.__session.doc.getMap('revocation-probe').set('local-copy', 'retained');
    document.body.dataset.ready = 'true';
  } catch (error) {
    document.body.dataset.error = String(error);
  }
</script></body></html>`;

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

async function openSessionPage(context, baseUrl, boardId) {
  await context.route('**/__revocation-browser-test*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__revocation-browser-test?boardId=${encodeURIComponent(boardId)}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.error, null, { timeout: 10_000 });
  const error = await page.locator('body').getAttribute('data-error');
  assert.equal(error, null, error ?? undefined);
  return page;
}

test('revocation closes active old WebRTC rooms and only remaining members reconnect to the new epoch', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-browser-revocation-'));
  const db = await openDatabase(join(directory, 'revocation.sqlite'));
  const alice = addAccount(db, 'revokealice');
  const bob = addAccount(db, 'revokebob');
  const carol = addAccount(db, 'revokecarol');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Active room revocation');
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
  assert.ok(browserPath, 'a local Chromium executable is required for the revocation browser test');
  let aliceContext;
  let bobContext;
  let carolContext;

  try {
    aliceContext = await chromium.launchPersistentContext(join(directory, 'profile-a'), {
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    bobContext = await chromium.launchPersistentContext(join(directory, 'profile-b'), {
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await Promise.all([
      aliceContext.addCookies([{ name: 'whiteboard_session', value: alice.token, url: baseUrl }]),
      bobContext.addCookies([{ name: 'whiteboard_session', value: bob.token, url: baseUrl }]),
    ]);
    const alicePage = await openSessionPage(aliceContext, baseUrl, boardId);
    const bobPage = await openSessionPage(bobContext, baseUrl, boardId);
    await Promise.all([alicePage, bobPage].map((page) => page.waitForFunction(
      () => window.__session.p2pPeerCount > 0 && window.__session.p2pStatus.topic,
      null,
      { timeout: 20_000 },
    )));
    const oldTopics = await Promise.all([alicePage, bobPage].map((page) => page.evaluate(() => window.__session.p2pStatus.topic)));
    assert.equal(oldTopics[0], oldTopics[1]);
    assert.deepEqual(await alicePage.evaluate(() => window.__session.p2pStatus.bcPeers), []);
    assert.deepEqual(await bobPage.evaluate(() => window.__session.p2pStatus.bcPeers), []);

    const revoke = await fetch(`${baseUrl}/api/boards/${boardId}/members/${alice.accountId}/revoke`, {
      method: 'POST',
      headers: { cookie: `whiteboard_session=${bob.token}` },
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).epoch, 2);

    await alicePage.waitForFunction(
      () => window.__events.some(({ type }) => type === 'membership-revoked'),
      null,
      { timeout: 10_000 },
    );
    await bobPage.waitForFunction(
      (previousTopic) => window.__session.p2pStatus.epoch === 2
        && window.__session.p2pStatus.topic !== previousTopic
        && window.__session.p2pPeerCount === 0,
      oldTopics[1],
      { timeout: 15_000 },
    );
    await Promise.all([alicePage, bobPage].map((page, index) => page.waitForFunction(
      (oldTopic) => window.__events.some(({ type, detail }) => type === 'p2p-peers-removed' && detail.topic === oldTopic),
      oldTopics[index],
      { timeout: 10_000 },
    )));

    assert.equal(await alicePage.evaluate(() => window.__session.p2pStatus.topic), null,
      'the revoked browser must not reconnect a WebRTC room');
    assert.equal(await alicePage.evaluate(() => window.__session.doc.getMap('revocation-probe').get('local-copy')), 'retained',
      'revocation cannot erase a document copy already stored in the offline browser');
    const deniedRoomAccess = await alicePage.evaluate(async (id) => (
      await fetch(`/api/boards/${encodeURIComponent(id)}/signaling`)
    ).status, boardId);
    assert.equal(deniedRoomAccess, 403, 'the revoked account cannot receive credentials for the new epoch');

    const request = await fetch(`${baseUrl}/api/boards/${boardId}/access-requests`, {
      method: 'POST',
      headers: { cookie: `whiteboard_session=${carol.token}` },
    });
    assert.equal(request.status, 201);
    const accept = await fetch(`${baseUrl}/api/boards/${boardId}/access-requests/${carol.accountId}/accept`, {
      method: 'POST',
      headers: { cookie: `whiteboard_session=${bob.token}` },
    });
    assert.equal(accept.status, 200);

    carolContext = await chromium.launchPersistentContext(join(directory, 'profile-c'), {
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await carolContext.addCookies([{ name: 'whiteboard_session', value: carol.token, url: baseUrl }]);
    const carolPage = await openSessionPage(carolContext, baseUrl, boardId);
    await Promise.all([bobPage, carolPage].map((page) => page.waitForFunction(
      () => window.__session.p2pPeerCount > 0 && window.__session.p2pStatus.epoch === 2,
      null,
      { timeout: 20_000 },
    )));
    assert.equal(
      await bobPage.evaluate(() => window.__session.p2pStatus.topic),
      await carolPage.evaluate(() => window.__session.p2pStatus.topic),
      'remaining and newly approved members join the same new epoch room',
    );
    await carolPage.evaluate(() => window.__session.doc.getMap('epoch-probe').set('new-room', 'authorized-peer'));
    await bobPage.waitForFunction(
      () => window.__session.doc.getMap('epoch-probe').get('new-room') === 'authorized-peer',
      null,
      { timeout: 10_000 },
    );
    assert.equal(await alicePage.evaluate(() => window.__session.doc.getMap('epoch-probe').has('new-room')), false,
      'the revoked peer does not receive edits from the replacement room');
    await alicePage.evaluate(() => window.__session.resumePeerSync());
    await alicePage.waitForTimeout(250);
    assert.equal(await alicePage.evaluate(() => window.__session.p2pStatus.topic), null);
    assert.equal(await alicePage.evaluate(() => window.__session.p2pPeerCount), 0);
  } finally {
    await aliceContext?.close();
    await bobContext?.close();
    await carolContext?.close();
    await server.signaling.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
