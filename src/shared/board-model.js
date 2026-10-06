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

function createElementRecord({ type, geometry, style = {}, data = {} }) {
  const record = new Y.Map();
  const styleMap = new Y.Map();
  const dataMap = new Y.Map();
  record.set('type', type);
  record.set('geometry', cloneJson(geometry, 'element geometry'));
  record.set('deleted', false);
  for (const [key, value] of Object.entries(style)) {
    styleMap.set(key, cloneJson(value, `element style.${key}`));
  }
  for (const [key, value] of Object.entries(data)) {
    dataMap.set(key, cloneJson(value, `element data.${key}`));
  }
  record.set('style', styleMap);
  record.set('data', dataMap);
  return record;
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

  const record = createElementRecord({ type, geometry, style, data });

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

/** Set the terminal tombstone. There is deliberately no undelete operation. */
export function deleteElement(doc, id) {
  const element = requireElement(doc, id);
  if (element.get('deleted') === true) return false;
  doc.transact(() => element.set('deleted', true));
  return true;
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, cloneJson(value, key)]));
}

/** Read an element as detached JSON for rendering or inspection. */
export function readElement(doc, id) {
  const record = requireElement(doc, id);
  if (record.get('deleted') === true) return null;
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
    const element = readElement(doc, id);
    if (element) result.push(element);
  }
  return result;
}

function samePoint(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 0.05;
}

function pointOnSegment(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function distanceSquared(point, center) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return dx * dx + dy * dy;
}

function segmentEntersCircle(a, b, center, radiusSquared) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return distanceSquared(a, center) < radiusSquared;
  const projection = ((center.x - a.x) * dx + (center.y - a.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  return distanceSquared(pointOnSegment(a, b, t), center) < radiusSquared;
}

/**
 * Return the visible polyline runs after removing the portions strictly inside
 * a circle. Intersections are calculated analytically for every segment, so a
 * fast stroke segment is clipped even when no sampled point lies in the circle.
 * Complete strokes use one geometry value shaped as
 * `{ points: [{ x: number, y: number }, ...] }`; vertices are not separate CRDT
 * items. Their `tool`, `color`, and `strokeWidth` live in separate style keys.
 */
export function clipStrokePoints(points, center, radius) {
  if (!Array.isArray(points)) throw new TypeError('stroke points must be an array');
  if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) {
    throw new TypeError('eraser center must have finite coordinates');
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new TypeError('eraser radius must be a positive finite number');
  }
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new TypeError('stroke points must have finite coordinates');
    }
  }
  if (points.length === 0) return [];

  const radiusSquared = radius * radius;
  const intersects = points.length === 1
    ? distanceSquared(points[0], center) < radiusSquared
    : points.slice(1).some((point, index) => segmentEntersCircle(points[index], point, center, radiusSquared));
  if (!intersects) return [points.map(point => ({ ...point }))];

  if (points.length === 1) {
    return [];
  }

  const runs = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    const clean = [current[0]];
    for (let i = 1; i < current.length; i++) {
      if (!samePoint(clean[clean.length - 1], current[i])) clean.push(current[i]);
    }
    if (clean.length === 1) {
      clean.push({ x: clean[0].x + 0.1, y: clean[0].y + 0.1 });
    }
    runs.push(clean);
    current = [];
  };

  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-9) {
      if (distanceSquared(a, center) >= radiusSquared) {
        if (current.length === 0) current.push({ ...a });
        current.push({ ...b });
      } else {
        flush();
      }
      continue;
    }

    const fx = a.x - center.x;
    const fy = a.y - center.y;
    const linear = 2 * (dx * fx + dy * fy);
    const constant = fx * fx + fy * fy - radiusSquared;
    const discriminant = linear * linear - 4 * lengthSquared * constant;
    const cuts = [0, 1];
    if (discriminant > 0) {
      const root = Math.sqrt(discriminant);
      const first = (-linear - root) / (2 * lengthSquared);
      const second = (-linear + root) / (2 * lengthSquared);
      if (first > 0 && first < 1) cuts.push(first);
      if (second > 0 && second < 1) cuts.push(second);
    }
    cuts.sort((left, right) => left - right);

    let hasVisibleInterval = false;
    for (let cut = 0; cut < cuts.length - 1; cut++) {
      const start = cuts[cut];
      const end = cuts[cut + 1];
      if (end - start < 1e-9) continue;
      const middle = pointOnSegment(a, b, (start + end) / 2);
      if (distanceSquared(middle, center) < radiusSquared) {
        flush();
        continue;
      }

      const startPoint = pointOnSegment(a, b, start);
      const endPoint = pointOnSegment(a, b, end);
      if (current.length > 0 && samePoint(current[current.length - 1], startPoint)) {
        current.push(endPoint);
      } else {
        flush();
        current = [startPoint, endPoint];
      }
      hasVisibleInterval = true;
    }
    if (!hasVisibleInterval) flush();
  }
  flush();
  return runs;
}

/**
 * Erase one circular area from completed path strokes in a single Yjs
 * transaction. Each changed source stroke remains as a tombstone; visible
 * replacement runs receive fresh IDs and are inserted at its stacking slot.
 * Image elements and other element types are intentionally left untouched.
 * Pass `createId` in tests or when the caller needs a deterministic ID source.
 */
export function eraseBoardAt(doc, { x, y, radius, createId = createElementId }) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('eraser center must have finite coordinates');
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new TypeError('eraser radius must be a positive finite number');
  }
  if (typeof createId !== 'function') throw new TypeError('createId must be a function');

  const { elements, order } = getBoardMaps(doc);
  const plans = [];
  const usedIds = new Set(elements.keys());
  const orderedIds = order.toArray();

  orderedIds.forEach((id, index) => {
    const source = elements.get(id);
    if (!(source instanceof Y.Map) || source.get('deleted') === true || source.get('type') !== 'path') return;
    const geometry = source.get('geometry');
    if (!geometry || !Array.isArray(geometry.points)) return;

    const runs = clipStrokePoints(geometry.points, { x, y }, radius);
    const unchanged = runs.length === 1
      && JSON.stringify(runs[0]) === JSON.stringify(geometry.points);
    if (unchanged) return;

    const styleMap = source.get('style');
    const dataMap = source.get('data');
    const style = styleMap instanceof Y.Map ? mapToObject(styleMap) : {};
    const data = dataMap instanceof Y.Map ? mapToObject(dataMap) : {};
    const segments = runs.map(points => {
      const segmentId = createId();
      if (typeof segmentId !== 'string' || segmentId.length === 0 || usedIds.has(segmentId)) {
        throw new Error(`Invalid or reused replacement element ID: ${segmentId}`);
      }
      usedIds.add(segmentId);
      return {
        id: segmentId,
        record: createElementRecord({
          type: 'path',
          geometry: { ...geometry, points },
          style,
          data,
        }),
      };
    });
    plans.push({ id, index, source, segments });
  });

  if (plans.length === 0) return { deletedIds: [], createdIds: [] };

  plans.sort((left, right) => right.index - left.index);
  const createdIds = plans.flatMap(plan => plan.segments.map(segment => segment.id));
  doc.transact(() => {
    for (const plan of plans) {
      plan.source.set('deleted', true);
      for (const segment of plan.segments) elements.set(segment.id, segment.record);
      if (plan.segments.length > 0) {
        order.insert(plan.index + 1, plan.segments.map(segment => segment.id));
      }
    }
  });

  return { deletedIds: plans.map(plan => plan.id), createdIds };
}
