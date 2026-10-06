import { createElementId } from '../shared/board-model.js';

const DATABASE_NAME = 'whiteboard-t3:pending-images';
const DATABASE_VERSION = 1;
const STORE_NAME = 'images';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

let databasePromise;
const listenersByBoard = new Map();
const versionsByBoard = new Map();

function requireBoardId(boardId) {
  if (typeof boardId !== 'string' || boardId.length === 0) throw new TypeError('boardId is required');
}

function requirePendingImage({ file, geometry, intrinsicWidth, intrinsicHeight }) {
  if (!(file instanceof Blob) || file.size === 0) throw new TypeError('A non-empty image Blob is required');
  if (file.size > MAX_IMAGE_BYTES) throw new RangeError('Image exceeds the 10 MiB local queue limit');
  if (!IMAGE_TYPES.has(file.type)) throw new TypeError('PNG, JPEG, GIF, or WebP is required');
  if (!(intrinsicWidth > 0) || !Number.isFinite(intrinsicWidth)
      || !(intrinsicHeight > 0) || !Number.isFinite(intrinsicHeight)) {
    throw new TypeError('Image dimensions must be positive');
  }
  if (!geometry || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(geometry[key]))
      || geometry.width <= 0 || geometry.height <= 0) {
    throw new TypeError('Image geometry must have finite position and positive size');
  }
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  const indexedDB = globalThis.indexedDB;
  if (!indexedDB?.open) throw new Error('IndexedDB is not available');
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'pendingId' });
        store.createIndex('boardId', 'boardId', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open pending image storage'));
    request.onblocked = () => reject(new Error('Pending image storage upgrade is blocked'));
  });
  databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('Pending image storage transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Pending image storage transaction failed'));
  });
}

async function getPendingRecords(boardId) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const done = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).index('boardId').getAll(boardId);
  const records = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read pending images'));
  });
  await done;
  return records.sort((left, right) => left.createdAt - right.createdAt || left.pendingId.localeCompare(right.pendingId));
}

async function putPendingRecord(record) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(record);
  await transactionComplete(transaction);
}

async function deletePendingRecord(pendingId) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).delete(pendingId);
  await transactionComplete(transaction);
}

async function notifyBoardListeners(boardId) {
  const version = (versionsByBoard.get(boardId) ?? 0) + 1;
  versionsByBoard.set(boardId, version);
  const listeners = listenersByBoard.get(boardId);
  if (!listeners?.size) return;
  const snapshot = await getPendingRecords(boardId);
  if (versionsByBoard.get(boardId) !== version) return;
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* observers cannot roll back a committed queue change */ }
  }
}

/** Persist one local image independently from the shared Y.Doc. */
export async function enqueuePendingBoardImage(boardId, {
  file,
  geometry,
  intrinsicWidth,
  intrinsicHeight,
  elementId = createElementId(),
  idFactory = createElementId,
}) {
  requireBoardId(boardId);
  requirePendingImage({ file, geometry, intrinsicWidth, intrinsicHeight });
  if (typeof elementId !== 'string' || elementId.length === 0) throw new TypeError('elementId is required');
  const pending = {
    pendingId: idFactory(),
    elementId,
    boardId,
    blob: file,
    mimeType: file.type,
    geometry: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
    intrinsicWidth,
    intrinsicHeight,
    createdAt: Date.now(),
    uploadedAsset: null,
  };
  if (typeof pending.pendingId !== 'string' || pending.pendingId.length === 0) throw new TypeError('pendingId is required');
  await putPendingRecord(pending);
  await notifyBoardListeners(boardId);
  return pending;
}

/** Return local pending image records, including their structured-cloned Blob. */
export async function listPendingBoardImages(boardId) {
  requireBoardId(boardId);
  return getPendingRecords(boardId);
}

/** Subscribe to full snapshots so Canvas preview state cannot drift incrementally. */
export async function subscribePendingBoardImages(boardId, listener) {
  requireBoardId(boardId);
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  if (!listenersByBoard.has(boardId)) listenersByBoard.set(boardId, new Set());
  const listeners = listenersByBoard.get(boardId);
  listeners.add(listener);
  const version = versionsByBoard.get(boardId) ?? 0;
  try {
    const snapshot = await getPendingRecords(boardId);
    if ((versionsByBoard.get(boardId) ?? 0) === version) listener(snapshot);
    else await notifyBoardListeners(boardId);
  } catch (error) {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByBoard.delete(boardId);
    throw error;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByBoard.delete(boardId);
  };
}

/**
 * Upload queued Blobs in order, then publish each reference through the caller.
 * Uploaded asset metadata stays local until the Y.Doc callback succeeds, making
 * retries after tab closure idempotent when the callback uses `elementId`.
 */
export async function publishPendingBoardImages(boardId, { upload, publish } = {}) {
  requireBoardId(boardId);
  if (typeof upload !== 'function' || typeof publish !== 'function') {
    throw new TypeError('upload and publish callbacks are required');
  }
  const published = [];
  for (const pending of await getPendingRecords(boardId)) {
    let asset = pending.uploadedAsset;
    if (!asset) {
      asset = await upload(pending);
      if (!asset?.assetId || asset.boardId !== boardId) throw new Error('The uploaded asset does not belong to this board');
      pending.uploadedAsset = asset;
      await putPendingRecord(pending);
    }
    await publish({ pending, asset });
    await deletePendingRecord(pending.pendingId);
    published.push({ pending, asset });
    await notifyBoardListeners(boardId);
  }
  return published;
}

/** Remove a pending record after its local preview or queued publication is canceled. */
export async function removePendingBoardImage(boardId, pendingId) {
  requireBoardId(boardId);
  if (typeof pendingId !== 'string' || pendingId.length === 0) throw new TypeError('pendingId is required');
  const pending = (await getPendingRecords(boardId)).find(record => record.pendingId === pendingId);
  if (!pending) return false;
  await deletePendingRecord(pendingId);
  await notifyBoardListeners(boardId);
  return true;
}

/** Only network/transient server failures are eligible for offline queuing. */
export function shouldQueuePendingImage(error) {
  const status = error?.status;
  if (status === undefined || status === null) return true;
  if ([400, 401, 403, 413, 415].includes(status)) return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
