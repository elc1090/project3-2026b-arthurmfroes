import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { addElement, deleteElement, readBoardElements } from '../src/shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN } from '../src/public/board-canvas.js';
import { createBoardDocument, mountBoardCanvas } from '../src/public/board-entry.js';

class FakeCanvas {
  width = 800;
  height = 480;
  listeners = new Map();
  context = {
    clearCount: 0,
    strokeRects: [],
    clearRect() { this.clearCount += 1; },
    strokeRect(...geometry) { this.strokeRects.push(geometry); },
    fillRect() {},
  };

  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  dispatch(type, point) {
    this.listeners.get(type)({ ...point, pointerId: 1 });
  }
}

test('Canvas creates and moves model elements with one local transaction per completed gesture', () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  const rendered = [];
  const localOrigins = [];
  let tool = 'rectangle';
  let nextId = 0;
  doc.on('update', (_update, origin) => {
    if (origin === CANVAS_ORIGIN) localOrigins.push(origin);
  });
  const binding = bindBoardCanvas({
    doc,
    canvas,
    getTool: () => tool,
    idFactory: () => `local-${++nextId}`,
    drawElement: (_context, element) => rendered.push(element),
  });

  canvas.dispatch('pointerdown', { clientX: 10, clientY: 20 });
  canvas.dispatch('pointerup', { clientX: 70, clientY: 80 });
  assert.deepEqual(readBoardElements(doc).map(({ id, type, geometry }) => ({ id, type, geometry })), [{
    type: 'rect',
    id: 'local-1', geometry: { x: 10, y: 20, width: 60, height: 60 },
  }]);
  assert.equal(localOrigins.length, 1);

  tool = 'select';
  canvas.dispatch('pointerdown', { clientX: 20, clientY: 30 });
  canvas.dispatch('pointerup', { clientX: 35, clientY: 40 });
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 25, y: 30, width: 60, height: 60 });
  assert.equal(localOrigins.length, 2);
  assert.equal(rendered.length, 2);

  binding.destroy();
  doc.destroy();
});

test('a remote Yjs update renders once and never creates a Canvas-origin update', () => {
  const localDoc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const canvas = new FakeCanvas();
  let renderCount = 0;
  let canvasEditCount = 0;
  const binding = bindBoardCanvas({
    doc: localDoc,
    canvas,
    drawElement: () => { renderCount += 1; },
  });
  localDoc.on('update', (_update, origin) => {
    if (origin === CANVAS_ORIGIN) canvasEditCount += 1;
  });
  addElement(remoteDoc, {
    id: 'remote-rect', type: 'rect',
    geometry: { x: 2, y: 3, width: 40, height: 25 },
    style: { color: '#f00' },
  });
  const update = Y.encodeStateAsUpdate(remoteDoc);
  renderCount = 0;

  Y.applyUpdate(localDoc, update, 'remote-test');

  assert.equal(renderCount, 1);
  assert.equal(canvasEditCount, 0);
  assert.equal(readBoardElements(localDoc)[0].id, 'remote-rect');
  binding.destroy();
  localDoc.destroy();
  remoteDoc.destroy();
});

test('the browser entry seeds an independent document from the authorized snapshot', () => {
  const doc = createBoardDocument([{
    id: 'snapshot-rect', type: 'rect',
    geometry: { x: 8, y: 12, width: 22, height: 18 },
    style: { color: '#123456' }, data: { source: 'snapshot' },
  }]);

  assert.deepEqual(readBoardElements(doc), [{
    id: 'snapshot-rect', type: 'rect',
    geometry: { x: 8, y: 12, width: 22, height: 18 },
    style: { color: '#123456' }, data: { source: 'snapshot' },
  }]);
  doc.destroy();
});

test('mount uses a provider-owned Y.Doc, renders its remote rect, and leaves its lifecycle to the caller', () => {
  const doc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const canvas = new FakeCanvas();
  const toolbar = { querySelectorAll: () => [] };
  const mounted = mountBoardCanvas({ canvas, toolbar, doc });
  assert.equal(mounted.doc, doc);
  const rendersBeforeRemote = canvas.context.clearCount;
  addElement(remoteDoc, {
    id: 'provider-remote-rect', type: 'rect',
    geometry: { x: 4, y: 6, width: 30, height: 20 },
  });

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc), 'provider-remote');

  assert.equal(canvas.context.clearCount, rendersBeforeRemote + 1);
  assert.deepEqual(canvas.context.strokeRects, [[4, 6, 30, 20]]);
  mounted.destroy();
  const rendersAfterDestroy = canvas.context.clearCount;
  addElement(doc, {
    id: 'still-provider-owned', type: 'rect',
    geometry: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.equal(readBoardElements(doc).length, 2);
  assert.equal(canvas.context.clearCount, rendersAfterDestroy);
  doc.destroy();
  remoteDoc.destroy();
});

test('authorized image assets render at their model geometry, reuse one decode, and close on removal', async () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  canvas.context.drawImages = [];
  canvas.context.drawImage = function (...args) { this.drawImages.push(args); };
  const bitmap = { closeCount: 0, close() { this.closeCount += 1; } };
  let loads = 0;
  addElement(doc, {
    id: 'image-one', type: 'image',
    geometry: { x: 31, y: 47, width: 120, height: 90 },
    data: { assetId: 'asset-one', mimeType: 'image/png', width: 320, height: 240 },
  });
  const binding = bindBoardCanvas({
    doc,
    canvas,
    boardId: 'authorized-board',
    loadImage: async (boardId, assetId) => {
      loads += 1;
      assert.equal(boardId, 'authorized-board');
      assert.equal(assetId, 'asset-one');
      return bitmap;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.deepEqual(canvas.context.drawImages, [[bitmap, 31, 47, 120, 90]]);

  addElement(doc, {
    id: 'image-two', type: 'image',
    geometry: { x: 200, y: 210, width: 40, height: 30 },
    data: { assetId: 'asset-one', mimeType: 'image/png', width: 320, height: 240 },
  });
  assert.equal(loads, 1, 'the same asset uses its cached bitmap');
  assert.equal(canvas.context.drawImages.length, 3, 'both image references render in board order');
  assert.equal(canvas.context.drawImages[2][1], 200);

  deleteElement(doc, 'image-one');
  assert.equal(bitmap.closeCount, 0, 'a shared cached asset stays open while still referenced');
  deleteElement(doc, 'image-two');
  assert.equal(bitmap.closeCount, 1, 'the cached bitmap closes after its final reference is removed');
  binding.destroy();
  assert.equal(bitmap.closeCount, 1, 'removed bitmaps are not closed twice');
  doc.destroy();
});

test('an image decoded after its reference and Canvas are removed is closed without drawing', async () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  canvas.context.drawImages = [];
  canvas.context.drawImage = function (...args) { this.drawImages.push(args); };
  let resolveBitmap;
  const pendingBitmap = new Promise(resolve => { resolveBitmap = resolve; });
  addElement(doc, {
    id: 'late-image', type: 'image',
    geometry: { x: 10, y: 20, width: 30, height: 40 },
    data: { assetId: 'late-asset', mimeType: 'image/png' },
  });
  const binding = bindBoardCanvas({
    doc,
    canvas,
    boardId: 'authorized-board',
    loadImage: () => pendingBitmap,
  });
  await Promise.resolve();
  deleteElement(doc, 'late-image');
  binding.destroy();
  const bitmap = { closeCount: 0, close() { this.closeCount += 1; } };
  resolveBitmap(bitmap);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bitmap.closeCount, 1);
  assert.deepEqual(canvas.context.drawImages, []);
  doc.destroy();
});
