import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';

const COOKIE_NAME = 'whiteboard_session';
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
const SESSION_LIFETIME_MS = SESSION_LIFETIME_SECONDS * 1000;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > 8_192) throw Object.assign(new Error('Request body too large'), { status: 413 });

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 8_192) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().normalize('NFKC').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) ? username : null;
}

function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 8 && Buffer.byteLength(value, 'utf8') <= 1_024;
}

function sessionTokenFrom(request) {
  const cookieHeader = request.headers.cookie ?? '';
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return entry.slice(separator + 1).trim();
  }
  return null;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function getAuthenticatedSession(request, db) {
  const token = sessionTokenFrom(request);
  if (!token) return null;
  const sessionId = tokenHash(token);
  const account = db.prepare(`
    SELECT accounts.id, accounts.username
    FROM sessions JOIN accounts ON accounts.id = sessions.account_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).get(sessionId, new Date().toISOString());
  return account ? { sessionId, accountId: account.id, username: account.username } : null;
}

function isHttps(request, trustProxy) {
  if (request.socket.encrypted) return true;
  if (!trustProxy) return false;
  return request.headers['x-forwarded-proto']?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function sessionCookie(token, secure, maxAge = SESSION_LIFETIME_SECONDS) {
  const secureAttribute = secure ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttribute}`;
}

export async function handleAuthRequest(request, response, db, { trustProxy = false } = {}) {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (!pathname.startsWith('/api/auth/')) return false;

  const secure = isHttps(request, trustProxy);
  const methods = {
    '/api/auth/register': 'POST',
    '/api/auth/login': 'POST',
    '/api/auth/logout': 'POST',
    '/api/auth/session': 'GET',
  };
  if (!methods[pathname]) return false;
  if (request.method !== methods[pathname]) {
    sendJson(response, 405, { error: 'Method not allowed' }, { allow: methods[pathname] });
    return true;
  }

  if (pathname === '/api/auth/session') {
    const session = getAuthenticatedSession(request, db);
    if (!session) {
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    sendJson(response, 200, { authenticated: true, account: { id: session.accountId, username: session.username } });
    return true;
  }

  try {
    const body = await readJsonBody(request);
    if (pathname === '/api/auth/register') {
      const username = normalizeUsername(body?.username);
      if (!username || !validPassword(body?.password)) {
        sendJson(response, 400, { error: 'Informe um nome de usuário válido e uma senha com pelo menos 8 caracteres.' });
        return true;
      }

      const account = { id: randomUUID(), username };
      const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);
      try {
        db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
          .run(account.id, account.username, passwordHash);
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          sendJson(response, 409, { error: 'Este nome de usuário já está em uso.' });
          return true;
        }
        throw error;
      }
      sendJson(response, 201, { account });
      return true;
    }

    if (pathname === '/api/auth/login') {
      const username = normalizeUsername(body?.username);
      const account = username
        ? db.prepare('SELECT id, username, password_hash FROM accounts WHERE username = ?').get(username)
        : null;
      const passwordMatches = account && typeof body?.password === 'string'
        ? await argon2.verify(account.password_hash, body.password).catch(() => false)
        : false;
      if (!passwordMatches) {
        sendJson(response, 401, { error: 'Nome de usuário ou senha inválidos.' });
        return true;
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
      db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
        .run(tokenHash(token), account.id, expiresAt);
      sendJson(response, 200, { account: { id: account.id, username: account.username } }, {
        'set-cookie': sessionCookie(token, secure),
      });
      return true;
    }

    if (pathname === '/api/auth/logout') {
      const token = sessionTokenFrom(request);
      if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
      sendJson(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', secure, 0) });
      return true;
    }
  } catch (error) {
    sendJson(response, error.status ?? 500, { error: error.status ? error.message : 'Não foi possível concluir a solicitação.' });
    return true;
  }

  return false;
}
