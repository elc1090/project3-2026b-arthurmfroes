import { openBoardSession } from '../../src/client/board-session.js';
import { addElement, setElementStyle } from '../../src/shared/board-model.js';
import { mountBoardTimelineUI } from '../../src/public/board-timeline-ui.js';

window.openBoardSession = openBoardSession;
window.mountBoardTimelineUI = mountBoardTimelineUI;
window.addBoardElement = addElement;
window.setBoardElementStyle = setElementStyle;
