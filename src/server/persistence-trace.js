import { getAuthenticatedSession } from './auth.js';
import { authorizeBoardMembership } from './boards.js';
import { TRACE_LIMITS, validateTraceEvent } from '../shared/persistence-trace.js';

export function createPersistenceTraceHandler(db, store) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/persistence-trace$/);
    if (!match) return false;
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    const authorize = (boardId) => {
      const session = getAuthenticatedSession(request, db);
      if (!session) throw Object.assign(new Error('Session expired'), { status: 401 });
      if (authorizeBoardMembership(db, boardId, session.accountId).status !== 'authorized') throw Object.assign(new Error('Board access denied'), { status: 403 });
      return session;
    };
    try {
      const boardId = decodeURIComponent(match[1]); let session = authorize(boardId);
      if (request.method === 'POST') {
        if (Number(request.headers['content-length']) > TRACE_LIMITS.requestBytes) throw Object.assign(new Error('Trace request too large'), { status: 413 });
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > TRACE_LIMITS.requestBytes) throw Object.assign(new Error('Trace request too large'), { status: 413 }); chunks.push(chunk); }
        session = authorize(boardId);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Object.keys(body).some((key) => key !== 'events') || !Array.isArray(body.events) || !body.events.length || body.events.length > TRACE_LIMITS.requestEvents) throw new TypeError('Invalid trace batch');
        body.events.forEach((event) => validateTraceEvent(event));
        const actor = { key: session.accountId, accountId: session.accountId, username: session.username, source: 'client' };
        send(200, store.append(boardId, actor, body.events));
      } else if (request.method === 'GET') {
        const batchId = url.searchParams.get('batchId') || undefined;
        const options = { batchId, participant: url.searchParams.get('participant') || undefined, electionViewId: url.searchParams.get('electionViewId') || undefined,
          before: Number(url.searchParams.get('before')), limit: Number(url.searchParams.get('limit') || 50) };
        const history = store.list(boardId, options);
        const cursor = url.searchParams.get('batchBefore');
        const batches = store.knownBatches(boardId, { ...options, before: cursor ? JSON.parse(cursor) : undefined, limit: 20 });
        send(200, { ...history, ...(batchId ? { detail: store.batchDetails(boardId, batchId) } : {}), batches,
          batchNext: batches.length === 20 ? { time: batches.at(-1).committedAt, id: batches.at(-1).batchId } : null,
          participants: store.participants(boardId) });
      } else send(405, { error: 'Method not allowed' });
    } catch (error) { send(error.status ?? (error instanceof TypeError || error instanceof SyntaxError ? 400 : 503), { error: error.status === 401 || error.status === 403 ? error.message : 'Persistence trace unavailable or invalid' }); }
    return true;
  };
}
