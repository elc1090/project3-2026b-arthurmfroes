import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

    const malformedPath = await fetch(`${baseUrl}/%E0%A4%A`);
    assert.equal(malformedPath.status, 400);

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

test('numbered SQL migrations run in order and are not repeated after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-migrations-'));
  const migrations = join(directory, 'migrations');
  const database = join(directory, 'test.sqlite');
  await mkdir(migrations);
  await writeFile(join(migrations, '001-seed.sql'), 'CREATE TABLE migration_runs (name TEXT PRIMARY KEY);');
  await writeFile(join(migrations, '002-second.sql'), "INSERT INTO migration_runs (name) VALUES ('second');");

  try {
    const db = await openDatabase(database, migrations);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_runs WHERE name = \'second\'').get().count, 1);
    db.close();

    const reopened = await openDatabase(database, migrations);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM migration_runs WHERE name = \'second\'').get().count, 1);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
