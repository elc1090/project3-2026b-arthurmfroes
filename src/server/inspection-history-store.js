const SNAPSHOT_LIMIT = 32;
const EVENT_LIMIT = 256;
const SNAPSHOT_BYTE_LIMIT = 1024 * 1024;
const BOARD_BYTE_LIMIT = 16 * 1024 * 1024;
const PAGE_LIMIT = 50;

export function createInspectionHistoryStore(db) {
  const insertSnapshot = db.prepare(`
    INSERT INTO inspection_snapshots (board_id, replica_id, projection_json, byte_length, source_sequence, source_clock)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const snapshotTotals = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM inspection_snapshots WHERE board_id = ?
  `);
  const pruneSnapshotRows = db.prepare(`
    DELETE FROM inspection_snapshots WHERE id IN (
      SELECT id FROM inspection_snapshots WHERE board_id = ? AND id NOT IN (
        SELECT MAX(id) FROM inspection_snapshots WHERE board_id = ? GROUP BY replica_id
      ) ORDER BY id ASC LIMIT ?
    )
  `);
  const deleteOldestSnapshot = db.prepare('DELETE FROM inspection_snapshots WHERE id = (SELECT MIN(id) FROM inspection_snapshots WHERE board_id = ?)');
  const insertEvent = db.prepare('INSERT INTO inspection_events (board_id, replica_id, event_json) VALUES (?, ?, ?)');
  const countEvents = db.prepare('SELECT COUNT(*) AS count FROM inspection_events WHERE board_id = ?');
  const deleteOldestEvent = db.prepare('DELETE FROM inspection_events WHERE id = (SELECT MIN(id) FROM inspection_events WHERE board_id = ?)');

  const retainSnapshots = db.transaction((boardId) => {
    while (true) {
      const totals = snapshotTotals.get(boardId);
      if (totals.count <= SNAPSHOT_LIMIT && totals.bytes <= BOARD_BYTE_LIMIT) return;
      const eligible = db.prepare(`SELECT COUNT(*) AS count FROM inspection_snapshots WHERE board_id = ? AND id NOT IN (
        SELECT MAX(id) FROM inspection_snapshots WHERE board_id = ? GROUP BY replica_id
      )`).get(boardId, boardId).count;
      if (eligible > 0) pruneSnapshotRows.run(boardId, boardId, Math.max(1, totals.count - SNAPSHOT_LIMIT));
      else deleteOldestSnapshot.run(boardId);
    }
  });
  const retainEvents = db.transaction((boardId) => {
    while (countEvents.get(boardId).count > EVENT_LIMIT) deleteOldestEvent.run(boardId);
  });

  return Object.freeze({
    recordSnapshot(boardId, replicaId, elements, metadata = {}) {
      if (typeof boardId !== 'string' || typeof replicaId !== 'string' || !Array.isArray(elements)) return null;
      const projectionJson = JSON.stringify(elements);
      const byteLength = Buffer.byteLength(projectionJson, 'utf8');
      if (byteLength > SNAPSHOT_BYTE_LIMIT) return null;
      const result = insertSnapshot.run(boardId, replicaId, projectionJson, byteLength,
        Number.isSafeInteger(metadata.sequence) && metadata.sequence >= 0 ? metadata.sequence : null,
        typeof metadata.clock === 'string' && metadata.clock.length <= 128 ? metadata.clock : null);
      retainSnapshots(boardId);
      return Number(result.lastInsertRowid);
    },
    recordEvent(boardId, replicaId, event) {
      if (typeof boardId !== 'string' || typeof replicaId !== 'string' || !event || typeof event !== 'object') return null;
      const eventJson = JSON.stringify(event);
      if (Buffer.byteLength(eventJson, 'utf8') > 8192) return null;
      const result = insertEvent.run(boardId, replicaId, eventJson);
      retainEvents(boardId);
      return Number(result.lastInsertRowid);
    },
    listSnapshots(boardId, { before = null, limit = PAGE_LIMIT, replicaId = null } = {}) {
      return listRows(db, 'inspection_snapshots', boardId, before, limit, replicaId, true);
    },
    listEvents(boardId, { before = null, limit = PAGE_LIMIT, replicaId = null } = {}) {
      return listRows(db, 'inspection_events', boardId, before, limit, replicaId, false);
    },
    readSnapshot(boardId, id) {
      const row = db.prepare(`SELECT id, board_id, replica_id, projection_json, byte_length, source_sequence, source_clock, received_at
        FROM inspection_snapshots WHERE board_id = ? AND id = ?`).get(boardId, id);
      if (!row) return null;
      return { id: row.id, replicaId: row.replica_id, elements: JSON.parse(row.projection_json), byteLength: row.byte_length,
        sequence: row.source_sequence, clock: row.source_clock, receivedAt: row.received_at };
    },
  });
}

function listRows(db, table, boardId, before, limit, replicaId, snapshot) {
  const cursor = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
  const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(PAGE_LIMIT, limit)) : PAGE_LIMIT;
  const whereReplica = typeof replicaId === 'string' ? ' AND replica_id = ?' : '';
  const columns = snapshot
    ? 'id, replica_id, byte_length, source_sequence, source_clock, received_at'
    : 'id, replica_id, event_json, received_at';
  const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE board_id = ? AND id < ?${whereReplica} ORDER BY id DESC LIMIT ?`)
    .all(...(typeof replicaId === 'string' ? [boardId, cursor, replicaId, pageSize] : [boardId, cursor, pageSize]));
  return rows.map((row) => snapshot
    ? { id: row.id, replicaId: row.replica_id, byteLength: row.byte_length, sequence: row.source_sequence, clock: row.source_clock, receivedAt: row.received_at }
    : { id: row.id, replicaId: row.replica_id, event: JSON.parse(row.event_json), receivedAt: row.received_at });
}
