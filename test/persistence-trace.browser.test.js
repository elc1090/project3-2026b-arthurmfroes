import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { persistenceFixture } from './fixtures/room-persistence-server.js';
import { createAppServer } from '../src/server/main.js';

const executablePath = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium'].find(existsSync);
const timing = { batchMs: 200, ackMs: 600, mandateMs: 60000, staleMs: 800, recoveryMs: 2000, tickMs: 50 };

test('three real profiles collect elections and per-peer ACKs with panel closed, survive partition and server restart', { timeout: 90000 }, async () => {
  const f = await persistenceFixture();
  f.db.prepare('INSERT INTO memberships(board_id, account_id) VALUES (?, ?)').run(f.boardId, f.users[2].id);
  const { outputFiles } = await build({ entryPoints: ['src/public/board-session-entry.js'], bundle: true, format: 'esm', write: false });
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const contexts = []; const pages = []; const errors = []; const uploads = [[],[],[]]; let restarted;
  const traceRows = () => f.db.prepare('SELECT * FROM persistence_trace_events ORDER BY id').all();
  async function flush() {
    await Promise.all(pages.map((p) => p.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await window.session.persistenceTrace.flush({ reconnect: true }); })));
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.session.persistenceTrace.status.pending === 0)));
  }
  async function stop(server) { await server.signaling.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  try {
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext(); contexts.push(context);
      await context.addCookies([{ name: 'whiteboard_session', value: f.users[i].token, url: f.baseUrl }]);
      await context.route('**/__trace-real.bundle.js', (route) => route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text }));
      await context.route('**/board.bundle.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `
        export { mountBoardCanvas, mountSyncExperimentUI } from '/__trace-real.bundle.js';
        import { openBoardSession as open } from '/__trace-real.bundle.js';
        export async function openBoardSession(id, options) {
          window.session = await open(id, {...options, persistenceTiming: ${JSON.stringify(timing)}, traceOptions: {intervalMs: 100}});
          return window.session;
        }` }));
      context.on('request', (request) => { if (request.url().endsWith('/persistence') && request.postDataJSON()?.update) uploads[i].push(request.postDataJSON()); });
      const page = await context.newPage(); page.setDefaultTimeout(10000); pages.push(page); page.on('pageerror', (e) => { errors.push(String(e)); console.log('Page error', String(e)); });
      console.log('Opening profile', i); await page.goto(`${f.baseUrl}/boards/${f.boardId}`);
      await page.waitForFunction(() => window.session?.serverStatus === 'connected'); console.log('HTTP connected', i);
    }
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.session.p2pPeerCount === 2, null, { timeout: 20000 })));
    console.log('Three WebRTC profiles connected'); await pages[0].waitForTimeout(500);
    const states = await Promise.all(pages.map((p) => p.evaluate(() => window.session.persistenceStatus)));
    assert.equal(new Set(states.map((s) => s.representative)).size, 1);
    const leader = states.findIndex((s) => s.role === 'representative'); const follower = (leader + 1) % 3;
    await pages[follower].evaluate(() => window.session.doc.getMap('board').set('otherAuthor', 'saved'));
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.session.doc.getMap('board').get('otherAuthor') === 'saved' && window.session.persistenceStatus.pending === 0)));
    await flush();
    console.log('Initial ACKs flushed'); let records = traceRows().map((r) => ({...r,event:JSON.parse(r.event_json)}));
    const send = records.find((r) => r.type === 'batch-send'); assert.ok(send);
    const acks = records.filter((r) => r.type === 'ack-verified' && r.batch_id === send.batch_id);
    assert.equal(new Set(acks.map((r) => r.account_id)).size, 3);
    assert.equal(new Set(acks.map((r) => r.event.receiptId)).size, 1);
    assert.ok(acks.some((r) => r.event.data.path === 'server')); assert.equal(acks.filter((r) => r.event.data.path === 'peer').length, 2);
    assert.equal(uploads[follower].length, 0);
    // Actual app integration: opening/closing the sidebar preserves the existing Canvas and session.
    const panelPage = pages[follower];
    await panelPage.evaluate(() => { window.originalCanvas = document.querySelector('#board-canvas'); window.originalSession = window.session; });
    let historyGets = 0; panelPage.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/persistence-trace')) historyGets++; });
    assert.equal(historyGets, 0);
    await panelPage.locator('[data-workspace-mode="experiment"]').click();
    await panelPage.waitForFunction(() => document.querySelector('[data-trace-batch]'));
    await panelPage.locator(`[data-trace-batch="${send.batch_id}"] > summary`).click();
    await panelPage.waitForFunction(() => document.querySelector('[data-trace-type="server-committed"]'));
    const text = await panelPage.locator('#persistence-history').innerText();
    assert.ok(text.includes('Persistido na VPS')); assert.ok(text.includes('Fato observado pela VPS')); assert.ok(text.includes('recebido pelo P2P'));
    await panelPage.locator('[data-workspace-mode="experiment"]').click(); await panelPage.waitForTimeout(150);
    const beforeHidden = historyGets; await panelPage.waitForTimeout(2150); assert.equal(historyGets, beforeHidden);
    assert.equal(await panelPage.evaluate(() => window.originalCanvas === document.querySelector('#board-canvas') && window.originalSession === window.session), true);
    console.log('Panel lifecycle verified');
    // Pausing only the representative leaves the other two eligible to persist.
    await pages[leader].evaluate(() => window.session.pauseServerSync());
    await pages[follower].evaluate(() => window.session.doc.getMap('board').set('whileOtherPaused', true));
    await pages[follower].waitForFunction(() => window.session.persistenceStatus.pending === 0);
    assert.ok(await pages[leader].evaluate(() => window.session.persistenceStatus.paused));
    await pages[leader].evaluate(() => window.session.resumeServerSync());
    await pages[leader].waitForFunction(() => window.session.persistenceStatus.pending === 0);
    console.log('Local VPS pause verified');
    // Disconnect one profile from peers, keeping HTTP available. Its view must remain separate.
    await pages[2].evaluate(() => window.session.pausePeerSync());
    await pages[2].waitForFunction(() => window.session.p2pPeerCount === 0);
    await pages[2].evaluate(() => window.session.doc.getMap('board').set('partitioned', true));
    await pages[2].waitForFunction(() => window.session.persistenceStatus.pending === 0);
    await flush(); records = traceRows().map((r) => ({...r,event:JSON.parse(r.event_json)}));
    assert.ok(records.some((r) => r.account_id === f.users[2].id && r.type === 'batch-send' && r.event.data.reason === 'direct-recovery'));
    assert.ok(records.some((r) => r.type === 'election-view' && r.event.data.candidates.filter((c) => c.eligible).length === 1));
    await pages[2].evaluate(() => window.session.resumePeerSync());
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.session.doc.getMap('board').get('partitioned') === true)));
    console.log('Partition recovery verified');
    // Hold one representative's request beyond its deadline; another peer must finish the edit.
    const newStates = await Promise.all(pages.map((p) => p.evaluate(() => window.session.persistenceStatus)));
    const timeoutLeader = newStates.findIndex((s) => s.role === 'representative'); assert.ok(timeoutLeader >= 0);
    let intercepted = false;
    await contexts[timeoutLeader].route('**/persistence', async (route) => {
      if (!intercepted && route.request().postDataJSON()?.update) { intercepted = true; await new Promise((resolve) => setTimeout(resolve, 1100)); await route.abort().catch(() => {}); }
      else await route.continue();
    });
    await pages[timeoutLeader].evaluate(() => window.session.doc.getMap('board').set('timeoutFailover', true));
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.session.persistenceStatus.pending === 0, null, { timeout: 10000 })));
    await flush(); assert.ok(intercepted);
    assert.ok(traceRows().some((r) => r.type === 'attempt-failed' && JSON.parse(r.event_json).data.reason === 'timeout'));
    console.log('Timeout failover verified');
    await Promise.all(pages.map((p) => p.evaluate(() => window.session.destroy())));
    // The full app also owns diagnostics WebSockets outside board-session. Close those pages before stopping HTTP.
    await Promise.all(pages.map((p) => p.goto('about:blank')));
    await stop(f.server);
    const retainedCount = traceRows().length;
    restarted = await createAppServer({ db: f.db }); restarted.listen(Number(new URL(f.baseUrl).port), '127.0.0.1'); await once(restarted, 'listening');
    assert.equal(traceRows().length, retainedCount);
    await panelPage.goto(`${f.baseUrl}/boards/${f.boardId}`); await panelPage.waitForFunction(() => window.session?.serverStatus === 'connected');
    await panelPage.locator('[data-workspace-mode="experiment"]').click();
    await panelPage.waitForFunction(() => document.querySelector('[data-trace-batch]'));
    assert.ok((await panelPage.locator('#persistence-history').innerText()).includes('Persistido na VPS'));
    assert.deepEqual(errors, []);
    console.log('Trace integration:', { profiles: 3, retainedEvents: retainedCount, batchUploads: uploads.map((a) => a.length), directAndForwardedACKs: acks.length });
    await panelPage.locator('#logout-button').click();
    await panelPage.waitForFunction(() => !document.querySelector('#auth-panel').hidden);
    await panelPage.waitForFunction(() => !document.querySelector('.persistence-history'));
    const afterLogout = historyGets; await panelPage.waitForTimeout(300); assert.equal(historyGets, afterLogout);
    const otherBoard = 'trace-second-board';
    f.db.prepare('INSERT INTO boards(id, title) VALUES (?, ?)').run(otherBoard, 'Second board');
    f.db.prepare('INSERT INTO memberships(board_id, account_id) VALUES (?, ?)').run(otherBoard, f.users[follower].id);
    // Another authenticated profile opens a different board at the same origin.
    await panelPage.context().addCookies([{ name: 'whiteboard_session', value: f.users[0].token, url: f.baseUrl }]);
    f.db.prepare('INSERT OR IGNORE INTO memberships(board_id, account_id) VALUES (?, ?)').run(otherBoard, f.users[0].id);
    await panelPage.goto(`${f.baseUrl}/boards/${otherBoard}`); await panelPage.waitForFunction(() => window.session?.serverStatus === 'connected');
    await panelPage.locator('[data-workspace-mode="experiment"]').click();
    await panelPage.waitForFunction(() => document.querySelector('[data-trace-notice]').textContent.includes('Última consulta'));
    assert.equal(await panelPage.locator('[data-trace-batch]').count(), 0);
    await panelPage.evaluate(() => window.session.destroy());
  } catch (e) { console.log('Integration failure', e); throw e; } finally { console.log('Closing integration fixture'); await Promise.all(contexts.map((c) => c.close())); await browser.close(); if (restarted) await stop(restarted); await f.close(); }
});

test('history panel explains retry, late/rejected ACKs, old/expired history and preserves data through lifecycle changes', { timeout: 30000 }, async () => {
  const f = await persistenceFixture(); const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] }); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.route('**/__trace-panel', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas id="canvas"></canvas><aside id="pane" data-mode="experiment"><div id="history"></div></aside>' }));
    await page.goto(`${f.baseUrl}/__trace-panel`);
    await page.evaluate(async () => {
      const { mountPersistenceHistory } = await import('/persistence-history-ui.js');
      const rows = []; let n = 0;
      const add = (type, extra = {}, data = {}, actor = 'Alice', source = 'client') => rows.push({ id: ++n, accountId: actor, username: actor, source, receivedAt: '2026-10-22T11:00:00Z', event: { version: 1, eventId: `event-${n}`, boardId: 'test', traceSessionId: actor, docClientId: actor === 'Alice' ? '100' : '200', sequence: n, type, observedAt: '2026-10-22T10:00:00Z', monotonicMs: n, ...extra, data } });
      const candidates = [{ id: '100', token: 'a', priority: 4294967295, eligible: true }, { id: '200', token: 'b', priority: 1, eligible: true }];
      add('election-view', { electionViewId: 'view-a' }, { candidates, representative: '200', reason: 'peer-view-changed' });
      add('election-view', { electionViewId: 'view-b' }, { candidates: [candidates[0]], representative: '100', reason: 'peer-paused' }, 'Bob');
      const context = { batchId: 'new-batch', attemptId: 'first', electionViewId: 'view-a' };
      add('batch-send', context, { reason: 'representative', updateBytes: 100 });
      add('attempt-failed', context, { reason: 'timeout', elapsedMs: 4000 });
      add('ack-received', context, { path: 'server', elapsedMs: 5000 });
      add('ack-rejected', context, { reason: 'invalid-receipt', path: 'server' });
      const retry = { ...context, attemptId: 'second' };
      add('batch-send', retry, { reason: 'direct-recovery', retry: true, updateBytes: 100 });
      add('server-committed', retry, { deduplicated: true }, 'Alice', 'server');
      add('server-ack-sent', retry, {}, 'Alice', 'server');
      add('ack-verified', retry, { path: 'server', confirmedUpdates: 1, remainingUpdates: 1, elapsedMs: 20 });
      add('ack-verified', { batchId: 'new-batch', receiptId: 'receipt' }, { path: 'peer', confirmedUpdates: 1, remainingUpdates: 0 }, 'Bob');
      window.testState = { requests: [], fail: false, hold: false, release: null, active: true, unsubscribed: 0, aborted: 0 };
      window.testSession = { doc: { clientID: 100 }, persistenceStatus: { representative: '200' }, persistenceTrace: { identity: { username: 'Alice', accountId: 'Alice' }, status: { available: true }, recent: [], subscribe() { return () => window.testState.unsubscribed++; } }, on() { return () => window.testState.unsubscribed++; } };
      const fetchImpl = async (url, init) => {
        window.testState.requests.push(String(url));
        if (window.testState.fail) return new Response('{}', {status: 503});
        if (window.testState.hold) await new Promise((resolve) => { window.testState.release = resolve; init.signal.addEventListener('abort', () => { window.testState.aborted++; resolve(); }, { once: true }); });
        return Response.json({ rows, detail: [], batches: [{ batchId: 'new-batch', username: 'Alice', committedAt: '2026-10-22T11:00:00Z', updateBytes: 100 }, { batchId: 'old-batch', username: 'Bob', committedAt: '2026-10-21T10:00:00Z' }], participants: [{ accountId: 'Alice', username: 'Alice', docClientId: '100' }, { accountId: 'Bob', username: 'Bob', docClientId: '200' }], dropped: 10, nextBefore: 1, batchNext: null });
      };
      window.panel = mountPersistenceHistory({ session: window.testSession, container: document.querySelector('#history'), boardId: 'test', isActive: () => window.testState.active, fetchImpl, intervalMs: 100 });
      window.canvas = document.querySelector('#canvas');
    });
    await page.waitForFunction(() => document.querySelector('[data-trace-batch]'));
    await page.locator('[data-trace-batch="new-batch"] > summary').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-trace-batch="new-batch"]').open);
    await page.evaluate(() => window.panel.refresh());
    assert.equal(await page.evaluate(() => document.activeElement.dataset.traceFocus), 'batch:new-batch:summary');
    const body = await page.locator('#history').innerText();
    for (const phrase of ['prazo do ACK expirou', '5000 ms medidos nesta aba', 'ACK rejeitado', 'retry do mesmo lote', 'recuperação direta', 'lote já persistido', '1 pendentes', 'recebido pelo P2P', '10 registros expiraram']) assert.ok(body.includes(phrase), phrase);
    await page.locator('[data-trace-batch="old-batch"] > summary').click();
    assert.ok((await page.locator('[data-trace-batch="old-batch"]').innerText()).includes('Eleição não registrada nesta versão'));
    await page.getByText('Visões da eleição e sorteios recentes', { exact: true }).click();
    const summaries = page.locator('#history summary').filter({ hasText: /^Visão de / }); await summaries.nth(0).click(); await summaries.nth(1).click();
    await page.getByRole('button', { name: 'Comparar visão de Alice' }).click(); await page.getByRole('button', { name: 'Comparar visão de Bob' }).click();
    assert.equal(await page.locator('.trace-comparison .trace-election').count(), 2);
    assert.ok((await page.locator('.trace-comparison').innerText()).includes('4294967295'));
    await page.getByRole('searchbox', { name: 'Filtrar por lote' }).fill('new-batch'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.testState.requests.some((url) => url.includes('batchId=new-batch')));
    await page.getByRole('button', { name: 'Limpar filtros' }).click();
    await page.getByRole('combobox', { name: 'Filtrar por participante' }).selectOption('Bob'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click();
    await page.waitForFunction(() => window.testState.requests.some((url) => url.includes('participant=Bob')));
    await page.getByRole('button', { name: 'Carregar histórico anterior' }).click();
    await page.waitForFunction(() => window.testState.requests.some((url) => url.includes('before=1')));
    await page.evaluate(() => { window.testState.fail = true; }); await page.waitForFunction(() => document.querySelector('[data-trace-notice]').textContent.includes('HTTP 503'));
    assert.ok(await page.locator('[data-trace-batch="new-batch"]').count());
    // Both explicit section closure and document visibility suspend polling.
    await page.evaluate(() => { window.testState.active = false; document.querySelector('#pane').dataset.mode = 'board'; }); await page.waitForTimeout(150);
    let count = await page.evaluate(() => window.testState.requests.length); await page.waitForTimeout(250); assert.equal(await page.evaluate(() => window.testState.requests.length), count);
    await page.evaluate(() => { window.testState.active = true; Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(250); assert.equal(await page.evaluate(() => window.testState.requests.length), count);
    await page.evaluate(() => { window.testState.fail = false; window.testState.hold = true; Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.testState.release);
    await page.evaluate(() => window.panel.destroy()); await page.waitForTimeout(150);
    count = await page.evaluate(() => window.testState.requests.length); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.testState.requests.length), count);
    assert.equal(await page.locator('.persistence-history').count(), 0);
    assert.equal(await page.evaluate(() => window.testState.unsubscribed), 2);
    assert.ok(await page.evaluate(() => window.testState.aborted));
    assert.equal(await page.evaluate(() => window.canvas === document.querySelector('#canvas')), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await f.close(); }
});
