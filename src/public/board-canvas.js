import {
  addElement,
  createElementId,
  getBoardMaps,
  readBoardElements,
  setElementGeometry,
} from '../shared/board-model.js';
import { loadBoardImageAsset } from './board-images.js';

export const CANVAS_ORIGIN = Symbol('canvas-local-action');

function defaultDraw(context, element) {
  context.strokeStyle = element.style.color ?? '#0f172a';
  context.lineWidth = element.style.strokeWidth ?? 2;
  if (element.type === 'rect') {
    const { x, y, width, height } = element.geometry;
    context.fillStyle = element.style.fill ?? 'transparent';
    if (element.style.fill) context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
  } else if (element.type === 'path' && element.geometry.points.length > 1) {
    context.beginPath();
    context.moveTo(element.geometry.points[0].x, element.geometry.points[0].y);
    for (const point of element.geometry.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function contains(element, point) {
  if (element.type === 'rect') {
    const { x, y, width, height } = element.geometry;
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }
  if (element.type === 'path' && element.geometry.points.length > 1) {
    return element.geometry.points.slice(1).some((end, index) => (
      distanceToSegment(point, element.geometry.points[index], end) <= 8
    ));
  }
  return false;
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
  deleteElement = () => {},
  eraseAt = () => {},
  getLogicalId = id => id,
  beforeLocalAction = () => {},
  afterLocalAction = () => {},
  boardId,
  loadImage = loadBoardImageAsset,
  onImageError = () => {},
}) {
  if (!doc || !canvas?.getContext || !canvas?.addEventListener) {
    throw new TypeError('A Y.Doc and an event-capable Canvas are required');
  }
  const context = canvas.getContext('2d');
  let gesture = null;
  let destroyed = false;
  const imageCache = new Map();

  function requestImage(assetId) {
    if (!boardId || imageCache.has(assetId)) return;
    const entry = { bitmap: null, promise: null };
    imageCache.set(assetId, entry);
    entry.promise = Promise.resolve().then(() => loadImage(boardId, assetId)).then((bitmap) => {
      if (destroyed || imageCache.get(assetId) !== entry) {
        bitmap.close?.();
        return;
      }
      entry.bitmap = bitmap;
      render();
    }).catch((error) => {
      if (imageCache.get(assetId) === entry) imageCache.delete(assetId);
      if (!destroyed) onImageError(error, assetId);
    });
  }

  function render() {
    if (destroyed) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const elements = readBoardElements(doc);
    const activeAssets = new Set(elements.filter(element => element.type === 'image').map(element => element.data.assetId));
    for (const [assetId, entry] of imageCache) {
      if (activeAssets.has(assetId)) continue;
      entry.bitmap?.close?.();
      imageCache.delete(assetId);
    }
    for (const element of elements) {
      if (element.type !== 'image') {
        drawElement(context, element);
        continue;
      }
      const entry = imageCache.get(element.data.assetId);
      if (entry?.bitmap) {
        const { x, y, width, height } = element.geometry;
        context.drawImage(entry.bitmap, x, y, width, height);
      } else {
        requestImage(element.data.assetId);
      }
    }
  }

  function onTransaction(transaction) {
    if (transaction.changed.size > 0) render();
  }

  function onPointerDown(event) {
    const point = pointFromEvent(canvas, event);
    const tool = getTool();
    if (tool === 'rectangle') {
      gesture = { kind: 'create', start: point };
    } else if (tool === 'eraser') {
      gesture = { kind: 'erase', points: [point] };
    } else {
      const selected = [...readBoardElements(doc)].reverse().find(element => contains(element, point));
      gesture = selected ? {
        kind: tool === 'delete' ? 'delete' : 'move',
        id: selected.id,
        start: point,
      } : null;
    }
    if (gesture) canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (gesture?.kind !== 'erase') return;
    const point = pointFromEvent(canvas, event);
    const previous = gesture.points[gesture.points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) gesture.points.push(point);
  }

  function onPointerCancel() {
    gesture = null;
  }

  function onPointerUp(event) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    const end = pointFromEvent(canvas, event);
    if (active.kind === 'delete') {
      deleteElement(active.id);
      return;
    }
    if (active.kind === 'erase') {
      const previous = active.points[active.points.length - 1];
      if (Math.hypot(end.x - previous.x, end.y - previous.y) >= 2) active.points.push(end);
      eraseAt({ points: active.points, radius: 12 });
      return;
    }
    if (active.kind === 'create') {
      const geometry = {
        x: Math.min(active.start.x, end.x),
        y: Math.min(active.start.y, end.y),
        width: Math.abs(end.x - active.start.x),
        height: Math.abs(end.y - active.start.y),
      };
      if (geometry.width === 0 || geometry.height === 0) return;
      const style = getStyle();
      const id = idFactory();
      const action = {
        kind: 'create', logicalId: id, index: getBoardMaps(doc).order.length,
        element: { id, type: 'rect', geometry, style, data: {} },
      };
      beforeLocalAction(action);
      doc.transact(() => addElement(doc, {
        id, type: 'rect', geometry, style,
      }), CANVAS_ORIGIN);
      afterLocalAction();
      return;
    }

    const element = readBoardElements(doc).find(item => item.id === active.id);
    if (!element) return;
    const dx = end.x - active.start.x;
    const dy = end.y - active.start.y;
    if (dx === 0 && dy === 0) return;
    const action = {
      kind: 'move', logicalId: getLogicalId(active.id), physicalId: active.id,
      delta: { x: dx, y: dy },
    };
    beforeLocalAction(action);
    doc.transact(() => setElementGeometry(doc, active.id, {
      ...element.geometry,
      x: element.geometry.x + dx,
      y: element.geometry.y + dy,
    }), CANVAS_ORIGIN);
    afterLocalAction();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  doc.on('afterTransaction', onTransaction);
  render();

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      doc.off('afterTransaction', onTransaction);
      for (const entry of imageCache.values()) entry.bitmap?.close?.();
      imageCache.clear();
    },
  };
}
