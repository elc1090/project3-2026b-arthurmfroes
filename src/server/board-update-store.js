import * as Y from 'yjs';

/**
 * Create the durable update API used by board synchronization transports.
 * The caller is responsible for authenticating board membership before calling
 * this store. An acknowledgement is returned only after SQLite commits.
 */
export function createBoardUpdateStore(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database handle is required');
  }

  const findUpdate = db.prepare(`
    SELECT board_id, origin_account_id, update_bytes, received_at
    FROM board_updates
    WHERE id = ?
  `);
  const insertUpdate = db.prepare(`
    INSERT INTO board_updates (id, board_id, origin_account_id, update_bytes)
    VALUES (?, ?, ?, ?)
  `);
  const listUpdates = db.prepare(`
    SELECT update_bytes
    FROM board_updates
    WHERE board_id = ?
    ORDER BY received_at, rowid
  `);

  const insertCommittedUpdate = db.transaction(({ updateId, boardId, originAccountId, bytes }) => {
    const existing = findUpdate.get(updateId);
    if (existing) {
      const isSameUpdate = existing.board_id === boardId
        && existing.origin_account_id === originAccountId
        && Buffer.from(existing.update_bytes).equals(bytes);
      if (!isSameUpdate) {
        const error = new Error(`Update ID ${updateId} is already used for different content`);
        error.code = 'UPDATE_ID_CONFLICT';
        throw error;
      }
      return { receivedAt: existing.received_at };
    }

    insertUpdate.run(updateId, boardId, originAccountId, bytes);
    return { receivedAt: db.prepare('SELECT received_at FROM board_updates WHERE id = ?').get(updateId).received_at };
  });

  return Object.freeze({
    /**
     * Persist an opaque Yjs update. Re-sending the exact same update ID and
     * payload is idempotent and returns its original acknowledgement time.
     * Reusing an ID for a different board, account, or payload is rejected.
     */
    persistUpdate({ updateId, boardId, originAccountId, bytes }) {
      requireIdentifier(updateId, 'updateId');
      requireIdentifier(boardId, 'boardId');
      requireIdentifier(originAccountId, 'originAccountId');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new TypeError('bytes must be a non-empty Uint8Array');
      }

      const payload = Buffer.from(bytes);
      // better-sqlite3's transaction wrapper returns only after COMMIT finishes.
      const { receivedAt } = insertCommittedUpdate.immediate({
        updateId,
        boardId,
        originAccountId,
        bytes: payload,
      });
      return Object.freeze({ boardId, updateId, committedAt: receivedAt });
    },

    /** Build a fresh Y.Doc by replaying this board's committed update bytes. */
    loadDocument(boardId) {
      requireIdentifier(boardId, 'boardId');
      const doc = new Y.Doc();
      try {
        for (const { update_bytes: updateBytes } of listUpdates.all(boardId)) {
          Y.applyUpdate(doc, new Uint8Array(updateBytes));
        }
        return doc;
      } catch (error) {
        doc.destroy();
        throw error;
      }
    },
  });
}

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
