import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getAuthenticatedSession } from './auth.js';
import { authorizeBoardMembership } from './boards.js';
import { decodeBytes, documentCoverage, encodeBytes } from '../shared/persistence-coverage.js';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_UPDATE = 3 * 1024 * 1024;

/** HTTP content sync without room-wide server fanout. Legacy WS stays available. */
export function createRoomPersistenceHandler(db, store, onCommitted = () => {}, onReceived = () => {}, traceStore = null) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'jwk' });
  const traceSessionId = randomUUID(); let traceSequence = 0;
  function trace(type, boardId, session, input, data = {}, receiptId) {
    if (!traceStore || !input.batchId) return;
    const context = input.trace && typeof input.trace === 'object' && Object.keys(input.trace).every((key) => ['attemptId', 'electionViewId', 'traceSessionId', 'docClientId'].includes(key))
      && Object.values(input.trace).every((value) => typeof value === 'string' && value.length > 0 && value.length <= 200) ? input.trace : {};
    const event = { version: 1, eventId: randomUUID(), boardId, traceSessionId, docClientId: context.docClientId ?? 'vps', sequence: ++traceSequence,
      type, observedAt: new Date().toISOString(), monotonicMs: performance.now(), batchId: input.batchId,
      ...(context.attemptId ? { attemptId: context.attemptId } : {}), ...(context.electionViewId ? { electionViewId: context.electionViewId } : {}), ...(receiptId ? { receiptId } : {}), data };
    try { traceStore.append(boardId, { key: 'vps', accountId: session.accountId, username: session.username, source: 'server' }, [event]); }
    catch { /* Diagnostics cannot change the commit or the persistence ACK. */ }
  }
  const find = db.prepare('SELECT digest, committed_at FROM persistence_batches WHERE board_id = ? AND batch_id = ?');
  const insert = db.prepare('INSERT INTO persistence_batches (board_id, batch_id, digest, committed_at) VALUES (?, ?, ?, ?)');
  const commit = db.transaction((boardId, accountId, batchId, bytes) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const prior = find.get(boardId, batchId);
    if (prior) {
      if (prior.digest !== digest) throw Object.assign(new Error('Batch identity conflict'), { status: 409 });
      return prior.committed_at;
    }
    const { committedAt } = store.persistUpdate({ updateId: `batch:${boardId}:${batchId}`, boardId, originAccountId: accountId, bytes });
    insert.run(boardId, batchId, digest, committedAt);
    return committedAt;
  });

  return async function handleRoomPersistence(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/persistence$/);
    if (!match) return false;
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const boardId = decodeURIComponent(match[1]);
      const session = getAuthenticatedSession(request, db);
      if (!session) { send(401, { error: 'Session expired' }); return true; }
      const auth = authorizeBoardMembership(db, boardId, session.accountId);
      if (auth.status !== 'authorized') { send(auth.status === 'not_found' ? 404 : 403, { error: 'Board access denied' }); return true; }
      if (!['GET', 'POST'].includes(request.method)) { send(405, { error: 'Method not allowed' }); return true; }
      let input = {};
      if (request.method === 'POST') {
        if (Number(request.headers['content-length']) > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Membership/session may change while an upload is still streaming.
        const currentSession = getAuthenticatedSession(request, db);
        if (!currentSession || currentSession.accountId !== session.accountId) { send(401, { error: 'Session expired' }); return true; }
        if (authorizeBoardMembership(db, boardId, session.accountId).status !== 'authorized') { send(403, { error: 'Board access denied' }); return true; }
      }
      const vector = input.stateVector === undefined ? new Uint8Array([0]) : decodeBytes(input.stateVector);
      if (vector.byteLength > 64 * 1024) throw new Error('State vector too large');
      Y.decodeStateVector(vector);
      let committedAt = new Date().toISOString();
      if (input.update !== undefined) {
        if (typeof input.batchId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.batchId)) throw new Error('Invalid batch ID');
        const bytes = decodeBytes(input.update);
        if (!bytes.byteLength || bytes.byteLength > MAX_UPDATE) throw Object.assign(new Error('Update too large'), { status: 413 });
        // Validate against durable state before committing any bytes.
        const probe = store.loadDocument(boardId);
        try { Y.applyUpdate(probe, bytes); } finally { probe.destroy(); }
        trace('server-received', boardId, session, input, { updateBytes: bytes.byteLength, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
        const deduplicated = Boolean(find.get(boardId, input.batchId));
        onReceived({ boardId, bytes, updateId: input.batchId });
        committedAt = commit.immediate(boardId, session.accountId, input.batchId, bytes);
        trace('server-committed', boardId, session, input, { committedAt, deduplicated });
        onCommitted({ boardId, bytes, updateId: input.batchId, committedAt });
      }
      const doc = store.loadDocument(boardId);
      try {
        const payload = { boardId, batchId: input.batchId ?? null, committedAt, coverage: documentCoverage(doc) };
        const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64');
        if (input.update !== undefined) response.once('finish', () => trace('server-ack-sent', boardId, session, input, { committedAt }, `sha256:${createHash('sha256').update(signature).digest('hex')}`));
        send(200, { key, receipt: { payload, signature }, update: encodeBytes(Y.encodeStateAsUpdate(doc, vector)) });
      } finally { doc.destroy(); }
    } catch (error) {
      send(error.status ?? 400, { error: error.status === 409 ? error.message : 'Persistence request failed' });
    }
    return true;
  };
}
