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
import { createBoardUpdateStore } from '../src/server/board-update-store.js';
import { createAppServer, openDatabase } from '../src/server/main.js';
import { readBoardElements } from '../src/shared/board-model.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Multi-client recovery fixture</title></head>
<body><script type="module">
  import '/__multiclient-bundle.js';
  const boardId = new URL(location.href).searchParams.get('boardId');
  const query = new URL(location.href).searchParams;
  window.__events = [];
  window.__session = await window.openBoardSession(boardId, {
    initialServerPaused: query.get('pauseServerSync') === 'true',
    initialPeerPaused: query.get('pausePeerSync') === 'true',
    onEvent: (type, detail) => window.__events.push({ type, detail }),
  });
  window.__session.on('durable-ack', ack => window.__events.push({ type: 'durable-ack', detail: ack }));
  window.__read = () => window.boardTestModel.readBoardElements(window.__session.doc);
  window.__add = element => window.boardTestModel.addElement(window.__session.doc, element);
  window.__move = (id, geometry) => window.boardTestModel.setElementGeometry(window.__session.doc, id, geometry);
  window.__color = (id, color) => window.boardTestModel.setElementStyle(window.__session.doc, id, 'color', color);
  window.__delete = id => window.boardTestModel.deleteElement(window.__session.doc, id);
  document.body.dataset.ready = 'true';
</script></body></html>`;

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'unused-multiclient-browser-test-hash');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

async function launchProfile(browserPath, profilePath) {
  return chromium.launchPersistentContext(profilePath, {
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function openClient(context, baseUrl, boardId, token, bundle) {
  await context.addCookies([{ name: 'whiteboard_session', value: token, url: baseUrl }]);
  await context.route('**/__multiclient-fixture*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: fixtureHtml,
  }));
  await context.route('**/__multiclient-bundle.js', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body: bundle,
  }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__multiclient-fixture?boardId=${encodeURIComponent(boardId)}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 });
  return page;
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-multiclient-recovery-'));
  const dbPath = join(directory, 'board.sqlite');
  let db = await openDatabase(dbPath);
  const users = [addAccount(db, 'recoveryalice'), addAccount(db, 'recoverybob'), addAccount(db, 'recoverycarol')];
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Multi-client recovery');
  const addMember = db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)');
  for (const user of users) addMember.run(boardId, user.accountId);

  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for multi-client recovery tests');
  const bundlePath = join(directory, 'multiclient-bundle.js');
  await build({
    absWorkingDir: root,
    entryPoints: ['test/fixtures/multiclient-recovery-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
  });
  const bundle = await readFile(bundlePath, 'utf8');
  let server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    directory, dbPath, users, boardId, browserPath, bundle,
    get server() { return server; },
    get db() { return db; },
    get baseUrl() { return baseUrl; },
    async restartServer() {
      await closeServer(server);
      db.close();
      const nextDb = await openDatabase(dbPath);
      db = nextDb;
      server = await createAppServer({ db: nextDb, assetStorageDirectory: join(directory, 'assets') });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      return server;
    },
  };
}

async function closeServer(server) {
  if (!server) return;
  await server.signaling.close();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function closeFixture(fixture, contexts) {
  await Promise.all(contexts.map(context => context?.close()));
  await closeServer(fixture.server);
  fixture.db.close();
  await rm(fixture.directory, { recursive: true, force: true });
}

async function waitForAck(page, previousCount = 0) {
  await page.waitForFunction(count => window.__events.filter(event => event.type === 'durable-ack').length > count,
    previousCount, { timeout: 10_000 });
}

async function waitForElements(page, expected) {
  await page.waitForFunction(value => JSON.stringify(window.__read()) === JSON.stringify(value), expected,
    { timeout: 15_000 });
}

async function pauseBothClients(alicePage, bobPage) {
  await Promise.all([alicePage, bobPage].flatMap(page => [
    page.evaluate(() => window.__session.pauseServerSync()),
    page.evaluate(() => window.__session.pausePeerSync()),
  ]));
  await Promise.all([alicePage, bobPage].flatMap(page => [
    page.waitForFunction(() => window.__session.serverStatus === 'paused', null, { timeout: 5_000 }),
    page.waitForFunction(() => window.__session.p2pPeerCount === 0, null, { timeout: 5_000 }),
  ]));
}

test('a late authorized browser profile reconstructs a durable board edit', { timeout: 45_000 }, async () => {
  const fixture = await createFixture();
  let aliceContext;
  let bobContext;
  try {
    aliceContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-alice'));
    const alice = await openClient(aliceContext, fixture.baseUrl, fixture.boardId, fixture.users[0].token, fixture.bundle);
    await alice.evaluate(() => window.__add({
      id: 'late-join-shape', type: 'rect', geometry: { x: 18, y: 24, width: 70, height: 42 },
      style: { color: '#243b53', strokeWidth: 3 },
    }));
    await waitForAck(alice, 0);
    const expected = [{ id: 'late-join-shape', type: 'rect', geometry: { x: 18, y: 24, width: 70, height: 42 }, style: { color: '#243b53', strokeWidth: 3 }, data: {} }];
    await waitForElements(alice, expected);

    bobContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-bob'));
    const bob = await openClient(bobContext, fixture.baseUrl, fixture.boardId, fixture.users[1].token, fixture.bundle);
    await waitForElements(bob, expected);
    const stored = createBoardUpdateStore(fixture.db).loadDocument(fixture.boardId);
    try {
      assert.deepEqual(readBoardElements(stored), expected, 'the late join and durable Y.Doc must agree');
    } finally {
      stored.destroy();
    }
  } finally {
    await closeFixture(fixture, [aliceContext, bobContext]);
  }
});

test('a board acknowledged before VPS restart is recovered by a new browser profile', { timeout: 45_000 }, async () => {
  const fixture = await createFixture();
  let aliceContext;
  let bobContext;
  try {
    aliceContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-before-restart'));
    const alice = await openClient(aliceContext, fixture.baseUrl, fixture.boardId, fixture.users[0].token, fixture.bundle);
    await alice.evaluate(() => window.__add({
      id: 'restart-shape', type: 'rect', geometry: { x: 44, y: 61, width: 36, height: 28 },
      style: { color: '#8c2f39', strokeWidth: 2 },
    }));
    await waitForAck(alice, 0);
    await aliceContext.close();
    aliceContext = null;

    await fixture.restartServer();
    bobContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-after-restart'));
    const bob = await openClient(bobContext, fixture.baseUrl, fixture.boardId, fixture.users[1].token, fixture.bundle);
    const expected = [{ id: 'restart-shape', type: 'rect', geometry: { x: 44, y: 61, width: 36, height: 28 }, style: { color: '#8c2f39', strokeWidth: 2 }, data: {} }];
    await waitForElements(bob, expected);
    const stored = createBoardUpdateStore(fixture.db).loadDocument(fixture.boardId);
    try {
      assert.deepEqual(readBoardElements(stored), expected, 'the reopened VPS store and late browser must agree');
    } finally {
      stored.destroy();
    }
  } finally {
    await closeFixture(fixture, [aliceContext, bobContext]);
  }
});

test('isolated profiles converge after partition for property edits, competing moves, and delete-versus-update', { timeout: 75_000 }, async () => {
  const fixture = await createFixture();
  let aliceContext;
  let bobContext;
  try {
    aliceContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-alice'));
    bobContext = await launchProfile(fixture.browserPath, join(fixture.directory, 'profile-bob'));
    const alice = await openClient(aliceContext, fixture.baseUrl, fixture.boardId, fixture.users[0].token, fixture.bundle);
    const bob = await openClient(bobContext, fixture.baseUrl, fixture.boardId, fixture.users[1].token, fixture.bundle);
    await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__session.p2pPeerCount > 0, null, { timeout: 15_000 })));

    const seed = async (id) => {
      await alice.evaluate(element => window.__add(element), {
        id, type: 'rect', geometry: { x: 10, y: 15, width: 50, height: 40 },
        style: { color: '#111111', strokeWidth: 2 },
      });
      await Promise.all([alice, bob].map(page => page.waitForFunction(elementId => window.__read().some(element => element.id === elementId), id, { timeout: 10_000 })));
    };
    const readAndPersist = async () => {
      const fromAlice = await alice.evaluate(() => window.__read());
      const fromBob = await bob.evaluate(() => window.__read());
      assert.deepEqual(fromAlice, fromBob, 'both browser Y.Docs must converge');
      const stored = createBoardUpdateStore(fixture.db).loadDocument(fixture.boardId);
      try { assert.deepEqual(readBoardElements(stored), fromAlice, 'the durable server replica must converge too'); }
      finally { stored.destroy(); }
      return fromAlice;
    };
    const currentUpdateCount = () => fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(fixture.boardId).count;
    const reconcile = async expected => {
      await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumeServerSync())));
      await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 })));
      await Promise.all([alice, bob].map(page => waitForElements(page, expected)));
      await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumePeerSync())));
      await Promise.all([alice, bob].map(page => waitForElements(page, expected)));
      await readAndPersist();
    };

    await seed('move-color');
    let expected = [{ id: 'move-color', type: 'rect', geometry: { x: 10, y: 15, width: 50, height: 40 }, style: { color: '#111111', strokeWidth: 2 }, data: {} }];
    await Promise.all([alice, bob].map(page => waitForElements(page, expected)));
    const moveColorUpdates = currentUpdateCount();
    await pauseBothClients(alice, bob);
    await alice.evaluate(() => window.__move('move-color', { x: 130, y: 90, width: 50, height: 40 }));
    await bob.evaluate(() => window.__color('move-color', '#d1495b'));
    expected = [{ id: 'move-color', type: 'rect', geometry: { x: 130, y: 90, width: 50, height: 40 }, style: { color: '#d1495b', strokeWidth: 2 }, data: {} }];
    assert.deepEqual(await alice.evaluate(() => window.__read()), [{ ...expected[0], style: { color: '#111111', strokeWidth: 2 } }]);
    assert.deepEqual(await bob.evaluate(() => window.__read()), [{ ...expected[0], geometry: { x: 10, y: 15, width: 50, height: 40 } }]);
    await reconcile(expected);
    assert.ok(currentUpdateCount() > moveColorUpdates, 'reconciled concurrent edits must reach durable storage');

    await seed('two-moves');
    const beforeMoveConflict = await readAndPersist();
    const twoMoveUpdates = currentUpdateCount();
    await pauseBothClients(alice, bob);
    await alice.evaluate(() => window.__move('two-moves', { x: 220, y: 35, width: 50, height: 40 }));
    await bob.evaluate(() => window.__move('two-moves', { x: 310, y: 160, width: 50, height: 40 }));
    const firstLocal = await alice.evaluate(() => window.__read().find(element => element.id === 'two-moves').geometry);
    const secondLocal = await bob.evaluate(() => window.__read().find(element => element.id === 'two-moves').geometry);
    assert.notDeepEqual(firstLocal, secondLocal, 'the profiles must hold distinct complete positions during the partition');
    const canonical = await healSameObjectMove(alice, bob, fixture, twoMoveUpdates, firstLocal, secondLocal);
    const expectedAfterMoves = beforeMoveConflict.map(element => element.id === 'two-moves' ? { ...element, geometry: canonical } : element);
    await Promise.all([alice, bob].map(page => waitForElements(page, expectedAfterMoves)));
    await readAndPersist();

    await seed('delete-update');
    const deleteUpdates = currentUpdateCount();
    await pauseBothClients(alice, bob);
    await alice.evaluate(() => window.__delete('delete-update'));
    await bob.evaluate(() => window.__color('delete-update', '#00a676'));
    assert.equal(await alice.evaluate(() => window.__read().some(element => element.id === 'delete-update')), false);
    assert.equal(await bob.evaluate(() => window.__read().find(element => element.id === 'delete-update')?.style.color), '#00a676');

    await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumeServerSync())));
    await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 })));
    await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__read().some(element => element.id === 'delete-update') === false, null, { timeout: 15_000 })));
    await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumePeerSync())));
    await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__read().some(element => element.id === 'delete-update') === false, null, { timeout: 10_000 })));
    assert.ok(currentUpdateCount() > deleteUpdates);
    const finalAlice = await alice.evaluate(() => window.__read());
    const finalBob = await bob.evaluate(() => window.__read());
    assert.deepEqual(finalAlice, finalBob);
    assert.equal(finalAlice.some(element => element.id === 'delete-update'), false, 'a property update must not resurrect the tombstone');
    const stored = createBoardUpdateStore(fixture.db).loadDocument(fixture.boardId);
    try {
      assert.deepEqual(readBoardElements(stored), finalAlice);
      assert.equal(stored.getMap('elements').get('delete-update').get('deleted'), true);
    } finally { stored.destroy(); }
  } finally {
    await closeFixture(fixture, [aliceContext, bobContext]);
  }
});

async function healSameObjectMove(alice, bob, fixture, updatesBefore, firstLocal, secondLocal) {
  await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumeServerSync())));
  await Promise.all([alice, bob].map(page => page.waitForFunction(() => window.__session.serverStatus === 'connected', null, { timeout: 10_000 })));
  const deadline = Date.now() + 15_000;
  let canonical;
  while (Date.now() < deadline) {
    const aliceGeometry = await alice.evaluate(() => window.__read().find(element => element.id === 'two-moves')?.geometry);
    const bobGeometry = await bob.evaluate(() => window.__read().find(element => element.id === 'two-moves')?.geometry);
    if (JSON.stringify(aliceGeometry) === JSON.stringify(bobGeometry)
      && [firstLocal, secondLocal].some(value => JSON.stringify(value) === JSON.stringify(aliceGeometry))) {
      canonical = aliceGeometry;
      if (fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(fixture.boardId).count > updatesBefore) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(canonical, 'concurrent moves must resolve to one complete geometry from one of the two edits');
  assert.ok(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_updates WHERE board_id = ?').get(fixture.boardId).count > updatesBefore);
  await Promise.all([alice, bob].map(page => page.evaluate(() => window.__session.resumePeerSync())));
  return canonical;
}
