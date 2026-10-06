/**
 * Builds local diagnostic events. actionId is a digest of the observed update
 * bytes, not a semantic Canvas action ID: state-vector diffs may reencode or
 * aggregate edits and therefore produce a different digest. Sequence and time
 * belong to this replica and must not be compared globally.
 */
export function createSyncEventTracker(boardId, {
  replicaId = globalThis.crypto.randomUUID(),
  onEvent = () => {},
  now = () => Date.now(),
  digest = sha256,
} = {}) {
  const MAX_FIRST_ARRIVALS = 10_000;
  let sequence = 0;
  let digestQueue = Promise.resolve();
  const firstArrivalByAction = new Map();

  function metadata() {
    sequence += 1;
    return {
      boardId,
      replicaId,
      sequence,
      observedAt: new Date(now()).toISOString(),
    };
  }

  function emit(type, detail = {}) {
    const event = { ...metadata(), ...detail };
    onEvent(type, event);
    return event;
  }

  function rememberFirstArrival(actionId, sourcePath) {
    let firstArrivalPath = firstArrivalByAction.get(actionId);
    if (firstArrivalPath === undefined) {
      firstArrivalPath = sourcePath;
      firstArrivalByAction.set(actionId, firstArrivalPath);
      if (firstArrivalByAction.size > MAX_FIRST_ARRIVALS) {
        firstArrivalByAction.delete(firstArrivalByAction.keys().next().value);
      }
    }
    return firstArrivalPath;
  }

  async function observeUpdate(bytes, detail = {}) {
    const localMetadata = metadata();
    const pending = digestQueue.then(async () => {
      const actionId = await digest(bytes);
      const firstArrivalPath = rememberFirstArrival(actionId, detail.sourcePath);
      const event = {
        ...localMetadata,
        actionId,
        updateBytes: bytes.byteLength,
        firstArrivalPath,
        ...detail,
      };
      onEvent('update-observed', event);
      return event;
    });
    digestQueue = pending.catch(() => {});
    return pending;
  }

  async function observeSyncBatch(bytes, detail = {}) {
    const localMetadata = metadata();
    const pending = digestQueue.then(async () => {
      const actionId = await digest(bytes);
      const sourcePath = detail.sourcePath ?? 'server';
      const firstArrivalPath = rememberFirstArrival(actionId, sourcePath);
      const event = {
        ...localMetadata,
        actionId,
        updateBytes: bytes.byteLength,
        firstArrivalPath,
        sourcePath,
        ...detail,
      };
      onEvent('sync-batch', event);
      return event;
    });
    digestQueue = pending.catch(() => {});
    return pending;
  }

  return Object.freeze({ emit, observeUpdate, observeSyncBatch });
}

async function sha256(bytes) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
