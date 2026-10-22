import { TRACE_LIMITS, validateTraceEvent } from '../shared/persistence-trace.js';

export function createPersistenceTraceStore(db, limits = {}) {
  const config = { ...TRACE_LIMITS, ...limits };
  const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM persistence_trace_events WHERE board_id = ?');
  const insert = db.prepare(`INSERT INTO persistence_trace_events
    (board_id, reporter_key, account_id, username, event_id, trace_session_id, source, type, doc_client_id, source_sequence, batch_id, election_view_id, attempt_id, event_json, byte_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(board_id, reporter_key, event_id) DO NOTHING`);
  const readState = db.prepare('SELECT dropped, pruned_through AS prunedThrough FROM persistence_trace_state WHERE board_id = ?');
  const oldest = db.prepare('SELECT * FROM persistence_trace_events WHERE board_id = ? ORDER BY id LIMIT 1');
  const floor = db.prepare('SELECT pruned_sequence FROM persistence_trace_floors WHERE board_id = ? AND reporter_key = ? AND trace_session_id = ?');
  function retain(boardId) {
    while (true) {
      const total = totals.get(boardId);
      if (total.count <= config.serverEvents && total.bytes <= config.serverBytes) return;
      const row = oldest.get(boardId);
      db.prepare(`INSERT INTO persistence_trace_floors VALUES (?, ?, ?, ?) ON CONFLICT(board_id, reporter_key, trace_session_id)
        DO UPDATE SET pruned_sequence = MAX(pruned_sequence, excluded.pruned_sequence)`).run(boardId, row.reporter_key, row.trace_session_id, row.source_sequence);
      db.prepare('DELETE FROM persistence_trace_events WHERE id = ?').run(row.id);
      db.prepare(`INSERT INTO persistence_trace_state(board_id, dropped, pruned_through) VALUES (?, 1, ?)
        ON CONFLICT(board_id) DO UPDATE SET dropped = dropped + 1, pruned_through = MAX(pruned_through, excluded.pruned_through)`).run(boardId, row.id);
    }
  }
  const append = db.transaction((boardId, actor, events) => {
    const accepted = []; const expired = [];
    for (const event of events) {
      validateTraceEvent(event, { server: actor.source === 'server' });
      if (event.boardId !== boardId) throw new TypeError('Trace belongs to another board');
      if ((floor.get(boardId, actor.key, event.traceSessionId)?.pruned_sequence ?? -1) >= event.sequence) { expired.push(event.eventId); continue; }
      const json = JSON.stringify(event);
      const existing = db.prepare('SELECT event_json FROM persistence_trace_events WHERE board_id = ? AND reporter_key = ? AND event_id = ?').get(boardId, actor.key, event.eventId);
      if (existing && existing.event_json !== json) throw new TypeError('Conflicting trace identity');
      insert.run(boardId, actor.key, actor.accountId ?? null, actor.username, event.eventId, event.traceSessionId, actor.source, event.type,
        event.docClientId, event.sequence, event.batchId ?? null, event.electionViewId ?? null, event.attemptId ?? null, json, Buffer.byteLength(json));
      accepted.push(event.eventId);
    }
    retain(boardId);
    return { accepted, expired };
  });
  const decode = (row) => ({ id: row.id, accountId: row.account_id, username: row.username, source: row.source, receivedAt: row.received_at, event: JSON.parse(row.event_json) });
  return Object.freeze({
    append(boardId, actor, events) { return append.immediate(boardId, actor, events); },
    list(boardId, { before, batchId, participant, electionViewId, limit = config.pageSize } = {}) {
      const clauses = ['board_id = ?']; const params = [boardId];
      if (Number.isSafeInteger(before) && before > 0) { clauses.push('id < ?'); params.push(before); }
      for (const [column, value] of [['batch_id', batchId], ['account_id', participant], ['election_view_id', electionViewId]]) {
        if (typeof value === 'string' && value) { clauses.push(`${column} = ?`); params.push(value); }
      }
      params.push(Math.min(config.pageSize, Math.max(1, Number.isSafeInteger(limit) ? limit : config.pageSize)));
      const rows = db.prepare(`SELECT * FROM persistence_trace_events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params).map(decode);
      const state = readState.get(boardId) ?? { dropped: 0, prunedThrough: 0 };
      return { rows, nextBefore: rows.length ? rows.at(-1).id : null, ...state, limits: { events: config.serverEvents, bytes: config.serverBytes }, totals: totals.get(boardId) };
    },
    batchDetails(boardId, batchId) {
      const rows = db.prepare('SELECT * FROM persistence_trace_events WHERE board_id = ? AND batch_id = ? ORDER BY id').all(boardId, batchId);
      const views = [...new Set(rows.map((row) => row.election_view_id).filter(Boolean))];
      for (const view of views) rows.push(...db.prepare('SELECT * FROM persistence_trace_events WHERE board_id = ? AND election_view_id = ? AND batch_id IS NULL ORDER BY id').all(boardId, view));
      return rows.map(decode);
    },
    knownBatches(boardId, { before, batchId, participant, limit = 20 } = {}) {
      const clauses = ['p.board_id = ?']; const params = [boardId];
      if (before) { clauses.push('(p.committed_at < ? OR (p.committed_at = ? AND p.batch_id < ?))'); params.push(before.time, before.time, before.id); }
      if (batchId) { clauses.push('p.batch_id = ?'); params.push(batchId); }
      if (participant) { clauses.push('(u.origin_account_id = ? OR EXISTS (SELECT 1 FROM persistence_trace_events t WHERE t.board_id = p.board_id AND t.batch_id = p.batch_id AND t.account_id = ?))'); params.push(participant, participant); }
      params.push(Math.max(1, Math.min(50, limit)));
      return db.prepare(`SELECT p.batch_id AS batchId, p.digest, p.committed_at AS committedAt, a.username,
        length(u.update_bytes) AS updateBytes FROM persistence_batches p
        LEFT JOIN board_updates u ON u.id = 'batch:' || p.board_id || ':' || p.batch_id
        LEFT JOIN accounts a ON a.id = u.origin_account_id WHERE ${clauses.join(' AND ')} ORDER BY p.committed_at DESC, p.batch_id DESC LIMIT ?`).all(...params);
    },
    participants(boardId) {
      return db.prepare('SELECT DISTINCT account_id AS accountId, username, doc_client_id AS docClientId, trace_session_id AS traceSessionId FROM persistence_trace_events WHERE board_id = ? AND source = ?').all(boardId, 'client');
    },
  });
}
