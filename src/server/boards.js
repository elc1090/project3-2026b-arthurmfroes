import { randomUUID } from 'node:crypto';
import { readBoardElements } from '../shared/board-model.js';
import { getAuthenticatedSession, readJsonBody } from './auth.js';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function boardSummary(row) {
  return {
    id: row.id,
    title: row.title,
    href: `/boards/${row.id}`,
    isMember: Boolean(row.is_member),
  };
}

/** Shared membership gate for board content and future asset/sync routes. */
export function authorizeBoardMembership(db, boardId, accountId) {
  const board = db.prepare('SELECT id, title FROM boards WHERE id = ?').get(boardId);
  if (!board) return { status: 'not_found' };
  const membership = db.prepare(`
    SELECT board_id, account_id, joined_at
    FROM memberships WHERE board_id = ? AND account_id = ?
  `).get(boardId, accountId);
  return membership
    ? { status: 'authorized', board, membership }
    : { status: 'forbidden', board };
}

function sendBoardAuthorizationError(response, authorization) {
  if (authorization.status === 'not_found') {
    sendJson(response, 404, { error: 'Quadro não encontrado.' });
    return true;
  }
  if (authorization.status === 'forbidden') {
    sendJson(response, 403, { error: 'Você ainda não é membro deste quadro.' });
    return true;
  }
  return false;
}

export async function handleBoardRequest(request, response, db, updateStore) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/boards')) return false;

  const session = getAuthenticatedSession(request, db);
  if (!session) {
    sendJson(response, 401, { error: 'Entre na sua conta para acessar os quadros.' });
    return true;
  }

  if (url.pathname === '/api/boards') {
    if (request.method === 'GET') {
      const search = (url.searchParams.get('search') ?? '').trim().toLocaleLowerCase('pt-BR');
      const boards = db.prepare(`
        SELECT b.id, b.title,
          EXISTS(SELECT 1 FROM memberships m WHERE m.board_id = b.id AND m.account_id = ?) AS is_member
        FROM boards b
        ORDER BY lower(b.title), b.id
      `).all(session.accountId)
        .filter((board) => !search || board.title.toLocaleLowerCase('pt-BR').includes(search))
        .map(boardSummary);
      sendJson(response, 200, { boards });
      return true;
    }

    if (request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        if (!title || [...title].length > 100) {
          sendJson(response, 400, { error: 'Informe um título com até 100 caracteres.' });
          return true;
        }

        const boardId = randomUUID();
        const createBoard = db.transaction(() => {
          db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, title);
          db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)')
            .run(boardId, session.accountId);
        });
        createBoard();
        sendJson(response, 201, {
          board: { id: boardId, title, href: `/boards/${boardId}`, isMember: true },
        });
      } catch (error) {
        sendJson(response, error.status ?? 500, {
          error: error.status ? error.message : 'Não foi possível criar o quadro.',
        });
      }
      return true;
    }

    response.writeHead(405, { allow: 'GET, POST' }).end();
    return true;
  }

  const requestsMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/access-requests$/);
  if (requestsMatch) {
    let boardId;
    try {
      boardId = decodeURIComponent(requestsMatch[1]);
    } catch {
      sendJson(response, 400, { error: 'ID de quadro inválido.' });
      return true;
    }
    if (request.method === 'POST') {
      const authorization = authorizeBoardMembership(db, boardId, session.accountId);
      if (authorization.status === 'not_found') {
        sendBoardAuthorizationError(response, authorization);
        return true;
      }
      if (authorization.status === 'authorized') {
        sendJson(response, 409, { error: 'Você já é membro deste quadro.' });
        return true;
      }
      const result = db.prepare(`
        INSERT OR IGNORE INTO access_requests (board_id, account_id) VALUES (?, ?)
      `).run(boardId, session.accountId);
      sendJson(response, result.changes ? 201 : 200, { pending: true });
      return true;
    }

    if (request.method === 'GET') {
      const authorization = authorizeBoardMembership(db, boardId, session.accountId);
      if (sendBoardAuthorizationError(response, authorization)) return true;
      const requests = db.prepare(`
        SELECT access_requests.account_id AS accountId, accounts.username, access_requests.requested_at AS requestedAt
        FROM access_requests JOIN accounts ON accounts.id = access_requests.account_id
        WHERE access_requests.board_id = ?
        ORDER BY access_requests.requested_at, accounts.username
      `).all(boardId);
      sendJson(response, 200, { requests });
      return true;
    }

    response.writeHead(405, { allow: 'GET, POST' }).end();
    return true;
  }

  const ownRequestMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/access-request$/);
  if (ownRequestMatch && request.method === 'GET') {
    let boardId;
    try {
      boardId = decodeURIComponent(ownRequestMatch[1]);
    } catch {
      sendJson(response, 400, { error: 'ID de quadro inválido.' });
      return true;
    }
    const authorization = authorizeBoardMembership(db, boardId, session.accountId);
    if (authorization.status === 'not_found') {
      sendBoardAuthorizationError(response, authorization);
      return true;
    }
    const pending = authorization.status === 'forbidden' && Boolean(db.prepare(`
      SELECT 1 FROM access_requests WHERE board_id = ? AND account_id = ?
    `).get(boardId, session.accountId));
    sendJson(response, 200, { pending });
    return true;
  }

  const membersMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/members$/);
  if (membersMatch && request.method === 'GET') {
    let boardId;
    try {
      boardId = decodeURIComponent(membersMatch[1]);
    } catch {
      sendJson(response, 400, { error: 'ID de quadro inválido.' });
      return true;
    }
    const authorization = authorizeBoardMembership(db, boardId, session.accountId);
    if (sendBoardAuthorizationError(response, authorization)) return true;
    const members = db.prepare(`
      SELECT accounts.id AS accountId, accounts.username, memberships.joined_at AS joinedAt
      FROM memberships JOIN accounts ON accounts.id = memberships.account_id
      WHERE memberships.board_id = ?
      ORDER BY memberships.joined_at, accounts.username
    `).all(boardId);
    sendJson(response, 200, { members });
    return true;
  }

  const revokeMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/members\/([^/]+)\/revoke$/);
  if (revokeMatch && request.method === 'POST') {
    let boardId;
    let targetAccountId;
    try {
      boardId = decodeURIComponent(revokeMatch[1]);
      targetAccountId = decodeURIComponent(revokeMatch[2]);
    } catch {
      sendJson(response, 400, { error: 'ID inválido.' });
      return true;
    }

    const revokeMembership = db.transaction(() => {
      const authorization = authorizeBoardMembership(db, boardId, session.accountId);
      if (authorization.status !== 'authorized') return authorization.status;
      if (targetAccountId === session.accountId) return 'self';
      const target = db.prepare(`
        SELECT 1 FROM memberships WHERE board_id = ? AND account_id = ?
      `).get(boardId, targetAccountId);
      if (!target) return 'target_not_member';

      db.prepare('DELETE FROM memberships WHERE board_id = ? AND account_id = ?')
        .run(boardId, targetAccountId);
      const { epoch } = db.prepare(`
        UPDATE boards SET epoch = epoch + 1 WHERE id = ? RETURNING epoch
      `).get(boardId);
      return { epoch };
    });
    const result = revokeMembership();
    if (result === 'not_found') {
      sendJson(response, 404, { error: 'Quadro não encontrado.' });
    } else if (result === 'forbidden') {
      sendJson(response, 403, { error: 'Você não é membro deste quadro.' });
    } else if (result === 'self') {
      sendJson(response, 400, { error: 'Você não pode revogar a própria membership.' });
    } else if (result === 'target_not_member') {
      sendJson(response, 404, { error: 'A pessoa não é membro deste quadro.' });
    } else {
      sendJson(response, 200, { revoked: true, boardId, accountId: targetAccountId, epoch: result.epoch });
    }
    return true;
  }

  const acceptMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/access-requests\/([^/]+)\/accept$/);
  if (acceptMatch && request.method === 'POST') {
    let boardId;
    let accountId;
    try {
      boardId = decodeURIComponent(acceptMatch[1]);
      accountId = decodeURIComponent(acceptMatch[2]);
    } catch {
      sendJson(response, 400, { error: 'ID inválido.' });
      return true;
    }
    const authorization = authorizeBoardMembership(db, boardId, session.accountId);
    if (sendBoardAuthorizationError(response, authorization)) return true;

    const acceptRequest = db.transaction(() => {
      const pending = db.prepare(`
        SELECT 1 FROM access_requests WHERE board_id = ? AND account_id = ?
      `).get(boardId, accountId);
      if (!pending) return false;
      db.prepare('INSERT OR IGNORE INTO memberships (board_id, account_id) VALUES (?, ?)')
        .run(boardId, accountId);
      db.prepare('DELETE FROM access_requests WHERE board_id = ? AND account_id = ?')
        .run(boardId, accountId);
      return true;
    });
    if (!acceptRequest()) {
      sendJson(response, 404, { error: 'Pedido pendente não encontrado.' });
      return true;
    }
    sendJson(response, 200, { accepted: true, boardId, accountId });
    return true;
  }

  const metadataMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (metadataMatch && request.method === 'GET') {
    let boardId;
    try {
      boardId = decodeURIComponent(metadataMatch[1]);
    } catch {
      sendJson(response, 400, { error: 'ID de quadro inválido.' });
      return true;
    }
    const board = db.prepare(`
      SELECT b.id, b.title,
        EXISTS(SELECT 1 FROM memberships m WHERE m.board_id = b.id AND m.account_id = ?) AS is_member
      FROM boards b WHERE b.id = ?
    `).get(session.accountId, boardId);
    if (!board) {
      sendJson(response, 404, { error: 'Quadro não encontrado.' });
      return true;
    }
    sendJson(response, 200, { board: boardSummary(board) });
    return true;
  }

  const contentMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/content$/);
  if (contentMatch && request.method === 'GET') {
    let boardId;
    try {
      boardId = decodeURIComponent(contentMatch[1]);
    } catch {
      sendJson(response, 400, { error: 'ID de quadro inválido.' });
      return true;
    }
    const authorization = authorizeBoardMembership(db, boardId, session.accountId);
    if (sendBoardAuthorizationError(response, authorization)) return true;

    const doc = updateStore.loadDocument(boardId);
    try {
      sendJson(response, 200, { elements: readBoardElements(doc) });
    } finally {
      doc.destroy();
    }
    return true;
  }

  return false;
}
