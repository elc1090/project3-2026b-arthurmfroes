import { openBoardSession } from '../../src/client/board-session.js';
import {
  addElement,
  deleteElement,
  readBoardElements,
  setElementGeometry,
  setElementStyle,
} from '../../src/shared/board-model.js';

window.openBoardSession = openBoardSession;
window.boardTestModel = {
  addElement,
  deleteElement,
  readBoardElements,
  setElementGeometry,
  setElementStyle,
};
