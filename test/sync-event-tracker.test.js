import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createSyncEventTracker } from '../src/client/sync-event-tracker.js';

test('update observations share a byte digest and keep first arrival local to a replica', async () => {
  const source = new Y.Doc();
  const bytes = new Promise((resolve) => source.on('update', (update) => resolve(update)));
  source.getMap('board').set('element', { label: 'one edit' });
  const update = await bytes;
  const events = [];
  let time = Date.UTC(2026, 9, 6);
  const tracker = createSyncEventTracker('board-a', {
    replicaId: 'browser-a',
    now: () => time++,
    onEvent: (type, detail) => events.push({ type, detail }),
  });

  const local = await tracker.observeUpdate(update, { sourcePath: 'local', actionKind: 'canvas-gesture' });
  const server = await tracker.observeUpdate(update, { sourcePath: 'server', actionKind: 'server-update' });
  assert.equal(local.actionId, server.actionId);
  assert.match(local.actionId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(local.firstArrivalPath, 'local');
  assert.equal(server.firstArrivalPath, 'local');
  assert.deepEqual(events.map(({ detail }) => detail.sequence), [1, 2]);
  assert.ok(new Date(local.observedAt).getTime() < new Date(server.observedAt).getTime());
  source.destroy();
});

test('state-vector batches may have a different digest from individual updates', async () => {
  const source = new Y.Doc();
  const updates = [];
  source.on('update', (update) => updates.push(update));
  source.getMap('board').set('first', 'a');
  source.getMap('board').set('second', 'b');
  assert.equal(updates.length, 2);

  const events = [];
  const tracker = createSyncEventTracker('board-a', {
    replicaId: 'browser-late-join',
    onEvent: (type, detail) => events.push({ type, detail }),
  });
  const first = await tracker.observeUpdate(updates[0], { sourcePath: 'local' });
  const batchBytes = Y.mergeUpdates(updates);
  const batch = await tracker.observeSyncBatch(batchBytes, { state: 'initial-server-diff' });

  assert.notEqual(batch.actionId, first.actionId);
  assert.equal(events[1].type, 'sync-batch');
  assert.equal(events[1].detail.sourcePath, 'server');
  assert.equal(events[1].detail.firstArrivalPath, 'server');
  source.destroy();
});
