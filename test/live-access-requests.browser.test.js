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
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'browser-test');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

test('access request and approval appear in two open browsers without reload', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-live-access-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const owner = addAccount(db, 'owner');
  const requester = addAccount(db, 'requester');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Live access test');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, owner.accountId);
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
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required');
  let ownerContext;
  let requesterContext;
  try {
    ownerContext = await chromium.launchPersistentContext(join(directory, 'owner'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    requesterContext = await chromium.launchPersistentContext(join(directory, 'requester'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await ownerContext.addCookies([{ name: 'whiteboard_session', value: owner.token, url: baseUrl }]);
    await requesterContext.addCookies([{ name: 'whiteboard_session', value: requester.token, url: baseUrl }]);
    const ownerPage = await ownerContext.newPage();
    const requesterPage = await requesterContext.newPage();
    const errors = [];
    for (const page of [ownerPage, requesterPage]) page.on('pageerror', (error) => errors.push(String(error)));
    const url = `${baseUrl}/boards/${boardId}`;
    await ownerPage.goto(url);
    await ownerPage.locator('#board-workspace').waitFor({ state: 'visible', timeout: 15_000 });
    await ownerPage.evaluate(() => {
      window.originalCanvas = document.querySelector('#board-canvas');
      window.originalReplicaPanel = document.querySelector('#replica-panel');
    });
    await requesterPage.goto(url);
    await requesterPage.locator('#access-request-panel').waitFor({ state: 'visible' });
    assert.equal(await requesterPage.locator('#board-workspace').isVisible(), false);
    await requesterPage.locator('#access-request-form button[type="submit"]').click();
    await requesterPage.getByText('Seu pedido está aguardando a aprovação de um membro.').waitFor();
    await ownerPage.getByRole('button', { name: 'Aceitar pedido de requester' }).waitFor({ timeout: 12_000 });
    assert.equal(await ownerPage.evaluate(() => document.querySelector('#board-canvas') === window.originalCanvas
      && document.querySelector('#replica-panel') === window.originalReplicaPanel), true);
    await ownerPage.getByRole('button', { name: 'Aceitar pedido de requester' }).click();
    await ownerPage.getByText('requester').waitFor();
    await requesterPage.locator('#board-workspace').waitFor({ state: 'visible', timeout: 12_000 });
    assert.equal(await requesterPage.locator('#board-access-message').textContent(), 'Quadro compartilhado aberto neste navegador.');
    assert.equal(await ownerPage.evaluate(() => document.querySelector('#board-canvas') === window.originalCanvas
      && document.querySelector('#replica-panel') === window.originalReplicaPanel), true);
    await ownerPage.locator('#logout-button').click();
    await ownerPage.locator('#auth-panel').waitFor({ state: 'visible' });
    let requestsAfterLogout = 0;
    ownerPage.on('request', (request) => {
      if (request.url().endsWith(`/api/boards/${boardId}/access-requests`)) requestsAfterLogout += 1;
    });
    await ownerPage.waitForTimeout(5500);
    assert.equal(requestsAfterLogout, 0, 'membership polling stops after sign-out');
    assert.deepEqual(errors, []);
  } finally {
    await ownerContext?.close();
    await requesterContext?.close();
    await server.signaling.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
