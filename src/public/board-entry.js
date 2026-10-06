import * as Y from 'yjs';
import { addElement } from '../shared/board-model.js';
import { bindBoardCanvas } from './board-canvas.js';

/** Create one browser-owned document and seed the authorized server snapshot. */
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

/** Mount the current minimal Canvas tools around a shared board document. */
export function mountBoardCanvas({ canvas, toolbar, elements = [] }) {
  const doc = createBoardDocument(elements);
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
      doc.destroy();
    },
  };
}
