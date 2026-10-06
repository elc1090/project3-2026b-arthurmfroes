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

function addAccount(db) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)').run(accountId, 'historyvisual', 'history-browser');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

test('browser renders retained object diffs side by side and shows replica clock metadata', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-inspection-history-browser-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const user = addAccount(db);
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Visual history');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, user.accountId);
  await build({ absWorkingDir: root, entryPoints: ['src/public/board-session-entry.js'], bundle: true, format: 'esm', outfile: join(root, 'src/public/board.bundle.js') });
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this visual browser test');
  let context;
  try {
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await context.addCookies([{ name: 'whiteboard_session', value: user.token, url: baseUrl }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await page.goto(`${baseUrl}/boards/${boardId}`);
    try { await page.locator('#board-workspace').waitFor({ state: 'visible', timeout: 15_000 }); }
    catch (error) {
      const state = await page.evaluate(async () => ({ account: document.querySelector('#account-name')?.textContent,
        message: document.querySelector('#message')?.textContent, session: await fetch('/api/auth/session').then((r) => r.json()),
        failed: performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).map((r) => r.name) }));
      throw new Error(`Board page did not open: ${JSON.stringify({ state, pageErrors })}`, { cause: error });
    }
    await page.locator('#replica-history').waitFor({ state: 'visible' });

    const replicaId = `peer:${randomUUID()}`;
    await page.evaluate(async ({ boardId, replicaId }) => {
      const url = new URL(`/api/boards/${boardId}/replicas`, location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('replicaId', replicaId.slice('peer:'.length));
      const socket = new WebSocket(url);
      window.__historySyntheticSocket = socket;
      const welcome = new Promise((resolve, reject) => {
        const onMessage = event => { if (JSON.parse(event.data).type === 'welcome') { socket.removeEventListener('message', onMessage); resolve(); } };
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', reject, { once: true });
      });
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      await welcome;
      const send = message => socket.send(JSON.stringify(message));
      send({ type: 'snapshot', elements: [{ id: 'shared-rect', type: 'rect', geometry: { x: 10, y: 15, width: 35, height: 25 }, style: { color: '#dc2626', strokeWidth: 3 }, data: {} }] });
      await new Promise(resolve => setTimeout(resolve, 70));
      send({ type: 'snapshot', elements: [{ id: 'shared-rect', type: 'rect', geometry: { x: 48, y: 15, width: 35, height: 25 }, style: { color: '#2563eb', strokeWidth: 3 }, data: {} }] });
      send({ type: 'event', event: { type: 'update-observed', sequence: 17, observedAt: 'replica-clock:17', updateBytes: 321 } });
    }, { boardId, replicaId });
    server.replicaDiagnostics.publishServerEvent(boardId, 'durable-persisted', {
      replicaId: 'vps:diagnostic-instance-7', sequence: 18, observedAt: 'vps-clock:18', committedAt: '2026-10-06T10:00:00.000Z', updateBytes: 99,
    });

    await page.waitForFunction((id) => [...document.querySelectorAll('#replica-history [data-history-snapshots] [data-snapshot-id]')]
      .filter((item) => item.textContent.includes(id)).length >= 2, replicaId, { timeout: 15_000 });
    const latest = page.locator('#replica-history [data-history-snapshots] [data-snapshot-id]').filter({ hasText: replicaId }).first();
    await latest.locator('button').click();
    await page.locator('[data-history-diff]').waitFor({ state: 'visible' });
    assert.match(await page.locator('[data-history-diff-summary]').textContent(), /1 alterados/);
    const changed = page.locator('[data-history-diff-items] article').filter({ hasText: 'Alterado · shared-rect' });
    await changed.waitFor({ state: 'visible' });
    assert.equal(await changed.locator('canvas').count(), 2, 'before and after objects have separate visual canvases');
    const renderedPixels = await changed.locator('canvas').first().evaluate((canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return [...data].filter((value, index) => index % 4 !== 3 && value < 100).length;
    });
    assert.ok(renderedPixels > 50, 'the object preview contains rendered colored geometry');
    await page.locator('#replica-history [data-history-events]').getByText(/peer:.*update-observed.*seq 17.*relógio replica-clock:17/).waitFor({ timeout: 10_000 });
    await page.locator('#replica-history [data-history-events]').getByText(/vps:diagnostic-instance-7.*durable-persisted.*seq 18.*relógio vps-clock:18/).waitFor({ timeout: 10_000 });
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
