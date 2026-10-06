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
    const board = db.prepare(`
      SELECT EXISTS(SELECT 1 FROM boards WHERE id = ?) AS exists_board,
        EXISTS(SELECT 1 FROM memberships WHERE board_id = ? AND account_id = ?) AS is_member
    `).get(boardId, boardId, session.accountId);
    if (!board.exists_board) {
      sendJson(response, 404, { error: 'Quadro não encontrado.' });
      return true;
    }
    if (!board.is_member) {
      sendJson(response, 403, { error: 'Você ainda não é membro deste quadro.' });
      return true;
    }

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
