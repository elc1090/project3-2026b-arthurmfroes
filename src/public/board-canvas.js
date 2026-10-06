import {
  addElement,
  createElementId,
  getBoardMaps,
  readBoardElements,
  setElementGeometry,
} from '../shared/board-model.js';
import { loadBoardImageAsset } from './board-images.js';

export const CANVAS_ORIGIN = Symbol('canvas-local-action');

const TOOL_TO_TYPE = { rectangle: 'rect', rect: 'rect', mux: 'mux', alu: 'alu', line: 'line', arrow: 'arrow' };
const ERASER_RADIUS_BY_SIZE = new Map([[2, 12], [4, 22], [8, 38], [16, 65]]);
const REMOTE_PREVIEW_TOOLS = new Set(['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'rect', 'mux', 'alu']);
const MAX_REMOTE_POINTS = 256;
const MAX_REMOTE_COORDINATE = 10_000_000;

function isSafePresenceColor(value) {
  return typeof value === 'string' && /^#[\da-f]{3,8}$/i.test(value);
}

function normalizeRemotePoint(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || Math.abs(value.x) > MAX_REMOTE_COORDINATE || Math.abs(value.y) > MAX_REMOTE_COORDINATE) return null;
  return { x: value.x, y: value.y };
}

function limitPreviewPoints(points) {
  if (points.length <= MAX_REMOTE_POINTS) return points.map(point => ({ ...point }));
  const last = points.length - 1;
  return Array.from({ length: MAX_REMOTE_POINTS }, (_, index) => ({
    ...points[Math.round(index * last / (MAX_REMOTE_POINTS - 1))],
  }));
}

function shapeBounds(geometry, minWidth = 0, minHeight = 0) {
  if ([geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) {
    return {
      x: geometry.x, y: geometry.y,
      width: Math.max(minWidth, geometry.width), height: Math.max(minHeight, geometry.height),
    };
  }
  if ([geometry.x1, geometry.y1, geometry.x2, geometry.y2].every(Number.isFinite)) {
    return {
      x: Math.min(geometry.x1, geometry.x2), y: Math.min(geometry.y1, geometry.y2),
      width: Math.max(minWidth, Math.abs(geometry.x2 - geometry.x1)),
      height: Math.max(minHeight, Math.abs(geometry.y2 - geometry.y1)),
    };
  }
  return null;
}

function elementBounds(element) {
  const { geometry, style, data } = element;
  if (element.type === 'image' || element.type === 'rect') return shapeBounds(geometry);
  if (element.type === 'mux') return shapeBounds(geometry, 30, 50);
  if (element.type === 'alu') return shapeBounds(geometry, 50, 60);
  if (element.type === 'text' && Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    const fontSize = (style.strokeWidth ?? 2) * 4 + 11;
    return { x: geometry.x, y: geometry.y, width: (data.text ?? '').length * fontSize * 0.6, height: fontSize * 1.3 };
  }
  if (element.type === 'path' && Array.isArray(geometry.points) && geometry.points.length > 0) {
    const xs = geometry.points.map(point => point.x);
    const ys = geometry.points.map(point => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if ((element.type === 'line' || element.type === 'arrow') && Number.isFinite(geometry.x1)) {
    return {
      x: Math.min(geometry.x1, geometry.x2), y: Math.min(geometry.y1, geometry.y2),
      width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1),
    };
  }
  return null;
}

function boardElementsBounds(elements) {
  const bounds = elements.map(elementBounds).filter(Boolean);
  if (bounds.length === 0) return null;
  const minX = Math.min(...bounds.map(item => item.x));
  const minY = Math.min(...bounds.map(item => item.y));
  const maxX = Math.max(...bounds.map(item => item.x + item.width));
  const maxY = Math.max(...bounds.map(item => item.y + item.height));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/** Render durable Yjs elements to an export canvas, excluding local pending previews. */
export async function renderBoardSnapshot(doc, boardId, {
  loadImage = loadBoardImageAsset,
  documentRef = globalThis.document,
  padding = 50,
  minWidth = 1200,
  minHeight = 800,
  gridSize = 30,
} = {}) {
  const elements = readBoardElements(doc);
  const bounds = boardElementsBounds(elements) ?? { minX: 0, minY: 0, width: 800, height: 480 };
  const width = Math.max(minWidth, Math.ceil(bounds.width + padding * 2));
  const height = Math.max(minHeight, Math.ceil(bounds.height + padding * 2));
  const canvas = documentRef.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível criar o Canvas de exportação.');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(226, 232, 240, 0.6)';
  context.lineWidth = 1;
  for (let x = 0; x < width; x += gridSize) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  const imageBitmaps = new Map();
  try {
    const assetIds = [...new Set(elements.filter(element => element.type === 'image').map(element => element.data.assetId))];
    for (const assetId of assetIds) imageBitmaps.set(assetId, await loadImage(boardId, assetId));
    context.save();
    context.translate(-bounds.minX + padding, -bounds.minY + padding);
    for (const element of elements) {
      if (element.type === 'image') {
        const bitmap = imageBitmaps.get(element.data.assetId);
        const { x, y, width: imageWidth, height: imageHeight } = element.geometry;
        context.drawImage(bitmap, x, y, imageWidth, imageHeight);
      } else {
        defaultDraw(context, element);
      }
    }
    context.restore();
    return canvas;
  } finally {
    for (const bitmap of imageBitmaps.values()) bitmap.close?.();
  }
}

function translateGeometry(geometry, dx, dy) {
  const result = { ...geometry };
  for (const key of ['x', 'x1', 'x2']) if (Number.isFinite(geometry[key])) result[key] += dx;
  for (const key of ['y', 'y1', 'y2']) if (Number.isFinite(geometry[key])) result[key] += dy;
  if (Array.isArray(geometry.points)) {
    result.points = geometry.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy }));
  }
  return result;
}

function drawArrow(context, geometry) {
  const angle = Math.atan2(geometry.y2 - geometry.y1, geometry.x2 - geometry.x1);
  const headLength = Math.max(10, context.lineWidth * 3.5);
  context.beginPath();
  context.moveTo(geometry.x2, geometry.y2);
  context.lineTo(
    geometry.x2 - headLength * Math.cos(angle - Math.PI / 6),
    geometry.y2 - headLength * Math.sin(angle - Math.PI / 6),
  );
  context.lineTo(
    geometry.x2 - headLength * Math.cos(angle + Math.PI / 6),
    geometry.y2 - headLength * Math.sin(angle + Math.PI / 6),
  );
  context.closePath();
  context.fill();
}

function defaultDraw(context, element) {
  const { style = {}, data = {}, geometry } = element;
  context.save();
  context.strokeStyle = style.color ?? '#1e293b';
  context.fillStyle = style.color ?? '#1e293b';
  context.lineWidth = style.strokeWidth ?? 2;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (element.type === 'path' && Array.isArray(geometry.points) && geometry.points.length > 1) {
    context.beginPath();
    if (style.tool === 'highlighter') {
      context.globalAlpha = 0.35;
      context.lineWidth *= 2.8;
    }
    context.moveTo(geometry.points[0].x, geometry.points[0].y);
    for (const point of geometry.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  } else if (element.type === 'line' || element.type === 'arrow') {
    context.beginPath();
    context.moveTo(geometry.x1, geometry.y1);
    context.lineTo(geometry.x2, geometry.y2);
    context.stroke();
    if (element.type === 'arrow') drawArrow(context, geometry);
  } else if (element.type === 'rect') {
    const bounds = shapeBounds(geometry);
    if (bounds) {
      context.fillStyle = 'rgba(255, 255, 255, 0.7)';
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
  } else if (element.type === 'mux') {
    const { x, y, width, height } = shapeBounds(geometry, 30, 50);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + width, y + height * 0.15);
    context.lineTo(x + width, y + height * 0.85);
    context.lineTo(x, y + height);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = style.color ?? '#1e293b';
    context.font = 'bold 11px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('MUX', x + width / 2, y + height / 2);
  } else if (element.type === 'alu') {
    const { x, y, width, height } = shapeBounds(geometry, 50, 60);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + width, y + height * 0.35);
    context.lineTo(x + width, y + height * 0.65);
    context.lineTo(x, y + height);
    context.lineTo(x, y + height * 0.60);
    context.lineTo(x + width * 0.25, y + height * 0.50);
    context.lineTo(x, y + height * 0.40);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = style.color ?? '#1e293b';
    context.font = 'bold 11px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('ULA / ALU', x + width * 0.45, y + height / 2);
  } else if (element.type === 'text') {
    const fontSize = (style.strokeWidth ?? 2) * 4 + 11;
    context.fillStyle = style.color ?? '#1e293b';
    context.font = `${fontSize}px 'Fira Code', monospace`;
    context.textBaseline = 'top';
    context.fillText(data.text ?? '', geometry.x, geometry.y);
  }
  context.restore();
}

function screenPoint(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  const scaleX = bounds.width ? canvas.width / bounds.width : 1;
  const scaleY = bounds.height ? canvas.height / bounds.height : 1;
  return { x: (event.clientX - bounds.left) * scaleX, y: (event.clientY - bounds.top) * scaleY };
}

function contains(element, point) {
  // Match the copied product: only image, block, MUX, ALU, and text have selection hitboxes.
  if (!['image', 'rect', 'mux', 'alu', 'text'].includes(element.type)) return false;
  const bounds = elementBounds(element);
  return bounds
    && point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function createElement(tool, id, start, end, points, style) {
  const colorAndSize = { color: style.color, strokeWidth: style.strokeWidth };
  if (tool === 'pen' || tool === 'highlighter') {
    if (points.length === 1) points.push({ x: points[0].x + 0.1, y: points[0].y + 0.1 });
    return { id, type: 'path', geometry: { points }, style: { ...colorAndSize, tool }, data: {} };
  }
  if (tool === 'line' || tool === 'arrow') {
    return { id, type: tool, geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y }, style: colorAndSize, data: {} };
  }
  const type = TOOL_TO_TYPE[tool];
  if (!type) return null;
  const bounds = {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
  };
  if (type === 'mux') {
    bounds.width = Math.max(30, bounds.width);
    bounds.height = Math.max(50, bounds.height);
  } else if (type === 'alu') {
    bounds.width = Math.max(50, bounds.width);
    bounds.height = Math.max(60, bounds.height);
  }
  return { id, type, geometry: bounds, style: colorAndSize, data: {} };
}

function createPendingBitmap(blob) {
  if (typeof globalThis.createImageBitmap !== 'function') {
    return Promise.reject(new Error('createImageBitmap is not available for the local image preview'));
  }
  return globalThis.createImageBitmap(blob);
}

export function bindBoardCanvas({
  doc,
  canvas,
  getTool = () => 'select',
  getStyle = () => ({ color: '#1e293b', strokeWidth: 2 }),
  idFactory = createElementId,
  drawElement = defaultDraw,
  deleteElement = () => {},
  eraseAt = () => {},
  getLogicalId = id => id,
  beforeLocalAction = () => {},
  afterLocalAction = () => {},
  onLocalCursor = () => {},
  onLocalPreview = () => {},
  boardId,
  loadImage = loadBoardImageAsset,
  loadPendingImage = createPendingBitmap,
  onImageError = () => {},
}) {
  if (!doc || !canvas?.getContext || !canvas?.addEventListener) {
    throw new TypeError('A Y.Doc and an event-capable Canvas are required');
  }
  const context = canvas.getContext('2d');
  let gesture = null;
  let selectedId = null;
  let spacePressed = false;
  let destroyed = false;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let eraserCursor = null;
  let pendingImages = [];
  const imageCache = new Map();
  const pendingImageCache = new Map();
  const remotePeers = new Map();
  let directPeerCount = 0;

  function updatePeerPresence(type, detail) {
    if (!detail || (boardId && detail.boardId !== boardId)
      || !Number.isSafeInteger(detail.clientId) || detail.clientId < 0) return;
    const peer = remotePeers.get(detail.clientId) ?? { displayName: null, color: null, cursor: null, preview: null };
    if (type === 'peer-presence') {
      if (detail.removed) {
        peer.displayName = null;
        peer.color = null;
      } else {
        peer.displayName = typeof detail.displayName === 'string' ? detail.displayName.slice(0, 64) : null;
        peer.color = isSafePresenceColor(detail.color) ? detail.color : null;
      }
    } else if (type === 'peer-cursor') {
      peer.cursor = detail.removed ? null : normalizeRemotePoint(detail);
    } else if (type === 'peer-stroke-preview') {
      if (detail.removed) {
        peer.preview = null;
      } else if (detail.kind === 'move'
        && typeof detail.elementId === 'string' && detail.elementId.length > 0 && detail.elementId.length <= 128
        && Number.isFinite(detail.dx) && Math.abs(detail.dx) <= MAX_REMOTE_COORDINATE
        && Number.isFinite(detail.dy) && Math.abs(detail.dy) <= MAX_REMOTE_COORDINATE) {
        peer.preview = { kind: 'move', elementId: detail.elementId, dx: detail.dx, dy: detail.dy };
      } else {
        const points = Array.isArray(detail.points) && detail.points.length <= MAX_REMOTE_POINTS
          ? Array.from(detail.points, normalizeRemotePoint)
          : [];
        if ((detail.kind === undefined || detail.kind === 'draw')
          && REMOTE_PREVIEW_TOOLS.has(detail.tool)
          && points.length > 0 && points.every(Boolean)) {
          peer.preview = {
            kind: 'draw',
            tool: detail.tool,
            points,
            color: isSafePresenceColor(detail.color) ? detail.color : peer.color ?? '#1e293b',
            strokeWidth: Number.isFinite(detail.strokeWidth) ? Math.max(1, Math.min(64, detail.strokeWidth)) : 2,
          };
        } else {
          peer.preview = null;
        }
      }
    }
    if (!peer.displayName && !peer.cursor && !peer.preview) remotePeers.delete(detail.clientId);
    else remotePeers.set(detail.clientId, peer);
    render();
  }

  function setDirectPeerCount(value) {
    directPeerCount = Number.isSafeInteger(value) && value > 0 ? value : 0;
    if (directPeerCount === 0) remotePeers.clear();
    render();
  }

  function clearLocalTransientState() {
    onLocalCursor(null);
    onLocalPreview(null);
  }

  function toBoardPoint(event) {
    const point = screenPoint(canvas, event);
    return { x: (point.x - panX) / zoom, y: (point.y - panY) / zoom };
  }

  function requestImage(assetId) {
    if (!boardId || imageCache.has(assetId)) return;
    const entry = { bitmap: null };
    imageCache.set(assetId, entry);
    Promise.resolve().then(() => loadImage(boardId, assetId)).then(bitmap => {
      if (destroyed || imageCache.get(assetId) !== entry) {
        bitmap.close?.();
        return;
      }
      entry.bitmap = bitmap;
      render();
    }).catch(error => {
      if (imageCache.get(assetId) === entry) imageCache.delete(assetId);
      if (!destroyed) onImageError(error, assetId);
    });
  }

  function syncPendingImages(snapshot) {
    pendingImages = Array.isArray(snapshot) ? snapshot : [];
    const active = new Set(pendingImages.map(item => item.pendingId ?? item.elementId));
    for (const [id, entry] of pendingImageCache) {
      if (active.has(id)) continue;
      entry.bitmap?.close?.();
      pendingImageCache.delete(id);
    }
    for (const item of pendingImages) {
      const id = item.pendingId ?? item.elementId;
      if (pendingImageCache.has(id)) continue;
      const entry = { bitmap: null };
      pendingImageCache.set(id, entry);
      Promise.resolve().then(() => loadPendingImage(item.blob)).then(bitmap => {
        if (destroyed || pendingImageCache.get(id) !== entry) {
          bitmap.close?.();
          return;
        }
        entry.bitmap = bitmap;
        render();
      }).catch(error => {
        if (pendingImageCache.get(id) === entry) pendingImageCache.delete(id);
        if (!destroyed) onImageError(error, id);
      });
    }
    render();
  }

  function drawSelection(element) {
    const bounds = elementBounds(element);
    if (!bounds) return;
    context.save();
    context.strokeStyle = '#3b82f6';
    context.lineWidth = 1.5;
    context.setLineDash?.([4, 4]);
    context.strokeRect(bounds.x - 4, bounds.y - 4, bounds.width + 8, bounds.height + 8);
    context.restore();
  }

  function drawEraserCursor() {
    if (!eraserCursor || getTool() !== 'eraser') return;
    const radius = ERASER_RADIUS_BY_SIZE.get(getStyle().strokeWidth) ?? 12;
    context.save();
    context.beginPath();
    context.strokeStyle = '#334155';
    context.lineWidth = 1 / zoom;
    context.arc(eraserCursor.x, eraserCursor.y, radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  function getBoardBounds() {
    const elements = readBoardElements(doc);
    return boardElementsBounds(elements);
  }

  function drawRemotePreview(peer, visibleById) {
    const preview = peer.preview;
    if (!preview) return;
    if (preview.kind === 'move') {
      const element = visibleById.get(preview.elementId);
      if (!element) return;
      const moved = { ...element, geometry: translateGeometry(element.geometry, preview.dx, preview.dy) };
      const bounds = elementBounds(moved);
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        || Math.abs(bounds.x) > MAX_REMOTE_COORDINATE || Math.abs(bounds.y) > MAX_REMOTE_COORDINATE
        || bounds.width > MAX_REMOTE_COORDINATE || bounds.height > MAX_REMOTE_COORDINATE) return;
      context.save();
      context.globalAlpha = 0.3;
      if (moved.type === 'image') {
        const bitmap = imageCache.get(moved.data.assetId)?.bitmap;
        if (bitmap) {
          const { x, y, width, height } = moved.geometry;
          context.drawImage(bitmap, x, y, width, height);
        } else {
          context.fillStyle = peer.color ?? '#2563eb';
          context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        }
      } else {
        drawElement(context, moved);
      }
      context.globalAlpha = 0.9;
      context.strokeStyle = peer.color ?? '#2563eb';
      context.lineWidth = 2 / zoom;
      context.setLineDash?.([6 / zoom, 4 / zoom]);
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      context.restore();
      return;
    }

    const [start] = preview.points;
    const end = preview.points.at(-1);
    const style = { color: preview.color, strokeWidth: preview.strokeWidth };
    const element = createElement(preview.tool, 'remote-preview', start, end, [...preview.points], style);
    if (!element) return;
    context.save();
    context.globalAlpha = 0.48;
    drawElement(context, element);
    context.restore();
  }

  function drawRemoteCursor(peer) {
    if (!peer.cursor) return;
    const color = peer.color ?? '#2563eb';
    const name = peer.displayName || 'Membro';
    context.save();
    context.translate(peer.cursor.x, peer.cursor.y);
    context.scale(1 / zoom, 1 / zoom);
    context.fillStyle = color;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, 17);
    context.lineTo(4.5, 13);
    context.lineTo(8, 21);
    context.lineTo(11.5, 19.5);
    context.lineTo(8, 12);
    context.lineTo(14, 12);
    context.closePath();
    context.fill();
    context.stroke();
    const labelX = 13;
    const labelY = 18;
    const labelWidth = Math.min(180, name.length * 7 + 12);
    context.globalAlpha = 0.92;
    context.fillStyle = color;
    context.fillRect(labelX, labelY, labelWidth, 21);
    context.globalAlpha = 1;
    context.fillStyle = '#ffffff';
    context.font = '12px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(name.slice(0, 64), labelX + 6, labelY + 10.5, labelWidth - 12);
    context.restore();
  }

  function render() {
    if (destroyed) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(panX, panY);
    context.scale(zoom, zoom);
    const elements = readBoardElements(doc);
    const visibleById = new Map(elements.map(element => [element.id, element]));
    const activeAssets = new Set(elements.filter(element => element.type === 'image').map(element => element.data.assetId));
    for (const [assetId, entry] of imageCache) {
      if (activeAssets.has(assetId)) continue;
      entry.bitmap?.close?.();
      imageCache.delete(assetId);
    }
    for (const element of elements) {
      const moving = gesture?.kind === 'move' && gesture.id === element.id;
      const visual = moving ? { ...element, geometry: translateGeometry(element.geometry, gesture.dx, gesture.dy) } : element;
      if (element.type === 'image') {
        const bitmap = imageCache.get(element.data.assetId)?.bitmap;
        if (bitmap) {
          const { x, y, width, height } = visual.geometry;
          context.drawImage(bitmap, x, y, width, height);
        } else requestImage(element.data.assetId);
      } else {
        drawElement(context, visual);
      }
      if (element.id === selectedId) drawSelection(visual);
    }
    const elementIds = new Set(elements.map(element => element.id));
    for (const item of pendingImages) {
      if (elementIds.has(item.elementId)) continue;
      const bitmap = pendingImageCache.get(item.pendingId ?? item.elementId)?.bitmap;
      if (bitmap) {
        const { x, y, width, height } = item.geometry;
        context.drawImage(bitmap, x, y, width, height);
      }
    }
    if (gesture?.kind === 'draw' && gesture.preview) drawElement(context, gesture.preview);
    if (gesture?.kind === 'move') {
      const moved = visibleById.get(gesture.id);
      if (moved) drawSelection({ ...moved, geometry: translateGeometry(moved.geometry, gesture.dx, gesture.dy) });
    }
    for (const peer of remotePeers.values()) drawRemotePreview(peer, visibleById);
    for (const peer of remotePeers.values()) drawRemoteCursor(peer);
    drawEraserCursor();
    context.restore();
  }

  function openTextEditor(event, point) {
    const document = canvas.ownerDocument ?? globalThis.document;
    if (!document?.createElement) return;
    document.getElementById('board-canvas-text-input')?.remove();
    const input = document.createElement('textarea');
    const style = getStyle();
    input.id = 'board-canvas-text-input';
    input.setAttribute('aria-label', 'Texto do quadro');
    input.style.position = 'fixed';
    input.style.left = `${event.clientX}px`;
    input.style.top = `${event.clientY}px`;
    input.style.minWidth = '180px';
    input.style.minHeight = '36px';
    input.style.padding = '4px 8px';
    input.style.zIndex = '35';
    input.style.fontFamily = "'Fira Code', monospace";
    input.style.fontSize = `${style.strokeWidth * 4 + 14}px`;
    input.style.color = style.color;
    input.placeholder = 'Digite seu cálculo ou sinal...';
    document.body.appendChild(input);
    input.focus();
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      input.remove();
    };
    const commit = () => {
      if (settled) return;
      settled = true;
      const text = input.value.trim();
      if (text) {
        const id = idFactory();
        const element = {
          id, type: 'text', geometry: { x: point.x, y: point.y },
          style: { color: style.color, strokeWidth: style.strokeWidth }, data: { text },
        };
        beforeLocalAction({ kind: 'create', logicalId: id, index: getBoardMaps(doc).order.length, element });
        doc.transact(() => addElement(doc, element), CANVAS_ORIGIN);
        afterLocalAction();
      }
      input.remove();
    };
    input.addEventListener('keydown', keyEvent => {
      if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
        keyEvent.preventDefault();
        commit();
      } else if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);
  }

  function publishDrawPreview(active) {
    const points = active.tool === 'pen' || active.tool === 'highlighter'
      ? limitPreviewPoints(active.points)
      : [active.start, active.end];
    onLocalPreview({
      kind: 'draw',
      tool: active.tool,
      points,
      color: active.style.color,
      strokeWidth: active.style.strokeWidth,
    });
  }

  function onPointerDown(event) {
    const screen = screenPoint(canvas, event);
    const point = { x: (screen.x - panX) / zoom, y: (screen.y - panY) / zoom };
    const tool = getTool();
    if (spacePressed || event.button === 1 || tool === 'pan') {
      gesture = { kind: 'pan', screen };
    } else if (tool === 'text') {
      event.preventDefault?.();
      openTextEditor(event, point);
      return;
    } else if (tool === 'eraser') {
      gesture = { kind: 'erase', points: [point] };
      eraserCursor = point;
    } else if (tool === 'select' || tool === 'delete') {
      const selected = [...readBoardElements(doc)].reverse().find(element => contains(element, point));
      selectedId = selected?.id ?? null;
      gesture = selected ? {
        kind: tool === 'delete' ? 'delete' : 'move', id: selected.id, start: point, dx: 0, dy: 0,
      } : null;
    } else {
      const style = getStyle();
      gesture = {
        kind: 'draw', tool, start: point, end: point, points: [point], style,
        preview: createElement(tool, 'preview', point, point, [{ ...point }], style),
      };
    }
    onLocalCursor(point);
    if (gesture?.kind === 'draw') publishDrawPreview(gesture);
    if (gesture) canvas.setPointerCapture?.(event.pointerId);
    render();
  }

  function onPointerMove(event) {
    onLocalCursor(toBoardPoint(event));
    if (!gesture) {
      if (getTool() === 'eraser') {
        eraserCursor = toBoardPoint(event);
        render();
      }
      return;
    }
    if (gesture.kind === 'pan') {
      const screen = screenPoint(canvas, event);
      panX += screen.x - gesture.screen.x;
      panY += screen.y - gesture.screen.y;
      gesture.screen = screen;
      onLocalCursor(toBoardPoint(event));
      render();
      return;
    }
    const point = toBoardPoint(event);
    if (gesture.kind === 'erase') {
      const coalesced = event.getCoalescedEvents?.() ?? [event];
      for (const sample of coalesced) {
        const next = toBoardPoint(sample);
        const previous = gesture.points[gesture.points.length - 1];
        if (Math.hypot(next.x - previous.x, next.y - previous.y) >= 2) gesture.points.push(next);
      }
      eraserCursor = point;
    } else if (gesture.kind === 'move') {
      gesture.dx = point.x - gesture.start.x;
      gesture.dy = point.y - gesture.start.y;
      onLocalPreview({ kind: 'move', elementId: gesture.id, dx: gesture.dx, dy: gesture.dy });
    } else if (gesture.kind === 'draw') {
      gesture.end = point;
      if (gesture.tool === 'pen' || gesture.tool === 'highlighter') {
        const coalesced = event.getCoalescedEvents?.() ?? [event];
        for (const sample of coalesced) gesture.points.push(toBoardPoint(sample));
      }
      gesture.preview = createElement(gesture.tool, 'preview', gesture.start, gesture.end, [...gesture.points], gesture.style);
      publishDrawPreview(gesture);
    }
    render();
  }

  function onPointerUp(event) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    canvas.releasePointerCapture?.(event.pointerId);
    clearLocalTransientState();
    render();
    if (active.kind === 'pan') return;
    if (active.kind === 'delete') {
      deleteElement(active.id);
      return;
    }
    if (active.kind === 'erase') {
      const end = toBoardPoint(event);
      const last = active.points[active.points.length - 1];
      if (Math.hypot(end.x - last.x, end.y - last.y) >= 2) active.points.push(end);
      const strokeWidth = getStyle().strokeWidth;
      eraseAt({ points: active.points, radius: ERASER_RADIUS_BY_SIZE.get(strokeWidth) ?? 12 });
      return;
    }
    if (active.kind === 'move') {
      const end = toBoardPoint(event);
      active.dx = end.x - active.start.x;
      active.dy = end.y - active.start.y;
      if (active.dx === 0 && active.dy === 0) return;
      const element = readBoardElements(doc).find(item => item.id === active.id);
      if (!element) return;
      beforeLocalAction({
        kind: 'move', logicalId: getLogicalId(active.id), physicalId: active.id,
        delta: { x: active.dx, y: active.dy },
      });
      doc.transact(() => setElementGeometry(doc, active.id, translateGeometry(element.geometry, active.dx, active.dy)), CANVAS_ORIGIN);
      afterLocalAction();
      return;
    }
    if (active.kind === 'draw') {
      const end = toBoardPoint(event);
      if (active.tool !== 'pen' && active.tool !== 'highlighter'
        && Math.hypot(end.x - active.start.x, end.y - active.start.y) < 3) return;
      if (active.tool === 'pen' || active.tool === 'highlighter') {
        const last = active.points[active.points.length - 1];
        if (Math.hypot(end.x - last.x, end.y - last.y) > 0.05) active.points.push(end);
      }
      const id = idFactory();
      const element = createElement(active.tool, id, active.start, end, active.points, active.style);
      if (!element) return;
      beforeLocalAction({ kind: 'create', logicalId: id, index: getBoardMaps(doc).order.length, element });
      doc.transact(() => addElement(doc, element), CANVAS_ORIGIN);
      afterLocalAction();
    }
  }

  function onPointerCancel(event) {
    if (gesture) canvas.releasePointerCapture?.(event.pointerId);
    gesture = null;
    clearLocalTransientState();
    render();
  }

  function onPointerLeave() {
    clearLocalTransientState();
  }

  function applyZoom(factor) {
    const oldZoom = zoom;
    const newZoom = Math.max(0.15, Math.min(5, oldZoom * factor));
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    panX = centerX - (centerX - panX) * (newZoom / oldZoom);
    panY = centerY - (centerY - panY) * (newZoom / oldZoom);
    zoom = newZoom;
    render();
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    render();
  }

  function fitToScreen() {
    const bounds = getBoardBounds();
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      resetZoom();
      return;
    }
    const padding = 50;
    const availableWidth = Math.max(100, canvas.width - padding * 2);
    const availableHeight = Math.max(100, canvas.height - padding * 2);
    zoom = Math.max(0.15, Math.min(3, availableWidth / bounds.width, availableHeight / bounds.height, 1.25));
    const centerX = bounds.minX + bounds.width / 2;
    const centerY = bounds.minY + bounds.height / 2;
    panX = canvas.width / 2 - centerX * zoom;
    panY = canvas.height / 2 - centerY * zoom;
    render();
  }

  function deleteSelected() {
    if (!selectedId) return false;
    const id = selectedId;
    selectedId = null;
    deleteElement(id);
    render();
    return true;
  }

  function onTransaction(transaction) {
    if (transaction.changed.size > 0) render();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  doc.on('afterTransaction', onTransaction);
  render();

  function onWheel(event) {
    event.preventDefault?.();
    const point = screenPoint(canvas, event);
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(0.15, Math.min(5, zoom * factor));
    panX = point.x - (point.x - panX) * (newZoom / zoom);
    panY = point.y - (point.y - panY) * (newZoom / zoom);
    zoom = newZoom;
    render();
  }

  return {
    render,
    setPendingImages: syncPendingImages,
    updatePeerPresence,
    setDirectPeerCount,
    clearRemotePresence() {
      remotePeers.clear();
      render();
    },
    clientToBoardPoint(clientX, clientY) {
      const point = screenPoint(canvas, { clientX, clientY });
      return { x: (point.x - panX) / zoom, y: (point.y - panY) / zoom };
    },
    setSpacePressed(value) { spacePressed = Boolean(value); },
    deleteSelected,
    zoomIn() { applyZoom(1.2); },
    zoomOut() { applyZoom(1 / 1.2); },
    resetZoom,
    fitToScreen,
    getViewport() { return { zoom, panX, panY }; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      doc.off('afterTransaction', onTransaction);
      clearLocalTransientState();
      remotePeers.clear();
      for (const entry of imageCache.values()) entry.bitmap?.close?.();
      imageCache.clear();
      for (const entry of pendingImageCache.values()) entry.bitmap?.close?.();
      pendingImageCache.clear();
    },
  };
}
