import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

const DATABASE_PREFIX = 'whiteboard-t3:board:';

/**
 * Open a board document backed by this browser's IndexedDB.
 * `ready` resolves after the saved document has been loaded into `doc`.
 * Call and await `destroy()` when the board session closes to release the
 * IndexedDB provider and Y.Doc.
 */
export function openOfflineBoard(boardId) {
  if (typeof boardId !== 'string' || boardId.length === 0) {
    throw new TypeError('boardId must be a non-empty string');
  }

  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(`${DATABASE_PREFIX}${boardId}`, doc);
  const ready = persistence.whenSynced.then(() => doc);
  let destroyPromise;

  return Object.freeze({
    doc,
    ready,
    destroy() {
      if (!destroyPromise) {
        destroyPromise = (async () => {
          try {
            await ready;
            await persistFinalState(persistence, doc);
          } finally {
            try {
              await persistence.destroy();
            } finally {
              doc.destroy();
            }
          }
        })();
      }
      return destroyPromise;
    },
  });
}

function persistFinalState(persistence, doc) {
  if (!persistence.db) {
    throw new Error('IndexedDB must be ready before the board can be closed');
  }

  // y-indexeddb does not expose completion promises for its per-update writes.
  // This full state entry is a transaction barrier for an explicit clean close;
  // abrupt tab termination still relies on those writes completing normally.
  return new Promise((resolve, reject) => {
    const transaction = persistence.db.transaction('updates', 'readwrite');
    transaction.objectStore('updates').add(Y.encodeStateAsUpdate(doc));
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB board flush was aborted'));
  });
}
