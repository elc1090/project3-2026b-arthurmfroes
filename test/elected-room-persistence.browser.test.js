import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { persistenceFixture } from './fixtures/room-persistence-server.js';
import { createBoardUpdateStore } from '../src/server/board-update-store.js';

const timing = { batchMs: 300, ackMs: 1000, mandateMs: 10000, staleMs: 700, recoveryMs: 1200, tickMs: 50 };

test('real WebRTC elects one uploader, propagates signed ACKs, fails over and restores offline edits', { timeout: 60000 }, async () => {
  const f = await persistenceFixture();
  const { outputFiles } = await build({ entryPoints: ['src/public/board-session-entry.js'], bundle: true, format: 'esm', write: false });
  const executablePath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const contexts = []; const pages = []; const uploads = [[], []]; const errors = [];
  async function open(i, paused = false) {
    const page = await contexts[i].newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${f.baseUrl}/__elected-test?paused=${paused}`);
    await page.waitForFunction(() => window.session || window.failure, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.failure), undefined);
    return page;
  }
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext(); contexts.push(context);
      await context.addCookies([{ name: 'whiteboard_session', value: f.users[i].token, url: f.baseUrl }]);
      await context.route('**/__elected.bundle.js', (route) => route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text }));
      await context.route('**/__elected-test*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="module">
        import { openBoardSession } from '/__elected.bundle.js';
        const paused = new URL(location.href).searchParams.get('paused') === 'true';
        window.events = [];
        try { window.session = await openBoardSession('${f.boardId}', { initialServerPaused: paused, initialPeerPaused: paused, persistenceTiming: ${JSON.stringify(timing)}, onEvent: (type, detail) => window.events.push({type, detail}) }); } catch (error) { window.failure = String(error); }
      </script>` }));
      context.on('request', (request) => {
        if (!request.url().endsWith('/persistence')) return;
        const body = request.postDataJSON(); if (body?.update) uploads[i].push(body);
      });
      pages.push(await open(i));
    }
    await Promise.all(pages.map((page) => page.waitForFunction(() => window.session.p2pPeerCount > 0, null, { timeout: 20000 })));
    for (const page of pages) await page.waitForFunction(() => window.session.serverStatus === 'connected');
    // Give the two observed candidate sets time to agree before measuring stable operation.
    await pages[0].waitForTimeout(400);
    const states = await Promise.all(pages.map((page) => page.evaluate(() => window.session.persistenceStatus)));
    assert.equal(states[0].representative, states[1].representative);
    const leader = states.findIndex((s) => s.role === 'representative'); assert.ok(leader >= 0);
    const follower = 1 - leader;
    for (const page of pages) await page.evaluate(() => window.session.resetExperimentMetrics());
    uploads.forEach((list) => { list.length = 0; });
    await pages[leader].evaluate(() => { for (let i = 0; i < 3; i++) window.session.doc.getMap('board').set(`leader${i}`, i); });
    await pages[follower].evaluate(() => { for (let i = 0; i < 3; i++) window.session.doc.getMap('board').set(`follower${i}`, i); });
    await Promise.all(pages.map((page) => page.waitForFunction(() => window.session.doc.getMap('board').size === 6 && window.session.persistenceStatus.pending === 0, null, { timeout: 10000 })));
    assert.ok(uploads[leader].length > 0); assert.equal(uploads[follower].length, 0);
    assert.equal(await pages[follower].evaluate(() => window.events.some(({type, detail}) => type === 'durable-ack' && detail.sourcePath === 'peer-receipt')), true);
    assert.equal(await pages[follower].evaluate(() => window.session.experimentMetrics.http.sent.updateMessages), 0);
    assert.ok(await pages[leader].evaluate(() => window.session.experimentMetrics.http.sent.updateMessages > 0));
    console.log('Stable room uploads:', uploads.map((list) => list.length), 'durable rows:', f.db.prepare('SELECT COUNT(*) AS n FROM board_updates').get().n);
    await pages[leader].evaluate(() => window.session.destroy()); await pages[leader].close();
    await pages[follower].evaluate(() => window.session.doc.getMap('board').set('afterLeaderExit', true));
    await pages[follower].waitForFunction(() => window.session.persistenceStatus.pending === 0 && window.session.persistenceStatus.role === 'representative', null, { timeout: 10000 });
    assert.ok(uploads[follower].length > 0);
    await pages[follower].evaluate(() => { window.session.pauseServerSync(); window.session.pausePeerSync(); window.session.doc.getMap('board').set('offline', true); });
    await pages[follower].evaluate(() => window.session.destroy()); await pages[follower].close();
    pages[follower] = await open(follower, true);
    assert.equal(await pages[follower].evaluate(() => window.session.doc.getMap('board').get('offline')), true);
    const before = createBoardUpdateStore(f.db).loadDocument(f.boardId); assert.equal(before.getMap('board').has('offline'), false); before.destroy();
    await pages[follower].evaluate(() => window.session.resumeServerSync());
    await pages[follower].waitForFunction(() => window.session.persistenceStatus.pending === 0 && window.session.serverStatus === 'connected', null, { timeout: 10000 });
    const recovered = createBoardUpdateStore(f.db).loadDocument(f.boardId); assert.equal(recovered.getMap('board').get('offline'), true); recovered.destroy();
    // With no P2P, the other client catches up by periodic HTTP recovery.
    pages[leader] = await open(leader, true);
    await pages[leader].evaluate(() => window.session.resumeServerSync());
    await pages[leader].waitForFunction(() => window.session.doc.getMap('board').get('offline') === true, null, { timeout: 10000 });
    await pages[follower].evaluate(() => window.session.doc.getMap('board').set('serverOnly', 1));
    await pages[leader].waitForFunction(() => window.session.doc.getMap('board').get('serverOnly') === 1, null, { timeout: 10000 });
    assert.deepEqual(errors, []);
    for (const page of pages) await page.evaluate(() => window.session.destroy());
  } finally { await Promise.all(contexts.map((context) => context.close())); await browser.close(); await f.close(); }
});
