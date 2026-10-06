import * as Y from 'yjs';
import {
  addElement,
  createElementId,
  deleteElement as tombstoneElement,
  clipStrokePoints,
  getBoardMaps,
  readBoardElements,
  readElement,
  setElementGeometry,
} from '../shared/board-model.js';

export const SEMANTIC_UNDO_ORIGIN = Symbol('board-semantic-undo');

function transactSemantic(doc, callback) {
  let result;
  doc.transact(() => { result = callback(); }, SEMANTIC_UNDO_ORIGIN);
  return result;
}

function addAtOrderPosition(doc, element, index, createId) {
  const id = createId();
  const { order } = getBoardMaps(doc);
  addElement(doc, { ...element, id });
  const appendedIndex = order.length - 1;
  const targetIndex = Math.max(0, Math.min(index, appendedIndex));
  if (targetIndex !== appendedIndex) {
    order.delete(appendedIndex, 1);
    order.insert(targetIndex, [id]);
  }
  return id;
}

function restoreAtPositions(doc, snapshots, createId) {
  return [...snapshots]
    .sort((left, right) => left.index - right.index)
    .map(({ element, index }) => addAtOrderPosition(doc, element, index, createId));
}

function translateGeometry(geometry, dx, dy) {
  const translated = { ...geometry };
  if (Number.isFinite(geometry.x)) translated.x += dx;
  if (Number.isFinite(geometry.y)) translated.y += dy;
  if (Array.isArray(geometry.points)) {
    translated.points = geometry.points.map(point => ({
      ...point,
      x: point.x + dx,
      y: point.y + dy,
    }));
  }
  return translated;
}

function boundsForElement(element) {
  const geometry = element.geometry;
  if (element.type === 'image' || element.type === 'rect' || element.type === 'mux' || element.type === 'alu') {
    if ([geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) {
      return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    }
    if ([geometry.x1, geometry.y1, geometry.x2, geometry.y2].every(Number.isFinite)) {
      return {
        x: Math.min(geometry.x1, geometry.x2), y: Math.min(geometry.y1, geometry.y2),
        width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1),
      };
    }
  }
  if (element.type === 'text' && Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    const fontSize = (element.style.strokeWidth ?? 2) * 4 + 11;
    return {
      x: geometry.x, y: geometry.y,
      width: (element.data.text ?? '').length * fontSize * 0.6,
      height: fontSize * 1.3,
    };
  }
  return null;
}

function clipLineOrArrow(element, center, radius) {
  const { x1, y1, x2, y2 } = element.geometry;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const original = { type: element.type, geometry: element.geometry };
  if (lengthSquared < 1e-9) {
    return Math.hypot(x1 - center.x, y1 - center.y) < radius ? [] : null;
  }

  const fx = x1 - center.x;
  const fy = y1 - center.y;
  const b = 2 * (dx * fx + dy * fy);
  const c = fx * fx + fy * fy - radius * radius;
  const discriminant = b * b - 4 * lengthSquared * c;
  if (discriminant <= 0) return null;

  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * lengthSquared);
  const second = (-b + root) / (2 * lengthSquared);
  const insideStart = Math.max(0, first);
  const insideEnd = Math.min(1, second);
  if (insideStart >= insideEnd) return null;

  const hasStart = first > 1e-6;
  const hasEnd = second < 1 - 1e-6;
  const pointAt = t => ({ x: x1 + t * dx, y: y1 + t * dy });
  const entry = pointAt(first);
  const exit = pointAt(second);
  const segment = (type, start, end) => ({
    type,
    geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
  });

  if (hasStart && hasEnd) {
    if (element.type === 'arrow') {
      return [segment('line', { x: x1, y: y1 }, entry), segment('arrow', exit, { x: x2, y: y2 })];
    }
    return [segment(element.type, { x: x1, y: y1 }, entry), segment(element.type, exit, { x: x2, y: y2 })];
  }
  if (hasStart) return [segment(element.type === 'arrow' ? 'line' : element.type, { x: x1, y: y1 }, entry)];
  if (hasEnd) return [segment(element.type, exit, { x: x2, y: y2 })];
  return [original];
}

/** Return null for untouched items; otherwise return their visible replacements. */
function clippedElements(element, center, radius) {
  if (element.type === 'path' && Array.isArray(element.geometry.points)) {
    const runs = clipStrokePoints(element.geometry.points, center, radius);
    const unchanged = runs.length === 1
      && JSON.stringify(runs[0]) === JSON.stringify(element.geometry.points);
    return unchanged ? null : runs.map(points => ({
      type: 'path', geometry: { ...element.geometry, points },
    }));
  }
  if (element.type === 'line' || element.type === 'arrow') {
    const clipped = clipLineOrArrow(element, center, radius);
    if (clipped === null) return null;
    if (clipped.length === 1
      && clipped[0].type === element.type
      && JSON.stringify(clipped[0].geometry) === JSON.stringify(element.geometry)) return null;
    return clipped;
  }
  if (element.type === 'rect' || element.type === 'mux' || element.type === 'alu' || element.type === 'text') {
    const bounds = boundsForElement(element);
    return bounds
      && center.x >= bounds.x && center.x <= bounds.x + bounds.width
      && center.y >= bounds.y && center.y <= bounds.y + bounds.height
      ? []
      : null;
  }
  return null;
}

function eraserSamples(points, radius) {
  const samples = [{ x: points[0].x, y: points[0].y }];
  const step = Math.max(4, radius * 0.4);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let sample = 1; sample <= count; sample++) {
      const ratio = sample / count;
      samples.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
    }
  }
  return samples;
}

function sameElementContent(left, right) {
  return left.type === right.type
    && JSON.stringify(left.geometry) === JSON.stringify(right.geometry)
    && JSON.stringify(left.style) === JSON.stringify(right.style)
    && JSON.stringify(left.data) === JSON.stringify(right.data);
}

/**
 * Keep one local action order across Y.UndoManager changes and semantic
 * tombstone operations. Only transactions tagged with `localOrigin` enter the
 * Yjs manager; semantic undo uses fresh IDs so deleted records stay terminal.
 */
export class LocalBoardHistory {
  constructor(doc, { localOrigin, createId = createElementId, onChange = () => {} }) {
    if (!doc || !localOrigin) throw new TypeError('doc and localOrigin are required');
    this.doc = doc;
    this.localOrigin = localOrigin;
    this.createId = createId;
    this.onChange = onChange;
    this.undoEntries = [];
    this.redoEntries = [];
    this.aliases = new Map();
    this.pendingAction = null;
    this.semanticMode = false;
    this.destroyed = false;

    const { elements, order } = getBoardMaps(doc);
    this.undoManager = new Y.UndoManager([elements, order], {
      trackedOrigins: new Set([localOrigin]),
      captureTimeout: 500,
    });
    this.onStackItemAdded = ({ type, origin }) => {
      if (type !== 'undo' || origin !== this.localOrigin) return;
      const action = this.pendingAction;
      this.pendingAction = null;
      this.redoEntries.length = 0;
      if (this.semanticMode && action) {
        const entry = this.createSemanticEntry(action);
        this.undoManager.clear(true, true);
        this.undoEntries.push(entry);
      } else {
        this.undoEntries.push({ kind: 'yjs', action });
      }
      this.notify();
    };
    this.undoManager.on('stack-item-added', this.onStackItemAdded);
  }

  get canUndo() { return this.undoEntries.length > 0; }
  get canRedo() { return this.redoEntries.length > 0; }

  notify() {
    this.onChange({ canUndo: this.canUndo, canRedo: this.canRedo });
  }

  stopCapturing() {
    this.undoManager.stopCapturing();
    this.pendingAction = null;
  }

  beginLocalAction(action) {
    this.pendingAction = action;
  }

  logicalIdFor(physicalId) {
    for (const [logicalId, physicalIds] of this.aliases) {
      if (physicalIds.includes(physicalId)) return logicalId;
    }
    return physicalId;
  }

  physicalIdsFor(logicalId) {
    if (this.aliases.has(logicalId)) return [...this.aliases.get(logicalId)];
    try {
      return readElement(this.doc, logicalId) ? [logicalId] : [];
    } catch {
      return [];
    }
  }

  setPhysicalIds(logicalId, physicalIds) {
    const order = getBoardMaps(this.doc).order.toArray();
    const visible = new Set(readBoardElements(this.doc).map(element => element.id));
    this.aliases.set(logicalId, [...new Set(physicalIds)]
      .filter(id => visible.has(id))
      .sort((left, right) => order.indexOf(left) - order.indexOf(right)));
  }

  replacePhysicalIds(logicalId, removedIds, addedIds) {
    const removed = new Set(removedIds);
    const current = this.physicalIdsFor(logicalId).filter(id => !removed.has(id));
    this.setPhysicalIds(logicalId, [...current, ...addedIds]);
  }

  enterSemanticMode() {
    if (this.semanticMode) return;
    const converted = this.undoEntries.map(entry => {
      if (entry.kind !== 'yjs') return entry;
      if (!entry.action) throw new Error('Local Canvas action is missing semantic undo metadata');
      return this.createSemanticEntry(entry.action);
    });
    this.undoEntries = converted;
    this.redoEntries = [];
    this.semanticMode = true;
    this.undoManager.clear(true, true);
  }

  createSemanticEntry(action) {
    if (action.kind === 'create') {
      const logicalId = action.logicalId;
      return {
        kind: 'semantic',
        undo: () => transactSemantic(this.doc, () => {
          for (const id of this.physicalIdsFor(logicalId)) tombstoneElement(this.doc, id);
          this.setPhysicalIds(logicalId, []);
        }),
        redo: () => transactSemantic(this.doc, () => {
          const id = addAtOrderPosition(this.doc, action.element, action.index, this.createId);
          this.setPhysicalIds(logicalId, [id]);
        }),
      };
    }
    if (action.kind === 'move') {
      return {
        kind: 'semantic',
        undo: () => this.translateLogical(action.logicalId, -action.delta.x, -action.delta.y),
        redo: () => this.translateLogical(action.logicalId, action.delta.x, action.delta.y),
      };
    }
    throw new Error(`Unsupported local undo action: ${action.kind}`);
  }

  translateLogical(logicalId, dx, dy) {
    transactSemantic(this.doc, () => {
      for (const id of this.physicalIdsFor(logicalId)) {
        const element = readElement(this.doc, id);
        if (element) setElementGeometry(this.doc, id, translateGeometry(element.geometry, dx, dy));
      }
    });
  }

  recordSemantic(entry, apply) {
    const changed = apply();
    if (!changed) return changed;
    this.enterSemanticMode();
    this.undoManager.stopCapturing();
    this.redoEntries.length = 0;
    this.undoEntries.push({ kind: 'semantic', ...entry });
    this.notify();
    return changed;
  }

  deleteElement(id) {
    const element = readElement(this.doc, id);
    if (!element) return false;
    const index = getBoardMaps(this.doc).order.toArray().indexOf(id);
    const logicalId = this.logicalIdFor(id);
    return this.recordSemantic({
      undo: () => transactSemantic(this.doc, () => {
        const restoredId = addAtOrderPosition(this.doc, element, index, this.createId);
        this.replacePhysicalIds(logicalId, [id], [restoredId]);
      }),
      redo: () => transactSemantic(this.doc, () => {
        const currentIds = this.physicalIdsFor(logicalId);
        for (const currentId of currentIds) tombstoneElement(this.doc, currentId);
        this.setPhysicalIds(logicalId, []);
      }),
    }, () => transactSemantic(this.doc, () => {
      const deleted = tombstoneElement(this.doc, id);
      this.replacePhysicalIds(logicalId, [id], []);
      return deleted;
    }));
  }

  clearElements() {
    const order = getBoardMaps(this.doc).order.toArray();
    const snapshots = readBoardElements(this.doc).map(element => ({
      logicalId: this.logicalIdFor(element.id),
      element,
      index: order.indexOf(element.id),
    }));
    if (snapshots.length === 0) return 0;
    const logicalIds = new Set(snapshots.map(item => item.logicalId));
    let restoredSnapshots = [];
    return this.recordSemantic({
      undo: () => transactSemantic(this.doc, () => {
        const ids = restoreAtPositions(this.doc, snapshots, this.createId);
        restoredSnapshots = [...snapshots].sort((left, right) => left.index - right.index)
          .map((snapshot, index) => ({ ...snapshot, element: { ...snapshot.element, id: ids[index] } }));
        for (const logicalId of logicalIds) {
          this.setPhysicalIds(logicalId, restoredSnapshots
            .filter(item => item.logicalId === logicalId)
            .map(item => item.element.id));
        }
      }),
      redo: () => transactSemantic(this.doc, () => {
        for (const item of restoredSnapshots) tombstoneElement(this.doc, item.element.id);
        for (const logicalId of logicalIds) this.setPhysicalIds(logicalId, []);
      }),
    }, () => transactSemantic(this.doc, () => {
      for (const item of snapshots) tombstoneElement(this.doc, item.element.id);
      for (const logicalId of logicalIds) this.setPhysicalIds(logicalId, []);
      return snapshots.length;
    }));
  }

  eraseAt({ x, y, radius, points = [{ x, y }] }) {
    if (!Array.isArray(points) || points.length === 0) return { deletedIds: [], createdIds: [] };
    const before = readBoardElements(this.doc);
    const beforeOrder = getBoardMaps(this.doc).order.toArray();
    const beforeById = new Map(before.map(element => [element.id, element]));
    const erasableTypes = new Set(['path', 'line', 'arrow', 'rect', 'mux', 'alu', 'text']);
    const origins = new Map(before.filter(element => erasableTypes.has(element.type)).map(element => [element.id, {
      sourceId: element.id,
      logicalId: this.logicalIdFor(element.id),
    }]));
    const logicalBySource = new Map([...origins.values()].map(origin => [origin.sourceId, origin.logicalId]));
    const touchedSources = new Set();
    const aggregate = { deletedIds: [], createdIds: [] };
    const samples = eraserSamples(points, radius);

    transactSemantic(this.doc, () => {
      for (const center of samples) {
        const orderedIds = getBoardMaps(this.doc).order.toArray();
        const plans = readBoardElements(this.doc)
          .map(element => {
            const replacements = clippedElements(element, center, radius);
            return replacements === null ? null : { element, replacements };
          })
          .filter(Boolean)
          .sort((left, right) => orderedIds.indexOf(right.element.id) - orderedIds.indexOf(left.element.id));
        if (plans.length === 0) continue;

        for (const plan of plans) {
          const sourceId = plan.element.id;
          const origin = origins.get(sourceId) ?? {
            sourceId,
            logicalId: this.logicalIdFor(sourceId),
          };
          const sourceIndex = orderedIds.indexOf(sourceId);
          tombstoneElement(this.doc, sourceId);
          origins.delete(sourceId);
          aggregate.deletedIds.push(sourceId);
          touchedSources.add(origin.sourceId);
          plan.replacements.forEach((replacement, index) => {
            const id = addAtOrderPosition(this.doc, {
              ...plan.element,
              ...replacement,
              style: plan.element.style,
              data: plan.element.data,
            }, sourceIndex + 1 + index, this.createId);
            aggregate.createdIds.push(id);
            origins.set(id, origin);
          });
          const logicalIds = new Set([origin.logicalId]);
          for (const logicalId of logicalIds) {
            const visible = readBoardElements(this.doc)
              .filter(element => origins.get(element.id)?.logicalId === logicalId || this.logicalIdFor(element.id) === logicalId)
              .map(element => element.id);
            this.setPhysicalIds(logicalId, visible);
          }
        }
      }
    });

    if (aggregate.deletedIds.length === 0) return aggregate;
    const touchedOriginals = [...touchedSources].map(sourceId => ({
      sourceId,
      logicalId: logicalBySource.get(sourceId) ?? this.logicalIdFor(sourceId),
      element: beforeById.get(sourceId),
      index: beforeOrder.indexOf(sourceId),
    })).filter(item => item.element);
    const touchedSet = new Set(touchedSources);
    const currentSegments = readBoardElements(this.doc).flatMap(element => {
      const origin = origins.get(element.id);
      if (!origin || !touchedSet.has(origin.sourceId)) return [];
      return [{
        sourceId: origin.sourceId,
        logicalId: logicalBySource.get(origin.sourceId) ?? origin.logicalId,
        element,
        index: getBoardMaps(this.doc).order.toArray().indexOf(element.id),
      }];
    });
    const logicalIds = new Set(touchedOriginals.map(item => item.logicalId));
    for (const logicalId of logicalIds) {
      const visible = readBoardElements(this.doc)
        .filter(element => this.logicalIdFor(element.id) === logicalId || origins.get(element.id)?.logicalId === logicalId)
        .map(element => element.id);
      this.setPhysicalIds(logicalId, visible);
    }

    let currentOriginals = [];
    let activeSegments = currentSegments;
    const resolveCurrentOriginals = () => {
      const visible = readBoardElements(this.doc);
      const claimed = new Set();
      return currentOriginals.flatMap(snapshot => {
        const candidates = this.physicalIdsFor(snapshot.logicalId)
          .filter(id => !claimed.has(id))
          .map(id => visible.find(element => element.id === id))
          .filter(element => element && sameElementContent(element, snapshot.element));
        const order = getBoardMaps(this.doc).order.toArray();
        candidates.sort((left, right) => (
          Math.abs(order.indexOf(left.id) - snapshot.index)
          - Math.abs(order.indexOf(right.id) - snapshot.index)
        ));
        const element = candidates[0];
        if (!element) return [];
        claimed.add(element.id);
        return [{ ...snapshot, element }];
      });
    };
    const replaceByLogical = (removed, added) => {
      const logicals = new Set([...removed, ...added].map(item => item.logicalId));
      for (const logicalId of logicals) {
        this.replacePhysicalIds(
          logicalId,
          removed.filter(item => item.logicalId === logicalId).map(item => item.element.id),
          added.filter(item => item.logicalId === logicalId).map(item => item.element.id),
        );
      }
    };
    const entry = {
      kind: 'semantic',
      undo: () => transactSemantic(this.doc, () => {
        for (const segment of activeSegments) tombstoneElement(this.doc, segment.element.id);
        const restoredIds = restoreAtPositions(this.doc, touchedOriginals, this.createId);
        currentOriginals = [...touchedOriginals].sort((left, right) => left.index - right.index)
          .map((snapshot, index) => ({ ...snapshot, element: { ...snapshot.element, id: restoredIds[index] } }));
        replaceByLogical(activeSegments, currentOriginals);
      }),
      redo: () => transactSemantic(this.doc, () => {
        const originalsToReplace = resolveCurrentOriginals();
        for (const original of originalsToReplace) tombstoneElement(this.doc, original.element.id);
        replaceByLogical(originalsToReplace, []);
        const segmentIds = restoreAtPositions(this.doc, currentSegments, this.createId);
        activeSegments = [...currentSegments].sort((left, right) => left.index - right.index)
          .map((snapshot, index) => ({ ...snapshot, element: { ...snapshot.element, id: segmentIds[index] } }));
        replaceByLogical([], activeSegments);
      }),
    };
    this.enterSemanticMode();
    this.undoManager.stopCapturing();
    this.redoEntries.length = 0;
    this.undoEntries.push(entry);
    this.notify();
    return aggregate;
  }

  undo() {
    const entry = this.undoEntries.pop();
    if (!entry) return false;
    try {
      if (entry.kind === 'yjs') {
        if (!this.undoManager.undo()) {
          this.undoEntries.push(entry);
          return false;
        }
      } else {
        entry.undo();
      }
      this.redoEntries.push(entry);
      this.notify();
      return true;
    } catch (error) {
      this.undoEntries.push(entry);
      throw error;
    }
  }

  redo() {
    const entry = this.redoEntries.pop();
    if (!entry) return false;
    try {
      if (entry.kind === 'yjs') {
        if (!this.undoManager.redo()) {
          this.redoEntries.push(entry);
          return false;
        }
      } else {
        entry.redo();
      }
      this.undoEntries.push(entry);
      this.notify();
      return true;
    } catch (error) {
      this.redoEntries.push(entry);
      throw error;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.undoManager.off('stack-item-added', this.onStackItemAdded);
    this.undoManager.destroy();
  }
}
