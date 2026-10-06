import * as Y from 'yjs';
import {
  addElement,
  createElementId,
  deleteElement as tombstoneElement,
  eraseBoardAt,
  getBoardMaps,
  readBoardElements,
  readElement,
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
    this.destroyed = false;

    const { elements, order } = getBoardMaps(doc);
    this.undoManager = new Y.UndoManager([elements, order], {
      trackedOrigins: new Set([localOrigin]),
      captureTimeout: 500,
    });
    this.onStackItemAdded = ({ type, origin }) => {
      if (type !== 'undo' || origin !== this.localOrigin) return;
      this.redoEntries.length = 0;
      this.undoEntries.push({ kind: 'yjs' });
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
  }

  recordSemantic(entry, apply) {
    const changed = apply();
    if (!changed) return changed;
    this.undoManager.stopCapturing();
    this.undoManager.clear(false, true);
    this.redoEntries.length = 0;
    this.undoEntries.push({ kind: 'semantic', ...entry });
    this.notify();
    return changed;
  }

  deleteElement(id) {
    const element = readElement(this.doc, id);
    if (!element) return false;
    const index = getBoardMaps(this.doc).order.toArray().indexOf(id);
    let currentId = id;
    return this.recordSemantic({
      undo: () => transactSemantic(this.doc, () => {
        currentId = addAtOrderPosition(this.doc, element, index, this.createId);
      }),
      redo: () => transactSemantic(this.doc, () => tombstoneElement(this.doc, currentId)),
    }, () => transactSemantic(this.doc, () => tombstoneElement(this.doc, id)));
  }

  eraseAt({ x, y, radius }) {
    const before = readBoardElements(this.doc);
    const orderedIds = getBoardMaps(this.doc).order.toArray();
    let result;
    transactSemantic(this.doc, () => {
      result = eraseBoardAt(this.doc, { x, y, radius, createId: this.createId });
    });
    if (result.deletedIds.length === 0) return result;

    const originals = result.deletedIds.map(id => ({
      element: before.find(element => element.id === id),
      index: orderedIds.indexOf(id),
    })).filter(item => item.element);
    const after = readBoardElements(this.doc);
    const afterOrder = getBoardMaps(this.doc).order.toArray();
    const segments = result.createdIds.map(id => ({
      element: after.find(element => element.id === id),
      index: afterOrder.indexOf(id),
    })).filter(item => item.element);

    let currentOriginalIds = result.deletedIds;
    let currentSegmentIds = result.createdIds;
    this.undoManager.stopCapturing();
    this.undoManager.clear(false, true);
    this.redoEntries.length = 0;
    this.undoEntries.push({
      kind: 'semantic',
      undo: () => transactSemantic(this.doc, () => {
        for (const id of currentSegmentIds) tombstoneElement(this.doc, id);
        currentOriginalIds = restoreAtPositions(this.doc, originals, this.createId);
      }),
      redo: () => transactSemantic(this.doc, () => {
        for (const id of currentOriginalIds) tombstoneElement(this.doc, id);
        currentSegmentIds = restoreAtPositions(this.doc, segments, this.createId);
      }),
    });
    this.notify();
    return result;
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
