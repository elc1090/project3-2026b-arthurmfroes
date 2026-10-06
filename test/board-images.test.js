import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { readBoardElements } from '../src/shared/board-model.js';
import {
  addUploadedImageToBoard,
  boardImageHref,
  fileImageGeometry,
  loadBoardImageAsset,
  readImageDimensions,
  templateImageGeometry,
} from '../src/public/board-images.js';

test('file, clipboard, and template placement preserve the reference sizing rules', () => {
  assert.deepEqual(fileImageGeometry({
    imageWidth: 1000, imageHeight: 500, canvasWidth: 800, centerX: 400, centerY: 300,
  }), { x: 80, y: 140, width: 640, height: 320 });
  assert.deepEqual(templateImageGeometry({
    imageWidth: 1000, imageHeight: 500,
    viewportWidth: 800, viewportHeight: 600, centerX: 400, centerY: 300,
  }), { x: 60, y: 130, width: 680, height: 340 });
  assert.deepEqual(templateImageGeometry({
    imageWidth: 1000, imageHeight: 500,
    viewportWidth: 800, viewportHeight: 600, centerX: 400, centerY: 300,
    existingElements: [{ geometry: { x: 100, y: 40, width: 200, height: 50 } }],
  }), { x: 380, y: 40, width: 680, height: 340 });
});

test('image upload completes before a compact asset reference is added to Yjs', async () => {
  const doc = new Y.Doc();
  let uploaded = false;
  const file = new Blob([Buffer.from([1, 2, 3])], { type: 'image/png' });
  const result = await addUploadedImageToBoard({
    doc,
    boardId: 'board/id',
    file,
    geometry: { x: 10, y: 20, width: 100, height: 50 },
    intrinsicWidth: 200,
    intrinsicHeight: 100,
    idFactory: () => 'image-element',
    origin: 'local-image',
    fetchImpl: async (href, options) => {
      assert.equal(href, '/api/boards/board%2Fid/assets');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers['content-type'], 'image/png');
      assert.deepEqual(Buffer.from(await options.body.arrayBuffer()), Buffer.from([1, 2, 3]));
      uploaded = true;
      return {
        ok: true,
        json: async () => ({ asset: { assetId: 'asset-id', boardId: 'board/id', mimeType: 'image/png', byteLength: 3 } }),
      };
    },
  });

  try {
    assert.equal(uploaded, true);
    assert.equal(result.asset.assetId, 'asset-id');
    assert.deepEqual(readBoardElements(doc), [{
      id: 'image-element', type: 'image',
      geometry: { x: 10, y: 20, width: 100, height: 50 },
      style: {}, data: { assetId: 'asset-id', mimeType: 'image/png', width: 200, height: 100 },
    }]);
    const state = JSON.stringify(readBoardElements(doc));
    assert.doesNotMatch(state, /data:image|base64|AQID/);
  } finally {
    doc.destroy();
  }

  const rejectedDoc = new Y.Doc();
  try {
    await assert.rejects(addUploadedImageToBoard({
      doc: rejectedDoc,
      boardId: 'board/id',
      file,
      geometry: { x: 0, y: 0, width: 10, height: 10 },
      intrinsicWidth: 10,
      intrinsicHeight: 10,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'denied' }) }),
    }), /denied/);
    assert.deepEqual(readBoardElements(rejectedDoc), [], 'failed upload does not publish a Yjs reference');
  } finally {
    rejectedDoc.destroy();
  }
});

test('image loader uses the authorized board route and releases dimension probes', async () => {
  assert.equal(boardImageHref('board/a', 'asset b'), '/api/boards/board%2Fa/assets/asset%20b');
  const blob = new Blob([Buffer.from([4, 5])], { type: 'image/png' });
  let requestedUrl;
  let bitmapBlob;
  const bitmap = { width: 320, height: 200, closed: false, close() { this.closed = true; } };
  const loaded = await loadBoardImageAsset('board/a', 'asset b', {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      return { ok: true, blob: async () => blob };
    },
    createBitmap: async (value) => { bitmapBlob = value; return bitmap; },
  });
  assert.equal(requestedUrl, '/api/boards/board%2Fa/assets/asset%20b');
  assert.equal(bitmapBlob, blob);
  assert.equal(loaded, bitmap);

  const dimensions = await readImageDimensions(blob, async () => bitmap);
  assert.deepEqual(dimensions, { width: 320, height: 200 });
  assert.equal(bitmap.closed, true);
});
