import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import {
  addElement,
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
  return {
    doc,
    update: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
  };
}

function replica(update, clientID = 900) {
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

const rectangle = (x, y, width = 30, height = 20) => ({ x, y, width, height });

test('concurrent move and recolor preserve both independent element properties', () => {
  const base = baseDocument([{
    id: 'element-1',
    type: 'rect',
    geometry: rectangle(0, 0),
    style: { color: '#000000', strokeWidth: 2 },
  }]);
  const mover = replica(base.update, 201);
  const recolorer = replica(base.update, 202);

  setElementGeometry(mover, 'element-1', rectangle(100, 60));
  setElementStyle(recolorer, 'element-1', 'color', '#ff0000');

  const [forward, reversed] = mergeInBothOrders(
    base.update,
    delta(mover, base.stateVector),
    delta(recolorer, base.stateVector),
  );

  assert.deepEqual(readBoardElements(forward), readBoardElements(reversed));
  assert.deepEqual(readBoardElements(forward)[0], {
    id: 'element-1',
    type: 'rect',
    geometry: rectangle(100, 60),
    style: { color: '#ff0000', strokeWidth: 2 },
    data: {},
  });
});

test('concurrent moves resolve to one complete geometry independent of update arrival order', () => {
  const base = baseDocument([{
    id: 'element-1',
    type: 'rect',
    geometry: rectangle(0, 0),
  }]);
  const moverA = replica(base.update, 201);
  const moverB = replica(base.update, 202);
  const geometryA = rectangle(100, 60, 40, 25);
  const geometryB = rectangle(-30, 140, 80, 50);

  setElementGeometry(moverA, 'element-1', geometryA);
  setElementGeometry(moverB, 'element-1', geometryB);

  const [forward, reversed] = mergeInBothOrders(
    base.update,
    delta(moverA, base.stateVector),
    delta(moverB, base.stateVector),
  );
  const resolvedGeometry = readBoardElements(forward)[0].geometry;

  assert.deepEqual(readBoardElements(forward), readBoardElements(reversed));
  assert.ok(
    JSON.stringify(resolvedGeometry) === JSON.stringify(geometryA)
      || JSON.stringify(resolvedGeometry) === JSON.stringify(geometryB),
    'the winner must be one complete authored geometry',
  );
});

test('concurrent overlapping insertions converge to one shared stacking order', () => {
  const base = baseDocument([]);
  const authorA = replica(base.update, 201);
  const authorB = replica(base.update, 202);
  const overlap = rectangle(10, 10, 50, 50);

  addElement(authorA, {
    id: 'red-shape',
    type: 'rect',
    geometry: overlap,
    style: { color: '#ff0000' },
  });
  addElement(authorB, {
    id: 'blue-shape',
    type: 'rect',
    geometry: overlap,
    style: { color: '#0000ff' },
  });

  const [forward, reversed] = mergeInBothOrders(
    base.update,
    delta(authorA, base.stateVector),
    delta(authorB, base.stateVector),
  );

  assert.deepEqual(readBoardElements(forward), readBoardElements(reversed));
  assert.deepEqual(
    getBoardMaps(forward).order.toArray(),
    getBoardMaps(reversed).order.toArray(),
  );
  assert.deepEqual(new Set(readBoardElements(forward).map(({ id }) => id)), new Set(['red-shape', 'blue-shape']));
  assert.ok(readBoardElements(forward).every(({ geometry }) => JSON.stringify(geometry) === JSON.stringify(overlap)));
});
