import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  addElement,
  getBoardMaps,
  readBoardElements,
  setElementGeometry,
  setElementStyle,
} from '../src/shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN } from '../src/public/board-canvas.js';
import { LocalBoardHistory } from '../src/public/board-undo.js';

function localTransaction(doc, history, metadata, action) {
  history.beginLocalAction(metadata);
  doc.transact(action, CANVAS_ORIGIN);
  history.stopCapturing();
}

test('undo preserves interleaved create, move, and terminal-delete history', () => {
  const doc = new Y.Doc();
  let nextId = 0;
  const history = new LocalBoardHistory(doc, {
    localOrigin: CANVAS_ORIGIN,
    createId: () => `restored-${++nextId}`,
  });
  const original = { id: 'rect-a', type: 'rect', geometry: { x: 10, y: 20, width: 30, height: 40 }, style: {}, data: {} };
  localTransaction(doc, history, {
    kind: 'create', logicalId: 'rect-a', index: 0, element: original,
  }, () => addElement(doc, original));
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['rect-a']);
  assert.equal(getBoardMaps(doc).elements.get('rect-a').get('deleted'), false);
  localTransaction(doc, history, {
    kind: 'move', logicalId: 'rect-a', physicalId: 'rect-a', delta: { x: 15, y: 15 },
  }, () => setElementGeometry(doc, 'rect-a', {
    x: 25, y: 35, width: 30, height: 40,
  }));
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['rect-a']);
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 25, y: 35, width: 30, height: 40 });

  assert.equal(history.deleteElement('rect-a'), true);
  assert.deepEqual(readBoardElements(doc), []);
  assert.equal(getBoardMaps(doc).elements.get('rect-a').get('deleted'), true);
  assert.equal(history.undo(), true);
  const restored = readBoardElements(doc)[0];
  assert.equal(restored.id, 'restored-1');
  assert.deepEqual(restored.geometry, { x: 25, y: 35, width: 30, height: 40 });
  assert.equal(getBoardMaps(doc).elements.get('rect-a').get('deleted'), true);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc), []);
  assert.equal(getBoardMaps(doc).elements.get('restored-1').get('deleted'), true);
  assert.equal(history.undo(), true);
  assert.equal(readBoardElements(doc)[0].id, 'restored-2');
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 25, y: 35, width: 30, height: 40 });
  assert.equal(getBoardMaps(doc).elements.get('restored-1').get('deleted'), true);
  assert.equal(getBoardMaps(doc).elements.get('restored-2').get('deleted'), false);
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 10, y: 20, width: 30, height: 40 });
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc), []);
  assert.equal(getBoardMaps(doc).elements.get('restored-2').get('deleted'), true);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['restored-3']);
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 10, y: 20, width: 30, height: 40 });
  assert.equal(getBoardMaps(doc).elements.get('restored-3').get('deleted'), false);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['restored-3']);
  assert.deepEqual(readBoardElements(doc)[0].geometry, { x: 25, y: 35, width: 30, height: 40 });
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc), []);
  for (const id of ['rect-a', 'restored-1', 'restored-2', 'restored-3']) {
    assert.equal(getBoardMaps(doc).elements.get(id).get('deleted'), true);
  }

  history.destroy();
  doc.destroy();
});

test('undoing a local move retains a remote color change to another element', () => {
  const localDoc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const history = new LocalBoardHistory(localDoc, { localOrigin: CANVAS_ORIGIN });
  localTransaction(localDoc, history, {
    kind: 'create', logicalId: 'move-me', index: 0,
    element: { id: 'move-me', type: 'rect', geometry: { x: 1, y: 2, width: 8, height: 9 }, style: {}, data: {} },
  }, () => {
    addElement(localDoc, { id: 'move-me', type: 'rect', geometry: { x: 1, y: 2, width: 8, height: 9 } });
    addElement(localDoc, { id: 'remote-color', type: 'rect', geometry: { x: 30, y: 40, width: 8, height: 9 }, style: { color: '#000' } });
  });
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc), 'initial-sync');
  localTransaction(localDoc, history, {
    kind: 'move', logicalId: 'move-me', physicalId: 'move-me', delta: { x: 14, y: 20 },
  }, () => setElementGeometry(localDoc, 'move-me', {
    x: 15, y: 22, width: 8, height: 9,
  }));
  setElementStyle(remoteDoc, 'remote-color', 'color', '#f00');
  Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc)), 'remote-edit');

  assert.equal(history.undo(), true);
  const elements = new Map(readBoardElements(localDoc).map(element => [element.id, element]));
  assert.deepEqual(elements.get('move-me').geometry, { x: 1, y: 2, width: 8, height: 9 });
  assert.equal(elements.get('remote-color').style.color, '#f00');

  history.destroy();
  localDoc.destroy();
  remoteDoc.destroy();
});

test('Y.UndoManager captures local creation and redo recreates it', () => {
  const doc = new Y.Doc();
  const history = new LocalBoardHistory(doc, { localOrigin: CANVAS_ORIGIN });
  const element = { id: 'created-locally', type: 'rect', geometry: { x: 1, y: 2, width: 3, height: 4 }, style: {}, data: {} };
  localTransaction(doc, history, {
    kind: 'create', logicalId: 'created-locally', index: 0, element,
  }, () => addElement(doc, element));

  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc), []);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['created-locally']);

  history.destroy();
  doc.destroy();
});

test('eraser undo restores original strokes with fresh IDs and redo recreates clipped segments', () => {
  const doc = new Y.Doc();
  let nextId = 0;
  const history = new LocalBoardHistory(doc, {
    localOrigin: CANVAS_ORIGIN,
    createId: () => `eraser-${++nextId}`,
  });
  const stroke = {
    id: 'stroke-a', type: 'path',
    geometry: { points: [{ x: 0, y: 5 }, { x: 20, y: 5 }] },
    style: { color: '#123' },
  };
  localTransaction(doc, history, {
    kind: 'create', logicalId: 'stroke-a', index: 0, element: { ...stroke, data: {} },
  }, () => addElement(doc, stroke));

  const erased = history.eraseAt({ x: 10, y: 5, radius: 3 });
  assert.deepEqual(erased.deletedIds, ['stroke-a']);
  assert.equal(readBoardElements(doc).length, 2);
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['eraser-3']);
  assert.deepEqual(readBoardElements(doc)[0].geometry.points, [{ x: 0, y: 5 }, { x: 20, y: 5 }]);
  assert.equal(getBoardMaps(doc).elements.get('stroke-a').get('deleted'), true);
  const firstSegmentIds = erased.createdIds;
  for (const id of firstSegmentIds) assert.equal(getBoardMaps(doc).elements.get(id).get('deleted'), true);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.type), ['path', 'path']);
  assert.ok(readBoardElements(doc).every(element => element.id.startsWith('eraser-')));
  assert.equal(getBoardMaps(doc).elements.get('eraser-3').get('deleted'), true);
  for (const id of firstSegmentIds) assert.equal(getBoardMaps(doc).elements.get(id).get('deleted'), true);
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.geometry.points), [[{ x: 0, y: 5 }, { x: 20, y: 5 }]]);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['eraser-6']);
  assert.equal(getBoardMaps(doc).elements.get('eraser-3').get('deleted'), true);
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc), []);
  assert.equal(getBoardMaps(doc).elements.get('eraser-6').get('deleted'), true);
  assert.equal(history.redo(), true);
  assert.deepEqual(readBoardElements(doc).map(element => element.id), ['eraser-7']);
  assert.deepEqual(readBoardElements(doc)[0].geometry.points, [{ x: 0, y: 5 }, { x: 20, y: 5 }]);
  assert.equal(getBoardMaps(doc).elements.get('eraser-7').get('deleted'), false);
  assert.equal(history.redo(), true);
  const finalSegments = readBoardElements(doc);
  assert.equal(finalSegments.length, 2);
  assert.deepEqual(finalSegments.map(element => element.geometry.points), [
    [{ x: 0, y: 5 }, { x: 7, y: 5 }],
    [{ x: 13, y: 5 }, { x: 20, y: 5 }],
  ]);
  assert.equal(getBoardMaps(doc).elements.get('eraser-7').get('deleted'), true);
  for (const segment of finalSegments) assert.equal(getBoardMaps(doc).elements.get(segment.id).get('deleted'), false);
  for (const id of ['stroke-a', ...firstSegmentIds, 'eraser-3', 'eraser-4', 'eraser-5', 'eraser-6']) {
    assert.equal(getBoardMaps(doc).elements.get(id).get('deleted'), true);
  }

  history.destroy();
  doc.destroy();
});

test('Canvas pointer gestures invoke local delete and eraser history commands', () => {
  const doc = new Y.Doc();
  let tool = 'delete';
  let nextId = 0;
  const history = new LocalBoardHistory(doc, {
    localOrigin: CANVAS_ORIGIN,
    createId: () => `canvas-undo-${++nextId}`,
  });
  addElement(doc, { id: 'canvas-rect', type: 'rect', geometry: { x: 10, y: 10, width: 20, height: 20 } });
  addElement(doc, {
    id: 'canvas-path', type: 'path',
    geometry: { points: [{ x: 0, y: 80 }, { x: 100, y: 80 }] },
  });
  const canvas = {
    width: 120,
    height: 120,
    listeners: new Map(),
    context: {
      clearRect() {}, strokeRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    },
    getContext() { return this.context; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 120 }; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type, listener) { this.listeners.delete(type); },
    dispatch(type, x, y) { this.listeners.get(type)?.({ clientX: x, clientY: y, pointerId: 1 }); },
  };
  const binding = bindBoardCanvas({
    doc, canvas, getTool: () => tool,
    getLogicalId: id => history.logicalIdFor(id),
    beforeLocalAction: action => history.beginLocalAction(action),
    afterLocalAction: () => history.stopCapturing(),
    deleteElement: id => history.deleteElement(id),
    eraseAt: options => history.eraseAt(options),
  });

  canvas.dispatch('pointerdown', 15, 15);
  canvas.dispatch('pointerup', 15, 15);
  assert.equal(readBoardElements(doc).some(element => element.id === 'canvas-rect'), false);
  assert.equal(history.undo(), true);
  assert.equal(readBoardElements(doc)[0].geometry.x, 10);
  assert.equal(history.redo(), true);

  tool = 'eraser';
  canvas.dispatch('pointerdown', 40, 80);
  canvas.dispatch('pointermove', 50, 80);
  canvas.dispatch('pointerup', 60, 80);
  assert.equal(getBoardMaps(doc).elements.get('canvas-path').get('deleted'), true);
  assert.ok(readBoardElements(doc).filter(element => element.type === 'path').length > 0);
  assert.equal(history.undo(), true);
  assert.deepEqual(readBoardElements(doc).find(element => element.type === 'path').geometry.points,
    [{ x: 0, y: 80 }, { x: 100, y: 80 }]);
  assert.equal(history.redo(), true);
  assert.ok(readBoardElements(doc).filter(element => element.type === 'path').length > 0);

  binding.destroy();
  history.destroy();
  doc.destroy();
});
