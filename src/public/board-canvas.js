import {
  addElement,
  createElementId,
  readBoardElements,
  setElementGeometry,
} from '../shared/board-model.js';

export const CANVAS_ORIGIN = Symbol('canvas-local-action');

function defaultDraw(context, element) {
  if (element.type !== 'rect') return;
  const { x, y, width, height } = element.geometry;
  context.fillStyle = element.style.fill ?? 'transparent';
  context.strokeStyle = element.style.color ?? '#0f172a';
  context.lineWidth = element.style.strokeWidth ?? 2;
  if (element.style.fill) context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);
}

function contains(element, point) {
  if (element.type !== 'rect') return false;
  const { x, y, width, height } = element.geometry;
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}

function pointFromEvent(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  const scaleX = bounds.width ? canvas.width / bounds.width : 1;
  const scaleY = bounds.height ? canvas.height / bounds.height : 1;
  return {
    x: (event.clientX - bounds.left) * scaleX,
    y: (event.clientY - bounds.top) * scaleY,
  };
}

/**
 * Bind a 2D Canvas to one board Y.Doc. A completed pointer gesture writes one
 * model transaction with `CANVAS_ORIGIN`; all transactions render from the
 * model, and rendering itself never writes back to Yjs. Tools and drawing are
 * injectable so later Canvas tools can share the same guarded binding.
 */
export function bindBoardCanvas({
  doc,
  canvas,
  getTool = () => 'select',
  getStyle = () => ({ color: '#0f172a', strokeWidth: 2 }),
  idFactory = createElementId,
  drawElement = defaultDraw,
  afterLocalAction = () => {},
}) {
  if (!doc || !canvas?.getContext || !canvas?.addEventListener) {
    throw new TypeError('A Y.Doc and an event-capable Canvas are required');
  }
  const context = canvas.getContext('2d');
  let gesture = null;
  let destroyed = false;

  function render() {
    if (destroyed) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const element of readBoardElements(doc)) drawElement(context, element);
  }

  function onTransaction(transaction) {
    if (transaction.changed.size > 0) render();
  }

  function onPointerDown(event) {
    const point = pointFromEvent(canvas, event);
    if (getTool() === 'rectangle') {
      gesture = { kind: 'create', start: point };
    } else {
      const selected = [...readBoardElements(doc)].reverse().find(element => contains(element, point));
      gesture = selected ? { kind: 'move', id: selected.id, start: point } : null;
    }
    if (gesture) canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerUp(event) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    const end = pointFromEvent(canvas, event);
    if (active.kind === 'create') {
      const geometry = {
        x: Math.min(active.start.x, end.x),
        y: Math.min(active.start.y, end.y),
        width: Math.abs(end.x - active.start.x),
        height: Math.abs(end.y - active.start.y),
      };
      if (geometry.width === 0 || geometry.height === 0) return;
      const style = getStyle();
      doc.transact(() => addElement(doc, {
        id: idFactory(), type: 'rect', geometry, style,
      }), CANVAS_ORIGIN);
      afterLocalAction();
      return;
    }

    const element = readBoardElements(doc).find(item => item.id === active.id);
    if (!element) return;
    const dx = end.x - active.start.x;
    const dy = end.y - active.start.y;
    if (dx === 0 && dy === 0) return;
    doc.transact(() => setElementGeometry(doc, active.id, {
      ...element.geometry,
      x: element.geometry.x + dx,
      y: element.geometry.y + dy,
    }), CANVAS_ORIGIN);
    afterLocalAction();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  doc.on('afterTransaction', onTransaction);
  render();

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      doc.off('afterTransaction', onTransaction);
    },
  };
}
