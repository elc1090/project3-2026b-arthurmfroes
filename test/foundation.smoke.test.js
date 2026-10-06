import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppServer, openDatabase } from '../src/server/main.js';

test('foundation serves its static entry and applies the SQLite foundation migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-'));
  const db = await openDatabase(join(directory, 'test.sqlite'));
  const server = await createAppServer({ db });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Whiteboard T3/);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
    for (const table of ['accounts', 'sessions', 'boards', 'memberships', 'access_requests', 'board_updates', 'board_checkpoints', 'assets', 'diagnostic_events']) {
      assert.ok(tables.includes(table), `missing migration table: ${table}`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);

    const reopened = await openDatabase(join(directory, 'test.sqlite'));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
    reopened.close();
  } finally {
    server.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
