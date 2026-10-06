import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoardSyncStatus } from '../src/client/board-sync-status.js';

const base = {
  boardId: 'board-a',
  actionId: 'sha256:one',
  updateBytes: 128,
  firstArrivalPath: 'local',
};

test('peer receipt and pre-commit server receipt stay separate from durable status', () => {
  const status = createBoardSyncStatus('board-a');
  status.apply('update-observed', { ...base, sourcePath: 'local' });
  status.apply('update-observed', {
    ...base,
    sourcePath: 'peer-room',
    directPeerConnectedAtObservation: true,
  });
  status.apply('server-received', { ...base, sourcePath: 'client' });

  const [action] = status.getSnapshot().actions;
  assert.equal(action.local, true);
  assert.equal(action.peerReceived, true);
  assert.equal(action.serverReceived, true);
  assert.equal(action.directPeerConnectedAtObservation, true);
  assert.equal(action.durableServer, false);

  status.apply('durable-ack', { ...base, updateId: 'store-id', committedAt: '2026-10-06T12:00:00.000Z' });
  const durable = status.getSnapshot().actions[0];
  assert.equal(durable.durableServer, true);
  assert.deepEqual(durable.durableEvidence, ['durable-ack']);
  assert.equal(durable.updateId, 'store-id');
});

test('server broadcast is post-commit proof; aggregate sync remains a separate batch', () => {
  const status = createBoardSyncStatus('board-a');
  const snapshots = [];
  status.subscribe((snapshot) => snapshots.push(snapshot));

  status.apply('update-observed', { ...base, sourcePath: 'server', serverUpdateId: 'store-id' });
  status.apply('sync-batch', {
    boardId: 'board-a',
    actionId: 'sha256:aggregate',
    sourcePath: 'server',
    updateBytes: 512,
    state: 'initial-server-diff',
  });

  const current = status.getSnapshot();
  assert.equal(current.actions.length, 1);
  assert.equal(current.actions[0].durableServer, true);
  assert.deepEqual(current.actions[0].durableEvidence, ['server-broadcast']);
  assert.equal(current.actions[0].updateId, 'store-id');
  assert.equal(current.syncBatches.length, 1);
  assert.deepEqual(current.syncBatches[0], {
    batchDigest: 'sha256:aggregate',
    sourcePath: 'server',
    firstArrivalPath: 'server',
    updateBytes: 512,
    durableServer: true,
    observedAt: null,
    replicaId: null,
    sequence: null,
    state: 'initial-server-diff',
  });
  assert.equal(snapshots.length, 3, 'subscribe receives initial state and each projection change');
});

test('events from another board do not alter this board projection', () => {
  const status = createBoardSyncStatus('board-a');
  assert.equal(status.apply('update-observed', { ...base, boardId: 'board-b', sourcePath: 'local' }), null);
  assert.deepEqual(status.getSnapshot().actions, []);
});

test('status projection keeps bounded action and aggregate-batch windows', () => {
  const status = createBoardSyncStatus('board-a');
  for (let index = 0; index <= 1_000; index += 1) {
    status.apply('update-observed', {
      boardId: 'board-a',
      actionId: `sha256:${index}`,
      sourcePath: 'local',
      updateBytes: 4,
    });
  }
  for (let index = 0; index <= 100; index += 1) {
    status.apply('sync-batch', {
      boardId: 'board-a',
      actionId: `sha256:batch-${index}`,
      sourcePath: 'server',
      updateBytes: 8,
    });
  }

  const snapshot = status.getSnapshot();
  assert.equal(snapshot.actions.length, 1_000);
  assert.equal(snapshot.actions.some(({ actionId }) => actionId === 'sha256:0'), false);
  assert.equal(snapshot.actions.at(-1).actionId, 'sha256:1000');
  assert.equal(snapshot.syncBatches.length, 100);
  assert.equal(snapshot.syncBatches.some(({ batchDigest }) => batchDigest === 'sha256:batch-0'), false);
  assert.equal(snapshot.syncBatches.at(-1).batchDigest, 'sha256:batch-100');
});
