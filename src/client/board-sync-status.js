const MAX_TRACKED_ACTIONS = 1_000;
const MAX_SYNC_BATCHES = 100;

/** Project observed transport events into per-replica collaboration status. */
export function createBoardSyncStatus(boardId) {
  const actions = new Map();
  const syncBatches = [];
  const listeners = new Set();

  function snapshot() {
    return Object.freeze({
      boardId,
      actions: [...actions.values()].map((action) => Object.freeze({
        ...action,
        durableEvidence: [...action.durableEvidence],
      })),
      syncBatches: syncBatches.map((batch) => Object.freeze({ ...batch })),
    });
  }

  function publish() {
    const current = snapshot();
    for (const listener of listeners) listener(current);
    return current;
  }

  function actionFor(event) {
    if (typeof event.actionId !== 'string' || !event.actionId) return null;
    let action = actions.get(event.actionId);
    if (action) return action;

    action = {
      actionId: event.actionId,
      updateBytes: event.updateBytes ?? null,
      firstArrivalPath: event.firstArrivalPath ?? null,
      local: false,
      peerReceived: false,
      serverReceived: false,
      durableServer: false,
      directPeerConnectedAtObservation: null,
      durableEvidence: [],
      updateId: null,
      committedAt: null,
      replicaId: event.replicaId ?? null,
      lastSequence: event.sequence ?? null,
      lastObservedAt: event.observedAt ?? null,
    };
    actions.set(event.actionId, action);
    if (actions.size > MAX_TRACKED_ACTIONS) actions.delete(actions.keys().next().value);
    return action;
  }

  function apply(type, event) {
    if (!event || (event.boardId && event.boardId !== boardId)) return null;

    if (type === 'sync-batch') {
      syncBatches.push({
        batchDigest: event.actionId ?? null,
        sourcePath: event.sourcePath ?? 'unknown',
        firstArrivalPath: event.firstArrivalPath ?? event.sourcePath ?? 'unknown',
        updateBytes: event.updateBytes ?? null,
        durableServer: event.sourcePath === 'server',
        observedAt: event.observedAt ?? null,
        replicaId: event.replicaId ?? null,
        sequence: event.sequence ?? null,
        state: event.state ?? null,
      });
      if (syncBatches.length > MAX_SYNC_BATCHES) syncBatches.shift();
      return publish();
    }

    const action = actionFor(event);
    if (!action) return null;
    if (Number.isFinite(event.updateBytes)) action.updateBytes = event.updateBytes;
    if (!action.firstArrivalPath && event.firstArrivalPath) action.firstArrivalPath = event.firstArrivalPath;
    if (event.replicaId) action.replicaId = event.replicaId;
    if (Number.isSafeInteger(event.sequence)) action.lastSequence = event.sequence;
    if (typeof event.observedAt === 'string') action.lastObservedAt = event.observedAt;

    if (type === 'update-observed') {
      if (event.sourcePath === 'local') action.local = true;
      if (event.sourcePath === 'peer-room') {
        action.peerReceived = true;
        action.directPeerConnectedAtObservation = event.directPeerConnectedAtObservation === true;
      }
      if (event.sourcePath === 'server') {
        action.serverReceived = true;
        // board-sync broadcasts only after the durable store transaction returns.
        action.durableServer = true;
        addEvidence(action, 'server-broadcast');
        action.updateId = event.serverUpdateId ?? action.updateId;
      }
      return publish();
    }

    if (type === 'server-received') {
      action.serverReceived = true;
      return publish();
    }

    if (type === 'durable-ack' || type === 'durable-persisted') {
      action.durableServer = true;
      addEvidence(action, type === 'durable-ack' ? 'durable-ack' : 'durable-persisted');
      action.updateId = event.updateId ?? action.updateId;
      action.committedAt = event.committedAt ?? action.committedAt;
      return publish();
    }

    return null;
  }

  function addEvidence(action, evidence) {
    if (!action.durableEvidence.includes(evidence)) action.durableEvidence.push(evidence);
  }

  return Object.freeze({
    apply,
    getSnapshot: snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A status listener is required');
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  });
}
