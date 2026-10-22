import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAppServer, openDatabase } from '../../src/server/main.js';

export async function persistenceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'room-persistence-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards(id, title) VALUES (?, ?)').run(boardId, 'Delegated');
  const users = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(); const token = randomUUID();
    db.prepare('INSERT INTO accounts(id, username, password_hash) VALUES (?, ?, ?)').run(id, `member${i}`, 'unused');
    db.prepare('INSERT INTO sessions(id, account_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), id, new Date(Date.now() + 3600000).toISOString());
    if (i < 2) db.prepare('INSERT INTO memberships(board_id, account_id) VALUES (?, ?)').run(boardId, id);
    users.push({ id, token });
  }
  const server = await createAppServer({ db }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const url = `${baseUrl}/api/boards/${boardId}/persistence`;
  async function request(body, user = users[0], target = url) {
    return fetch(target, { method: body ? 'POST' : 'GET', headers: { ...(user ? { cookie: `whiteboard_session=${user.token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
  return { directory, db, users, server, baseUrl, url, boardId, request, async close() {
    await server.signaling.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true });
  } };
}
