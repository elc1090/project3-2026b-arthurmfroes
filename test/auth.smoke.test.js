import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppServer, openDatabase } from '../src/server/main.js';

async function withServer(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-auth-'));
  const db = await openDatabase(join(directory, 'auth.sqlite'));
  const server = await createAppServer({ db, trustProxy: options.trustProxy ?? false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run(`http://127.0.0.1:${server.address().port}`, db);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function postJson(baseUrl, route, body, headers = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('registration stores Argon2id only; login, session lookup, and logout work with HTTPS cookie flags', async () => {
  await withServer(async (baseUrl, db) => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Criar conta/);

    const password = 'correct horse battery staple';
    const registration = await postJson(baseUrl, '/api/auth/register', { username: ' Arthur ', password });
    assert.equal(registration.status, 201);
    assert.deepEqual((await registration.json()).account.username, 'arthur');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);

    const secondRegistration = await postJson(baseUrl, '/api/auth/register', { username: 'beatrice', password: 'another secure phrase' });
    assert.equal(secondRegistration.status, 201);
    const hashes = db.prepare('SELECT password_hash FROM accounts ORDER BY username').all().map(({ password_hash }) => password_hash);
    assert.ok(hashes.every((hash) => hash.startsWith('$argon2id$')));
    assert.notEqual(hashes[0].split('$')[4], hashes[1].split('$')[4], 'accounts must have distinct salts');

    const storedValues = JSON.stringify({
      accounts: db.prepare('SELECT username, password_hash FROM accounts').all(),
      sessions: db.prepare('SELECT id, account_id, expires_at FROM sessions').all(),
    });
    assert.equal(storedValues.includes(password), false, 'plaintext password must not appear in persistent account/session data');

    const invalidLogin = await postJson(baseUrl, '/api/auth/login', { username: 'arthur', password: 'wrong password' });
    assert.equal(invalidLogin.status, 401);
    assert.equal(invalidLogin.headers.get('set-cookie'), null);

    const login = await postJson(baseUrl, '/api/auth/login', { username: 'arthur', password }, { 'x-forwarded-proto': 'https' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Secure/i);
    const rawToken = cookie.match(/^whiteboard_session=([^;]+)/)[1];
    const storedSessionId = db.prepare('SELECT id FROM sessions').get().id;
    assert.notEqual(storedSessionId, rawToken, 'SQLite stores a digest instead of the browser bearer token');
    const storedAfterLogin = JSON.stringify({
      accounts: db.prepare('SELECT username, password_hash FROM accounts').all(),
      sessions: db.prepare('SELECT id, account_id, expires_at FROM sessions').all(),
    });
    assert.equal(storedAfterLogin.includes(password), false, 'login must not persist the submitted password');

    const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: `whiteboard_session=${rawToken}` } });
    assert.deepEqual(await session.json(), { authenticated: true, account: { id: (await login.clone().json()).account.id, username: 'arthur' } });

    const logout = await postJson(baseUrl, '/api/auth/logout', {}, { cookie: `whiteboard_session=${rawToken}`, 'x-forwarded-proto': 'https' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.match(logout.headers.get('set-cookie'), /Secure/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    const signedOut = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: `whiteboard_session=${rawToken}` } });
    assert.deepEqual(await signedOut.json(), { authenticated: false });
  }, { trustProxy: true });
});

test('untrusted X-Forwarded-Proto does not enable Secure cookies', async () => {
  await withServer(async (baseUrl) => {
    const registration = await postJson(baseUrl, '/api/auth/register', { username: 'charlie', password: 'secure enough password' });
    assert.equal(registration.status, 201);
    const login = await postJson(baseUrl, '/api/auth/login', { username: 'charlie', password: 'secure enough password' }, { 'x-forwarded-proto': 'https' });
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.headers.get('set-cookie'), /Secure/i);
  });
});
