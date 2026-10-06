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
import { CANVAS_ORIGIN } from '../src/public/board-canvas.js';
import { LocalBoardHistory } from '../src/public/board-undo.js';

function localTransaction(doc, history, action) {
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
  localTransaction(doc, history, () => addElement(doc, {
    id: 'rect-a', type: 'rect', geometry: { x: 10, y: 20, width: 30, height: 40 },
  }));
  localTransaction(doc, history, () => setElementGeometry(doc, 'rect-a', {
    x: 25, y: 35, width: 30, height: 40,
  }));

  assert.equal(history.deleteElement('rect-a'), true);
  assert.deepEqual(readBoardElements(doc), []);
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

  history.destroy();
  doc.destroy();
});

test('undoing a local move retains a remote color change to another element', () => {
  const localDoc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const history = new LocalBoardHistory(localDoc, { localOrigin: CANVAS_ORIGIN });
  localTransaction(localDoc, history, () => {
    addElement(localDoc, { id: 'move-me', type: 'rect', geometry: { x: 1, y: 2, width: 8, height: 9 } });
    addElement(localDoc, { id: 'remote-color', type: 'rect', geometry: { x: 30, y: 40, width: 8, height: 9 }, style: { color: '#000' } });
  });
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc), 'initial-sync');
  localTransaction(localDoc, history, () => setElementGeometry(localDoc, 'move-me', {
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
  localTransaction(doc, history, () => addElement(doc, {
    id: 'created-locally', type: 'rect', geometry: { x: 1, y: 2, width: 3, height: 4 },
  }));

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
  localTransaction(doc, history, () => addElement(doc, {
    id: 'stroke-a', type: 'path',
    geometry: { points: [{ x: 0, y: 5 }, { x: 20, y: 5 }] },
    style: { color: '#123' },
  }));

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

  history.destroy();
  doc.destroy();
});
