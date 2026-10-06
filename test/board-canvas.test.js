import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { addElement, readBoardElements } from '../src/shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN } from '../src/public/board-canvas.js';
import { createBoardDocument } from '../src/public/board-entry.js';

class FakeCanvas {
  width = 800;
  height = 480;
  listeners = new Map();
  context = { clearRect() {} };

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
  assert.deepEqual(readBoardElements(doc).map(({ id, geometry }) => ({ id, geometry })), [{
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
    id: 'remote-rect', type: 'rectangle',
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
    id: 'snapshot-rect', type: 'rectangle',
    geometry: { x: 8, y: 12, width: 22, height: 18 },
    style: { color: '#123456' }, data: { source: 'snapshot' },
  }]);

  assert.deepEqual(readBoardElements(doc), [{
    id: 'snapshot-rect', type: 'rectangle',
    geometry: { x: 8, y: 12, width: 22, height: 18 },
    style: { color: '#123456' }, data: { source: 'snapshot' },
  }]);
  doc.destroy();
});
