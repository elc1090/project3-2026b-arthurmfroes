import { addElement, createElementId } from '../shared/board-model.js';

export {
  enqueuePendingBoardImage,
  listPendingBoardImages,
  publishPendingBoardImages,
  removePendingBoardImage,
  shouldQueuePendingImage,
  subscribePendingBoardImages,
} from '../client/pending-board-images.js';

export function boardImageHref(boardId, assetId) {
  return `/api/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}`;
}

export async function uploadBoardImage(boardId, file, { fetchImpl = fetch } = {}) {
  if (typeof boardId !== 'string' || boardId.length === 0) throw new TypeError('boardId is required');
  if (!(file instanceof Blob) || file.size === 0) throw new TypeError('A non-empty image Blob is required');
  const response = await fetchImpl(`/api/boards/${encodeURIComponent(boardId)}/assets`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Não foi possível enviar a imagem.'), { status: response.status });
  if (!result.asset?.assetId || result.asset.boardId !== boardId) {
    throw new Error('O servidor retornou uma referência de imagem inválida.');
  }
  return result.asset;
}

export function addImageAssetReference(doc, { asset, geometry, intrinsicWidth, intrinsicHeight, idFactory = createElementId, origin }) {
  if (!asset?.assetId || !asset?.mimeType) throw new TypeError('An uploaded image asset is required');
  if (!(intrinsicWidth > 0) || !(intrinsicHeight > 0)) throw new TypeError('Image dimensions must be positive');
  const id = idFactory();
  const data = {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    width: intrinsicWidth,
    height: intrinsicHeight,
  };
  doc.transact(() => addElement(doc, { id, type: 'image', geometry, data }), origin);
  return id;
}

/** Upload first, then create the Yjs reference so peers never see missing bytes. */
export async function addUploadedImageToBoard({
  doc,
  boardId,
  file,
  geometry,
  intrinsicWidth,
  intrinsicHeight,
  fetchImpl = fetch,
  idFactory = createElementId,
  origin,
}) {
  const asset = await uploadBoardImage(boardId, file, { fetchImpl });
  const elementId = addImageAssetReference(doc, { asset, geometry, intrinsicWidth, intrinsicHeight, idFactory, origin });
  return { asset, elementId };
}

/** Return the decoded source dimensions and release its temporary bitmap. */
export async function readImageDimensions(blob, createBitmap = globalThis.createImageBitmap) {
  if (typeof createBitmap !== 'function') throw new Error('createImageBitmap is not available');
  const bitmap = await createBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

export function fileImageGeometry({ imageWidth, imageHeight, canvasWidth, centerX, centerY }) {
  requireDimensions(imageWidth, imageHeight);
  requireDimensions(canvasWidth, 1);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new TypeError('Image center is required');
  const maxDimension = Math.min(850, canvasWidth * 0.8);
  const scale = Math.min(1, maxDimension / Math.max(imageWidth, imageHeight));
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

export function templateImageGeometry({
  imageWidth,
  imageHeight,
  viewportWidth,
  viewportHeight,
  centerX,
  centerY,
  existingElements = [],
}) {
  requireDimensions(imageWidth, imageHeight);
  requireDimensions(viewportWidth, viewportHeight);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new TypeError('Viewport center is required');
  const maxWidth = Math.max(600, viewportWidth * 0.85);
  const maxHeight = Math.max(450, viewportHeight * 0.85);
  const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  const bounds = elementBounds(existingElements);
  if (bounds) return { x: Math.round(bounds.maxX + 80), y: Math.round(bounds.minY), width, height };
  return { x: Math.round(centerX - width / 2), y: Math.round(centerY - height / 2), width, height };
}

/** Fetches through the authenticated board endpoint and decodes for Canvas.drawImage. */
export async function loadBoardImageAsset(boardId, assetId, {
  fetchImpl = fetch,
  createBitmap = globalThis.createImageBitmap,
} = {}) {
  const response = await fetchImpl(boardImageHref(boardId, assetId), {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw Object.assign(new Error('Não foi possível carregar a imagem do quadro.'), { status: response.status });
  if (typeof createBitmap !== 'function') throw new Error('createImageBitmap is not available');
  return createBitmap(await response.blob());
}

function requireDimensions(width, height) {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new TypeError('Image and viewport dimensions must be positive');
  }
}

function elementBounds(elements) {
  const geometries = elements.map((element) => element.geometry)
    .filter((geometry) => geometry
      && Number.isFinite(geometry.x)
      && Number.isFinite(geometry.y)
      && geometry.width >= 0
      && geometry.height >= 0);
  if (geometries.length === 0) return null;
  return geometries.reduce((bounds, geometry) => ({
    minX: Math.min(bounds.minX, geometry.x),
    minY: Math.min(bounds.minY, geometry.y),
    maxX: Math.max(bounds.maxX, geometry.x + geometry.width),
    maxY: Math.max(bounds.maxY, geometry.y + geometry.height),
  }), {
    minX: geometries[0].x,
    minY: geometries[0].y,
    maxX: geometries[0].x + geometries[0].width,
    maxY: geometries[0].y + geometries[0].height,
  });
}
