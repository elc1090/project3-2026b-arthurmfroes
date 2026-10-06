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
    save() {},
    restore() {},
    translate() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    arc() {},
    fillText() {},
    setLineDash() {},
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
  assert.ok(rendered.length >= 3);

  binding.destroy();
  doc.destroy();
});

test('pen, highlighter, line, arrow, rectangle, MUX, and ALU create normalized model elements', () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  let tool = 'pen';
  let id = 0;
  const binding = bindBoardCanvas({
    doc, canvas, getTool: () => tool, getStyle: () => ({ color: '#dc2626', strokeWidth: 4 }),
    idFactory: () => `tool-${++id}`,
  });
  const draw = (nextTool, from, to) => {
    tool = nextTool;
    canvas.dispatch('pointerdown', { clientX: from.x, clientY: from.y });
    canvas.dispatch('pointermove', { clientX: to.x, clientY: to.y });
    canvas.dispatch('pointerup', { clientX: to.x, clientY: to.y });
  };

  draw('pen', { x: 10, y: 10 }, { x: 30, y: 20 });
  draw('highlighter', { x: 40, y: 10 }, { x: 60, y: 20 });
  draw('line', { x: 70, y: 10 }, { x: 90, y: 20 });
  draw('arrow', { x: 100, y: 10 }, { x: 120, y: 20 });
  draw('rectangle', { x: 130, y: 10 }, { x: 150, y: 30 });
  draw('mux', { x: 160, y: 10 }, { x: 170, y: 20 });
  draw('alu', { x: 200, y: 10 }, { x: 210, y: 20 });

  const elements = readBoardElements(doc);
  assert.deepEqual(elements.map(element => element.type), ['path', 'path', 'line', 'arrow', 'rect', 'mux', 'alu']);
  assert.equal(elements[0].style.color, '#dc2626');
  assert.equal(elements[0].style.strokeWidth, 4);
  assert.equal(elements[0].style.tool, 'pen');
  assert.equal(elements[1].style.tool, 'highlighter');
  assert.deepEqual(elements[2].geometry, { x1: 70, y1: 10, x2: 90, y2: 20 });
  assert.deepEqual(elements[4].geometry, { x: 130, y: 10, width: 20, height: 20 });
  assert.equal(elements[5].geometry.width, 30);
  assert.equal(elements[5].geometry.height, 50);
  assert.equal(elements[6].geometry.width, 50);
  assert.equal(elements[6].geometry.height, 60);
  binding.destroy();
  doc.destroy();
});

test('selection stays limited to reference hitboxes while pan, zoom, and fit change the viewport', () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  let tool = 'select';
  addElement(doc, { id: 'path-hitbox', type: 'path', geometry: { points: [{ x: 10, y: 10 }, { x: 60, y: 10 }] } });
  addElement(doc, { id: 'selectable-rect', type: 'rect', geometry: { x: 80, y: 80, width: 20, height: 20 } });
  addElement(doc, { id: 'line-hitbox', type: 'line', geometry: { x1: 10, y1: 50, x2: 60, y2: 50 } });
  addElement(doc, { id: 'arrow-hitbox', type: 'arrow', geometry: { x1: 10, y1: 70, x2: 60, y2: 70 } });
  const binding = bindBoardCanvas({ doc, canvas, getTool: () => tool });

  canvas.dispatch('pointerdown', { clientX: 20, clientY: 10 });
  canvas.dispatch('pointerup', { clientX: 40, clientY: 30 });
  assert.deepEqual(readBoardElements(doc)[0].geometry.points, [{ x: 10, y: 10 }, { x: 60, y: 10 }]);
  assert.deepEqual(readBoardElements(doc)[1].geometry, { x: 80, y: 80, width: 20, height: 20 });
  canvas.dispatch('pointerdown', { clientX: 20, clientY: 50 });
  canvas.dispatch('pointerup', { clientX: 40, clientY: 70 });
  assert.deepEqual(readBoardElements(doc).find(element => element.id === 'line-hitbox').geometry,
    { x1: 10, y1: 50, x2: 60, y2: 50 });
  canvas.dispatch('pointerdown', { clientX: 20, clientY: 70 });
  canvas.dispatch('pointerup', { clientX: 40, clientY: 90 });
  assert.deepEqual(readBoardElements(doc).find(element => element.id === 'arrow-hitbox').geometry,
    { x1: 10, y1: 70, x2: 60, y2: 70 });

  const beforeZoom = binding.getViewport();
  canvas.listeners.get('wheel')({ clientX: 400, clientY: 240, deltaY: -100, preventDefault() {} });
  assert.ok(binding.getViewport().zoom > beforeZoom.zoom);
  binding.resetZoom();
  assert.deepEqual(binding.getViewport(), { zoom: 1, panX: 0, panY: 0 });
  binding.fitToScreen();
  assert.ok(binding.getViewport().zoom > 0 && binding.getViewport().zoom <= 1.25);
  tool = 'pan';
  const beforePan = binding.getViewport();
  canvas.dispatch('pointerdown', { clientX: 50, clientY: 50 });
  canvas.dispatch('pointermove', { clientX: 70, clientY: 60 });
  canvas.dispatch('pointerup', { clientX: 70, clientY: 60 });
  assert.notDeepEqual(binding.getViewport(), beforePan);
  binding.destroy();
  doc.destroy();
});

test('pending image preview renders locally without adding an incomplete Yjs element', async () => {
  const doc = new Y.Doc();
  const canvas = new FakeCanvas();
  canvas.context.drawImages = [];
  canvas.context.drawImage = function (...args) { this.drawImages.push(args); };
  const bitmap = { close() {} };
  const binding = bindBoardCanvas({
    doc, canvas, loadPendingImage: async () => bitmap,
  });
  binding.setPendingImages([{
    pendingId: 'pending-1', elementId: 'reserved-image', geometry: { x: 5, y: 7, width: 40, height: 30 }, blob: new Blob(['offline']),
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(canvas.context.drawImages, [[bitmap, 5, 7, 40, 30]]);
  assert.deepEqual(readBoardElements(doc), []);
  binding.setPendingImages([]);
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
