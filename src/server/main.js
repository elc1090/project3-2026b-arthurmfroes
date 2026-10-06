import { createServer } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { handleAuthRequest } from './auth.js';
import { handleBoardRequest } from './boards.js';
import { createBoardUpdateStore } from './board-update-store.js';
import { attachBoardSync } from './board-sync.js';
import { attachSignaling, createSignalingState, handleSignalingHttpRequest } from './signaling.js';
import { handleAssetRequest } from './assets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const publicDir = resolve(root, 'src/public');
const migrationDir = resolve(root, 'src/server/migrations');
const templateDir = resolve(root, 'whiteboard/templates');
const templates = new Map([
  ['fsm-reference', { filename: 'completo_multi_fsm_10_estados.png', contentType: 'image/png' }],
]);

export async function openDatabase(
  filename = process.env.DATABASE_PATH ?? resolve(root, 'data/whiteboard.sqlite'),
  migrationsPath = migrationDir,
) {
  await mkdir(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  try {
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
    const filenames = (await readdir(migrationsPath))
      .filter((name) => /^\d{3}-.+\.sql$/.test(name))
      .sort((left, right) => Number(left.slice(0, 3)) - Number(right.slice(0, 3)));
    const versions = new Set();
    for (const name of filenames) {
      const version = Number(name.slice(0, 3));
      if (versions.has(version)) throw new Error(`Duplicate migration version ${version}`);
      versions.add(version);
      if (applied.has(version)) continue;

      const sql = await readFile(resolve(migrationsPath, name), 'utf8');
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
      });
      apply();
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function createAppServer(options = {}) {
  const db = options.db ?? await openDatabase();
  const boardUpdateStore = options.boardUpdateStore ?? createBoardUpdateStore(db);
  const assetStorageDirectory = options.assetStorageDirectory ?? resolve(root, 'data/assets');
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const signalingState = options.signalingState ?? createSignalingState(
    process.env.SIGNALING_SECRET ? Buffer.from(process.env.SIGNALING_SECRET) : undefined,
  );
  let notifyBoardEpochChanged = () => {};
  const server = createServer(async (request, response) => {
    if (await handleAuthRequest(request, response, db, { trustProxy })) return;
    if (handleSignalingHttpRequest(request, response, db, signalingState)) return;
    if (await handleAssetRequest(request, response, db, assetStorageDirectory)) return;
    if (await handleBoardRequest(request, response, db, boardUpdateStore, {
      onBoardEpochChanged: (boardId, epoch) => notifyBoardEpochChanged(boardId, epoch),
    })) return;

    const templateMatch = request.url.match(/^\/api\/templates\/([a-z0-9-]+)$/);
    if (request.method === 'GET' && templateMatch) {
      const template = templates.get(templateMatch[1]);
      if (!template) {
        response.writeHead(404).end();
        return;
      }
      try {
        const image = await readFile(resolve(templateDir, template.filename));
        response.writeHead(200, {
          'content-type': template.contentType,
          'content-length': image.length,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        });
        response.end(image);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    let requestedPath;
    try {
      const path = request.url.split('?')[0];
      const isBoardLink = /^\/boards\/[^/]+\/?$/.test(path);
      requestedPath = request.url === '/' || isBoardLink
        ? 'index.html'
        : decodeURIComponent(request.url.slice(1).split('?')[0]);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const filePath = resolve(publicDir, requestedPath);
    if (!filePath.startsWith(`${publicDir}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      const extension = filePath.slice(filePath.lastIndexOf('.'));
      response.writeHead(200, { 'content-type': contentTypes[extension] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  attachBoardSync(server, {
    db,
    updateStore: boardUpdateStore,
    onSyncEvent: options.onSyncEvent,
  });
  server.signaling = attachSignaling(server, db, signalingState);
  notifyBoardEpochChanged = server.signaling.notifyBoardEpochChanged;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await openDatabase();
  const server = await createAppServer({ db });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Whiteboard T3 ouvindo em http://127.0.0.1:${port}`));
}
