import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import {
  addElement,
  deleteElement,
  eraseBoardAt,
  getBoardMaps,
  readBoardElements,
  setElementGeometry,
  setElementStyle,
} from '../src/shared/board-model.js';

function newDoc(clientID) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

function baseDocument(seed) {
  const doc = newDoc(100);
  for (const element of seed) addElement(doc, element);
  return { update: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}

function replica(update, clientID) {
  const doc = newDoc(clientID);
  Y.applyUpdate(doc, update);
  return doc;
}

function delta(doc, stateVector) {
  return Y.encodeStateAsUpdate(doc, stateVector);
}

function mergeInBothOrders(baseUpdate, updateA, updateB) {
  const first = replica(baseUpdate, 901);
  Y.applyUpdate(first, updateA);
  Y.applyUpdate(first, updateB);

  const second = replica(baseUpdate, 902);
  Y.applyUpdate(second, updateB);
  Y.applyUpdate(second, updateA);
  return [first, second];
}

function path(id = 'stroke') {
  return {
    id,
    type: 'path',
    geometry: { points: [{ x: -10, y: 0 }, { x: 10, y: 0 }] },
    style: { tool: 'pen', color: '#000000', strokeWidth: 4 },
  };
}

test('a concurrent delete stays deleted when another replica changes color and geometry', () => {
  const base = baseDocument([path()]);
  const deleter = replica(base.update, 201);
  const editor = replica(base.update, 202);

  deleteElement(deleter, 'stroke');
  setElementGeometry(editor, 'stroke', { points: [{ x: 30, y: 40 }, { x: 50, y: 60 }] });
  setElementStyle(editor, 'stroke', 'color', '#ff0000');

  const [forward, reversed] = mergeInBothOrders(
    base.update,
    delta(deleter, base.stateVector),
    delta(editor, base.stateVector),
  );

  for (const doc of [forward, reversed]) {
    assert.deepEqual(readBoardElements(doc), []);
    const record = getBoardMaps(doc).elements.get('stroke');
    assert.equal(record.get('deleted'), true);
    assert.deepEqual(record.get('geometry'), { points: [{ x: 30, y: 40 }, { x: 50, y: 60 }] });
    assert.equal(record.get('style').get('color'), '#ff0000');
    assert.equal(deleteElement(doc, 'stroke'), false);
  }
  assert.deepEqual(readBoardElements(forward), readBoardElements(reversed));
});

test('erasing a segment that crosses the circle tombstones it and inserts visible runs atomically, leaving images intact', () => {
  const doc = newDoc(200);
  addElement(doc, {
    id: 'image-1',
    type: 'image',
    geometry: { x: -5, y: -5, width: 10, height: 10 },
    data: { assetId: 'asset-1' },
  });
  addElement(doc, path());

  const events = [];
  doc.on('update', update => events.push(update));
  let nextId = 0;
  const result = eraseBoardAt(doc, {
    x: 0,
    y: 0,
    radius: 2,
    createId: () => `stroke-segment-${++nextId}`,
  });

  assert.deepEqual(result, {
    deletedIds: ['stroke'],
    createdIds: ['stroke-segment-1', 'stroke-segment-2'],
  });
  assert.equal(nextId, 2);
  assert.equal(events.length, 1, 'the erase operation emits one Yjs transaction update');
  assert.equal(getBoardMaps(doc).elements.get('stroke').get('deleted'), true);
  assert.deepEqual(getBoardMaps(doc).order.toArray(), [
    'image-1', 'stroke', 'stroke-segment-1', 'stroke-segment-2',
  ]);
  assert.deepEqual(readBoardElements(doc).map(({ id }) => id), [
    'image-1', 'stroke-segment-1', 'stroke-segment-2',
  ]);

  const [left, right] = readBoardElements(doc).slice(1);
  assert.deepEqual(left.geometry.points, [{ x: -10, y: 0 }, { x: -2, y: 0 }]);
  assert.deepEqual(right.geometry.points, [{ x: 2, y: 0 }, { x: 10, y: 0 }]);
  assert.deepEqual(left.style, { tool: 'pen', color: '#000000', strokeWidth: 4 });
  assert.deepEqual(left.style, right.style);
  assert.deepEqual(readBoardElements(doc)[0], {
    id: 'image-1',
    type: 'image',
    geometry: { x: -5, y: -5, width: 10, height: 10 },
    style: {},
    data: { assetId: 'asset-1' },
  });
});

test('replacement segment IDs and stacking remain stable after reversed update delivery and state re-encoding', () => {
  const base = baseDocument([
    path(),
    {
      id: 'other-shape',
      type: 'rect',
      geometry: { x: 20, y: 20, width: 10, height: 10 },
      style: { color: '#0000ff' },
    },
  ]);
  const eraser = replica(base.update, 201);
  const editor = replica(base.update, 202);
  const generated = [];
  let nextId = 0;

  const eraseResult = eraseBoardAt(eraser, {
    x: 0,
    y: 0,
    radius: 2,
    createId: () => {
      const id = `stable-segment-${++nextId}`;
      generated.push(id);
      return id;
    },
  });
  setElementStyle(editor, 'other-shape', 'color', '#00ff00');

  const [forward, reversed] = mergeInBothOrders(
    base.update,
    delta(eraser, base.stateVector),
    delta(editor, base.stateVector),
  );
  const expectedIds = ['stable-segment-1', 'stable-segment-2', 'other-shape'];
  assert.deepEqual(eraseResult.createdIds, generated);
  assert.deepEqual(readBoardElements(forward).map(({ id }) => id), expectedIds);
  assert.deepEqual(readBoardElements(reversed), readBoardElements(forward));

  const replay = replica(Y.encodeStateAsUpdate(forward), 903);
  assert.deepEqual(readBoardElements(replay), readBoardElements(forward));
  assert.deepEqual(getBoardMaps(replay).order.toArray(), getBoardMaps(forward).order.toArray());
  assert.equal(nextId, 2, 'reading and replicating never allocate replacement IDs again');
});
