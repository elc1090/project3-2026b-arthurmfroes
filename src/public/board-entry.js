import * as Y from 'yjs';
import { addElement } from '../shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN } from './board-canvas.js';
import { LocalBoardHistory } from './board-undo.js';

/**
 * Temporary snapshot adapter for the current UI. A sync provider should instead
 * supply its restored board Y.Doc directly to `mountBoardCanvas`.
 */
export function createBoardDocument(elements = []) {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const element of elements) {
      addElement(doc, {
        id: element.id,
        type: element.type,
        geometry: element.geometry,
        style: element.style,
        data: element.data,
      });
    }
  }, 'authorized-board-snapshot');
  return doc;
}

/**
 * Mount the minimal tools around a board document. `doc` is borrowed when
 * supplied by IndexedDB or a sync provider, and remains owned by that caller.
 */
export function mountBoardCanvas({ canvas, toolbar, doc: suppliedDoc, elements = [] }) {
  const ownsDoc = !suppliedDoc;
  const doc = suppliedDoc ?? createBoardDocument(elements);
  let tool = 'select';
  const undoButtons = [...toolbar.querySelectorAll('[data-board-undo]')];
  const redoButtons = [...toolbar.querySelectorAll('[data-board-redo]')];
  let history;
  const refreshHistoryButtons = ({ canUndo, canRedo }) => {
    for (const button of undoButtons) button.disabled = !canUndo;
    for (const button of redoButtons) button.disabled = !canRedo;
  };
  history = new LocalBoardHistory(doc, {
    localOrigin: CANVAS_ORIGIN,
    onChange: refreshHistoryButtons,
  });
  const undoListeners = undoButtons.map(button => {
    const listener = () => history.undo();
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const redoListeners = redoButtons.map(button => {
    const listener = () => history.redo();
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const buttons = [...toolbar.querySelectorAll('[data-board-tool]')];
  const buttonListeners = [];
  for (const button of buttons) {
    const onClick = () => {
      tool = button.dataset.boardTool;
      for (const candidate of buttons) {
        candidate.setAttribute('aria-pressed', String(candidate === button));
      }
    };
    button.addEventListener('click', onClick);
    buttonListeners.push([button, onClick]);
  }
  const binding = bindBoardCanvas({
    doc,
    canvas,
    getTool: () => tool,
    getLogicalId: id => history.logicalIdFor(id),
    beforeLocalAction: action => history.beginLocalAction(action),
    afterLocalAction: () => history.stopCapturing(),
    deleteElement: id => history.deleteElement(id),
    eraseAt: options => history.eraseAt(options),
  });
  refreshHistoryButtons({ canUndo: history.canUndo, canRedo: history.canRedo });
  return {
    doc,
    history,
    destroy() {
      binding.destroy();
      for (const [button, listener] of buttonListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of undoListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of redoListeners) button.removeEventListener('click', listener);
      history.destroy();
      if (ownsDoc) doc.destroy();
    },
  };
}
