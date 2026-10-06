import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as Y from 'yjs';
import { readBoardElements } from '../src/shared/board-model.js';
import { addImageAssetReference } from '../src/public/board-images.js';
import {
  enqueuePendingBoardImage,
  listPendingBoardImages,
  publishPendingBoardImages,
  removePendingBoardImage,
  shouldQueuePendingImage,
  subscribePendingBoardImages,
} from '../src/client/pending-board-images.js';

const imageBytes = await readFile(new URL('../whiteboard/templates/completo_multi_fsm_10_estados.png', import.meta.url));
const file = new Blob([imageBytes], { type: 'image/png' });
const geometry = { x: 40, y: 60, width: 320, height: 332 };

test('offline images stay local, survive a fresh subscription, and publish only after successful upload', async () => {
  const boardId = `pending-board-${randomUUID()}`;
  const sharedDoc = new Y.Doc();
  const snapshots = [];
  const unsubscribe = await subscribePendingBoardImages(boardId, snapshot => snapshots.push(snapshot));
  try {
    assert.deepEqual(snapshots, [[]]);
    const pending = await enqueuePendingBoardImage(boardId, {
      file,
      geometry,
      intrinsicWidth: 982,
      intrinsicHeight: 1018,
      elementId: 'stable-image-element',
      idFactory: () => 'stable-pending-id',
    });
    assert.deepEqual(readBoardElements(sharedDoc), [], 'the pending image never enters the shared Y.Doc');
    assert.equal(snapshots.at(-1).length, 1);
    assert.equal(snapshots.at(-1)[0].pendingId, pending.pendingId);

    unsubscribe();
    const reopenedSnapshots = [];
    const unsubscribeReopened = await subscribePendingBoardImages(boardId, snapshot => reopenedSnapshots.push(snapshot));
    try {
      assert.equal(reopenedSnapshots[0][0].elementId, 'stable-image-element');
      assert.deepEqual(reopenedSnapshots[0][0].geometry, geometry);
      assert.deepEqual(Buffer.from(await reopenedSnapshots[0][0].blob.arrayBuffer()), imageBytes,
        'a fresh subscriber can decode the same stored Blob after reopening');

      let uploadCalls = 0;
      const upload = async (record) => {
        uploadCalls += 1;
        assert.equal(record.pendingId, pending.pendingId);
        throw new TypeError('VPS offline');
      };
      assert.equal(shouldQueuePendingImage(new TypeError('VPS offline')), true);
      await assert.rejects(publishPendingBoardImages(boardId, {
        upload,
        publish: async () => assert.fail('must not publish before upload succeeds'),
      }), /VPS offline/);
      assert.equal(uploadCalls, 1);
      assert.equal((await listPendingBoardImages(boardId)).length, 1);
      assert.deepEqual(readBoardElements(sharedDoc), []);

      await assert.rejects(publishPendingBoardImages(boardId, {
        upload: async () => ({ assetId: 'asset-local', boardId, mimeType: 'image/png' }),
        publish: async () => { throw new Error('local Y.Doc unavailable'); },
      }), /local Y.Doc unavailable/);
      const retryRecord = (await listPendingBoardImages(boardId))[0];
      assert.equal(retryRecord.uploadedAsset.assetId, 'asset-local', 'successful uploads survive a publish retry');
      let retryUploads = 0;
      const published = await publishPendingBoardImages(boardId, {
        upload: async () => { retryUploads += 1; throw new Error('the saved uploaded asset should be reused'); },
        publish: async ({ pending: queued, asset }) => {
          assert.equal(queued.elementId, 'stable-image-element');
          addImageAssetReference(sharedDoc, {
            asset,
            geometry: queued.geometry,
            intrinsicWidth: queued.intrinsicWidth,
            intrinsicHeight: queued.intrinsicHeight,
            idFactory: () => queued.elementId,
            origin: 'pending-image-publish',
          });
        },
      });
      assert.equal(retryUploads, 0);
      assert.equal(published.length, 1);
      assert.deepEqual(readBoardElements(sharedDoc), [{
        id: 'stable-image-element', type: 'image', geometry,
        style: {}, data: { assetId: 'asset-local', mimeType: 'image/png', width: 982, height: 1018 },
      }]);
      assert.deepEqual(await listPendingBoardImages(boardId), []);
      assert.deepEqual(reopenedSnapshots.at(-1), [], 'successful publish removes the local preview');
    } finally {
      unsubscribeReopened();
    }
  } finally {
    unsubscribe();
    sharedDoc.destroy();
    await removePendingBoardImage(boardId, 'stable-pending-id');
  }
});

test('pending images reject invalid payloads and do not queue authorization or validation failures', async () => {
  const boardId = `pending-validation-${randomUUID()}`;
  const input = {
    file,
    geometry,
    intrinsicWidth: 982,
    intrinsicHeight: 1018,
    idFactory: () => 'validation-pending-id',
  };
  assert.equal(shouldQueuePendingImage({ status: 401 }), false);
  assert.equal(shouldQueuePendingImage({ status: 403 }), false);
  assert.equal(shouldQueuePendingImage({ status: 413 }), false);
  assert.equal(shouldQueuePendingImage({ status: 415 }), false);
  assert.equal(shouldQueuePendingImage({ status: 503 }), true);
  assert.equal(shouldQueuePendingImage({ status: 429 }), true);
  await assert.rejects(enqueuePendingBoardImage('', input), /boardId/);
  await assert.rejects(enqueuePendingBoardImage(boardId, { ...input, geometry: { x: 0, y: 0, width: -1, height: 1 } }), /geometry/);
  await assert.rejects(enqueuePendingBoardImage(boardId, { ...input, file: new Blob(['x'], { type: 'image/svg+xml' }) }), /PNG, JPEG/);
  assert.deepEqual(await listPendingBoardImages(boardId), []);
});
