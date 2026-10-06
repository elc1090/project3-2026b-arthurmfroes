import * as Y from 'yjs';

const ELEMENTS_KEY = 'elements';
const ORDER_KEY = 'order';

function cloneJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  return JSON.parse(serialized);
}

function requireElement(doc, id) {
  const element = getBoardMaps(doc).elements.get(id);
  if (!(element instanceof Y.Map)) {
    throw new Error(`Unknown board element: ${id}`);
  }
  return element;
}

/**
 * Return the shared collections for one board document.
 * Each board must own a distinct Y.Doc; its `elements` map is keyed by stable
 * element IDs and `order` is the shared front-to-back sequence of those IDs.
 */
export function getBoardMaps(doc) {
  return {
    elements: doc.getMap(ELEMENTS_KEY),
    order: doc.getArray(ORDER_KEY),
  };
}

/** Create an ID once when an element is authored and retain it across updates. */
export function createElementId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to create board element IDs');
  }
  return globalThis.crypto.randomUUID();
}

/**
 * Insert an element into a board. Geometry is one JSON value so a concurrent
 * move resolves to one complete geometry; style keys are separate CRDT values.
 * `data` holds other element content such as text or asset references.
 */
export function addElement(doc, { id, type, geometry, style = {}, data = {} }) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('element id must be a non-empty stable string');
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new TypeError('element type must be a non-empty string');
  }
  if (geometry === undefined) {
    throw new TypeError('element geometry is required');
  }
  if (!style || typeof style !== 'object' || Array.isArray(style)) {
    throw new TypeError('element style must be an object');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('element data must be an object');
  }

  const { elements, order } = getBoardMaps(doc);
  if (elements.has(id)) {
    throw new Error(`Board element already exists: ${id}`);
  }

  const record = new Y.Map();
  const styleMap = new Y.Map();
  const dataMap = new Y.Map();
  record.set('type', type);
  record.set('geometry', cloneJson(geometry, 'element geometry'));
  for (const [key, value] of Object.entries(style)) {
    styleMap.set(key, cloneJson(value, `element style.${key}`));
  }
  for (const [key, value] of Object.entries(data)) {
    dataMap.set(key, cloneJson(value, `element data.${key}`));
  }
  record.set('style', styleMap);
  record.set('data', dataMap);

  doc.transact(() => {
    elements.set(id, record);
    order.push([id]);
  });
  return id;
}

/** Replace the complete geometry in one Y.Map write. */
export function setElementGeometry(doc, id, geometry) {
  requireElement(doc, id).set('geometry', cloneJson(geometry, 'element geometry'));
}

/** Set one style property without replacing geometry or other style fields. */
export function setElementStyle(doc, id, key, value) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('style key must be a non-empty string');
  }
  const style = requireElement(doc, id).get('style');
  if (!(style instanceof Y.Map)) {
    throw new Error(`Board element has no style map: ${id}`);
  }
  style.set(key, cloneJson(value, `element style.${key}`));
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, cloneJson(value, key)]));
}

/** Read an element as detached JSON for rendering or inspection. */
export function readElement(doc, id) {
  const record = requireElement(doc, id);
  const style = record.get('style');
  const data = record.get('data');
  return {
    id,
    type: record.get('type'),
    geometry: cloneJson(record.get('geometry'), 'element geometry'),
    style: style instanceof Y.Map ? mapToObject(style) : {},
    data: data instanceof Y.Map ? mapToObject(data) : {},
  };
}

/** Read existing elements in their shared stacking order, skipping stale IDs. */
export function readBoardElements(doc) {
  const { elements, order } = getBoardMaps(doc);
  const seen = new Set();
  const result = [];
  for (const id of order.toArray()) {
    if (seen.has(id) || !elements.has(id)) continue;
    seen.add(id);
    result.push(readElement(doc, id));
  }
  return result;
}
