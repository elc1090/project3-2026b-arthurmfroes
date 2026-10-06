import * as Y from 'yjs';
import { addElement } from '../shared/board-model.js';
import { bindBoardCanvas } from './board-canvas.js';

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
  const binding = bindBoardCanvas({ doc, canvas, getTool: () => tool });
  return {
    doc,
    destroy() {
      binding.destroy();
      for (const [button, listener] of buttonListeners) button.removeEventListener('click', listener);
      if (ownsDoc) doc.destroy();
    },
  };
}
