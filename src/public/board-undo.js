import * as Y from 'yjs';
import {
  addElement,
  createElementId,
  deleteElement as tombstoneElement,
  eraseBoardAt,
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

  eraseAt({ x, y, radius, points = [{ x, y }] }) {
    if (!Array.isArray(points) || points.length === 0) return { deletedIds: [], createdIds: [] };
    const before = readBoardElements(this.doc);
    const beforeOrder = getBoardMaps(this.doc).order.toArray();
    const beforeById = new Map(before.map(element => [element.id, element]));
    const origins = new Map(before.filter(element => element.type === 'path').map(element => [element.id, {
      sourceId: element.id,
      logicalId: this.logicalIdFor(element.id),
    }]));
    const logicalBySource = new Map([...origins.values()].map(origin => [origin.sourceId, origin.logicalId]));
    const touchedSources = new Set();
    const aggregate = { deletedIds: [], createdIds: [] };
    const samples = points.map(point => ({ x: point.x, y: point.y }));

    transactSemantic(this.doc, () => {
      for (const center of samples) {
        const orderedIds = getBoardMaps(this.doc).order.toArray();
        const plans = readBoardElements(this.doc)
          .filter(element => element.type === 'path' && Array.isArray(element.geometry?.points))
          .map(element => {
            const runs = clipStrokePoints(element.geometry.points, center, radius);
            const unchanged = runs.length === 1
              && JSON.stringify(runs[0]) === JSON.stringify(element.geometry.points);
            return unchanged ? null : { id: element.id, runCount: runs.length };
          })
          .filter(Boolean)
          .sort((left, right) => orderedIds.indexOf(right.id) - orderedIds.indexOf(left.id));
        if (plans.length === 0) continue;

        const result = eraseBoardAt(this.doc, { ...center, radius, createId: this.createId });
        aggregate.deletedIds.push(...result.deletedIds);
        aggregate.createdIds.push(...result.createdIds);
        let createdOffset = 0;
        for (let index = 0; index < result.deletedIds.length; index++) {
          const deletedId = result.deletedIds[index];
          const plan = plans[index];
          const origin = origins.get(deletedId) ?? {
            sourceId: deletedId,
            logicalId: this.logicalIdFor(deletedId),
          };
          origins.delete(deletedId);
          touchedSources.add(origin.sourceId);
          for (let run = 0; run < plan.runCount; run++) {
            const createdId = result.createdIds[createdOffset++];
            origins.set(createdId, origin);
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
        const logicalIds = new Set(currentOriginals.map(original => original.logicalId));
        for (const logicalId of logicalIds) {
          for (const physicalId of this.physicalIdsFor(logicalId)) tombstoneElement(this.doc, physicalId);
          this.setPhysicalIds(logicalId, []);
        }
        const segmentIds = restoreAtPositions(this.doc, currentSegments, this.createId);
        activeSegments = [...currentSegments].sort((left, right) => left.index - right.index)
          .map((snapshot, index) => ({ ...snapshot, element: { ...snapshot.element, id: segmentIds[index] } }));
        for (const logicalId of logicalIds) {
          this.setPhysicalIds(logicalId, activeSegments
            .filter(segment => segment.logicalId === logicalId)
            .map(segment => segment.element.id));
        }
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
