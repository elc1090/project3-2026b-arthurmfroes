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
        destroyPromise = persistence.destroy().finally(() => doc.destroy());
      }
      return destroyPromise;
    },
  });
}
