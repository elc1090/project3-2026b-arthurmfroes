import * as Y from 'yjs';
import { addElement, createElementId, getBoardMaps, readBoardElements, readElement } from '../shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN, renderBoardSnapshot } from './board-canvas.js';
import { LocalBoardHistory } from './board-undo.js';
import {
  addImageAssetReference,
  enqueuePendingBoardImage,
  fileImageGeometry,
  publishPendingBoardImages,
  readImageDimensions,
  shouldQueuePendingImage,
  subscribePendingBoardImages,
  templateImageGeometry,
  uploadBoardImage,
} from './board-images.js';

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
const PRESENCE_COLORS = ['#2563eb', '#c026d3', '#ea580c', '#0891b2', '#16a34a', '#7c3aed'];

function presenceColorFor(displayName, requestedColor) {
  if (typeof requestedColor === 'string' && /^#[\da-f]{3,8}$/i.test(requestedColor)) return requestedColor;
  const value = String(displayName ?? '');
  const hash = [...value].reduce((sum, character) => ((sum * 31) + character.codePointAt(0)) >>> 0, 7);
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

export function mountBoardCanvas({
  boardId,
  canvas,
  toolbar,
  doc: suppliedDoc,
  elements = [],
  onSaveBoardImage = () => {},
  boardSession,
  displayName,
  presenceColor,
}) {
  const ownsDoc = !suppliedDoc;
  const doc = suppliedDoc ?? createBoardDocument(elements);
  let tool = 'select';
  let color = '#1e293b';
  let strokeWidth = 2;
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
  let directPeerCount = 0;
  let updateConnectionStatus = () => {};
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
  const colorButtons = [...toolbar.querySelectorAll('[data-board-color]')];
  const sizeButtons = [...toolbar.querySelectorAll('[data-board-size]')];
  const colorListeners = colorButtons.map(button => {
    const listener = () => {
      color = button.dataset.boardColor;
      for (const candidate of colorButtons) candidate.setAttribute('aria-pressed', String(candidate === button));
    };
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const sizeListeners = sizeButtons.map(button => {
    const listener = () => {
      strokeWidth = Number(button.dataset.boardSize);
      for (const candidate of sizeButtons) candidate.setAttribute('aria-pressed', String(candidate === button));
    };
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const actionButtons = [...toolbar.querySelectorAll('[data-board-action]')];
  const imagePicker = toolbar.querySelector?.('[data-board-image-picker]');
  const imageButton = toolbar.querySelector?.('[data-board-image-add]');
  const templateButton = toolbar.querySelector?.('[data-board-template-add]');
  const imageStatus = toolbar.querySelector?.('[data-board-image-status]');
  const binding = bindBoardCanvas({
    doc,
    canvas,
    boardId,
    onImageError: error => {
      if (imageStatus) imageStatus.textContent = error.status === 403
        ? 'Você não tem mais acesso a uma imagem deste quadro.'
        : 'Não foi possível carregar uma imagem do quadro.';
    },
    getTool: () => tool,
    getStyle: () => ({ color, strokeWidth }),
    getLogicalId: id => history.logicalIdFor(id),
    beforeLocalAction: action => history.beginLocalAction(action),
    afterLocalAction: () => history.stopCapturing(),
    onLocalCursor: point => {
      const peerCount = Number.isSafeInteger(boardSession?.p2pPeerCount) ? boardSession.p2pPeerCount : directPeerCount;
      if (point === null || peerCount > 0) boardSession?.setLocalCursor(point);
      else boardSession?.setLocalCursor(null);
      updateConnectionStatus(boardSession?.p2pStatus);
    },
    onLocalPreview: preview => {
      const peerCount = Number.isSafeInteger(boardSession?.p2pPeerCount) ? boardSession.p2pPeerCount : directPeerCount;
      if (preview === null || peerCount > 0) boardSession?.setStrokePreview(preview);
      else boardSession?.setStrokePreview(null);
      updateConnectionStatus(boardSession?.p2pStatus);
    },
    deleteElement: id => history.deleteElement(id),
    eraseAt: options => history.eraseAt(options),
  });
  const presenceListeners = [];
  const presenceStatus = boardSession && canvas.ownerDocument?.createElement
    ? canvas.ownerDocument.createElement('div')
    : null;
  if (presenceStatus) {
    presenceStatus.dataset.boardPresenceStatus = '';
    presenceStatus.setAttribute('role', 'status');
    presenceStatus.setAttribute('aria-live', 'polite');
    presenceStatus.style.cssText = 'flex-basis:100%;margin:0;color:#475569;font-size:.85rem';
    presenceStatus.textContent = 'Conectando pares P2P…';
    toolbar.append(presenceStatus);
  }
  if (boardSession) {
    const name = typeof displayName === 'string' ? displayName.trim().slice(0, 64) : '';
    const colorForPresence = presenceColorFor(name, presenceColor);
    if (name) boardSession.setLocalPresence({ displayName: name, color: colorForPresence });
    for (const type of ['peer-presence', 'peer-cursor', 'peer-stroke-preview']) {
      presenceListeners.push(boardSession.on(type, detail => {
        binding.updatePeerPresence(type, detail);
        updateConnectionStatus(boardSession.p2pStatus);
      }));
    }
    updateConnectionStatus = status => {
      const liveCount = Number.isSafeInteger(boardSession.p2pPeerCount) ? boardSession.p2pPeerCount : status?.peerCount;
      const count = Number.isSafeInteger(liveCount) && liveCount > 0 ? liveCount : 0;
      directPeerCount = count;
      binding.setDirectPeerCount(count);
      if (count === 0) {
        boardSession.setLocalCursor(null);
        boardSession.setStrokePreview(null);
      }
      if (!presenceStatus) return;
      presenceStatus.textContent = count === 0
        ? 'Sem conexões diretas P2P'
        : `${count} ${count === 1 ? 'conexão direta' : 'conexões diretas'} P2P`;
    };
    presenceListeners.push(boardSession.on('p2p-status', updateConnectionStatus));
    presenceListeners.push(boardSession.on('membership-revoked', () => binding.clearRemotePresence()));
    presenceListeners.push(boardSession.on('session-expired', () => binding.clearRemotePresence()));
    updateConnectionStatus(boardSession.p2pStatus);
  }
  const imageControls = [imagePicker, imageButton, templateButton].filter(Boolean);
  for (const control of imageControls) control.disabled = !boardId;

  let disposed = false;
  let pendingUnsubscribe;
  let drainingPending = false;
  const publishPending = async ({ pending, asset }) => {
    const record = getBoardMaps(doc).elements.get(pending.elementId);
    if (record) {
      if (record.get('deleted') === true) return;
      const existing = readElement(doc, pending.elementId);
      if (existing?.type === 'image' && existing.data.assetId === asset.assetId) return;
      throw new Error('O identificador local da imagem já pertence a outro elemento.');
    }
    const element = {
      id: pending.elementId, type: 'image', geometry: pending.geometry, style: {},
      data: { assetId: asset.assetId, mimeType: asset.mimeType,
        width: pending.intrinsicWidth, height: pending.intrinsicHeight },
    };
    history.beginLocalAction({ kind: 'create', logicalId: element.id, index: getBoardMaps(doc).order.length, element });
    try {
      addImageAssetReference(doc, {
        asset, geometry: pending.geometry, intrinsicWidth: pending.intrinsicWidth,
        intrinsicHeight: pending.intrinsicHeight, idFactory: () => pending.elementId, origin: CANVAS_ORIGIN,
      });
    } finally {
      history.stopCapturing();
    }
  };
  const drainPendingImages = async () => {
    if (!boardId || disposed || drainingPending || globalThis.navigator?.onLine === false) return;
    drainingPending = true;
    try {
      await publishPendingBoardImages(boardId, {
        upload: pending => uploadBoardImage(boardId, pending.blob),
        publish: publishPending,
      });
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Uma imagem continua aguardando conexão.';
    } finally {
      drainingPending = false;
    }
  };
  if (boardId) {
    subscribePendingBoardImages(boardId, snapshot => binding.setPendingImages(snapshot))
      .then(unsubscribe => { if (disposed) unsubscribe(); else pendingUnsubscribe = unsubscribe; })
      .catch(error => { if (imageStatus) imageStatus.textContent = error.message; });
  }

  async function insertUploadedImage(file, placement = 'file', dropPoint = null) {
    if (!boardId || !file) return;
    if (!file.type.startsWith('image/')) throw new Error('Selecione um arquivo de imagem.');
    const dimensions = await readImageDimensions(file);
    const currentElements = readBoardElements(doc);
    const canvasBounds = canvas.getBoundingClientRect();
    const center = dropPoint ?? binding.clientToBoardPoint(
      canvasBounds.left + canvasBounds.width / 2,
      canvasBounds.top + canvasBounds.height / 2,
    );
    const geometry = placement === 'template'
      ? templateImageGeometry({
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        viewportWidth: canvas.width,
        viewportHeight: canvas.height,
        centerX: center.x,
        centerY: center.y,
        existingElements: currentElements,
      })
      : fileImageGeometry({
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        canvasWidth: canvas.width,
        centerX: center.x,
        centerY: center.y,
      });
    const id = createElementId();
    let asset;
    try {
      asset = await uploadBoardImage(boardId, file);
    } catch (error) {
      if (!shouldQueuePendingImage(error)) throw error;
      await enqueuePendingBoardImage(boardId, {
        file, geometry, intrinsicWidth: dimensions.width, intrinsicHeight: dimensions.height, elementId: id,
      });
      if (imageStatus) imageStatus.textContent = 'Imagem salva neste navegador; será enviada quando a conexão voltar.';
      void drainPendingImages();
      return 'pending';
    }
    await publishPending({ pending: { elementId: id, geometry, intrinsicWidth: dimensions.width, intrinsicHeight: dimensions.height }, asset });
    return 'published';
  }

  async function insertTemplate(template) {
    if (!boardId) throw new Error('Abra um quadro para inserir um modelo.');
    if (!template?.url || !template?.filename) throw new TypeError('O modelo precisa de URL e nome de arquivo.');
    const response = await fetch(template.url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível carregar o modelo.');
    const blob = await response.blob();
    const file = new File([blob], template.filename, { type: blob.type || 'image/png' });
    return insertUploadedImage(file, 'template');
  }

  const onImagePickerClick = () => imagePicker?.click();
  const onImageSelected = async () => {
    const file = imagePicker?.files?.[0];
    if (imagePicker) imagePicker.value = '';
    if (!file) return;
    try {
      if (imageStatus) imageStatus.textContent = 'Enviando imagem…';
      const result = await insertUploadedImage(file);
      if (result === 'published' && imageStatus) imageStatus.textContent = 'Imagem adicionada ao quadro.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar a imagem.';
    }
  };
  const onTemplateClick = async () => {
    if (!boardId) return;
    try {
      if (imageStatus) imageStatus.textContent = 'Carregando modelo…';
      const result = await insertTemplate({ url: '/api/templates/fsm-reference', filename: 'fsm-reference.png' });
      if (result === 'published' && imageStatus) imageStatus.textContent = 'Modelo adicionado ao quadro.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar o modelo.';
    }
  };
  const onPaste = async event => {
    if (!boardId) return;
    const item = [...(event.clipboardData?.items ?? [])].find(candidate => candidate.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    try {
      if (imageStatus) imageStatus.textContent = 'Enviando imagem da área de transferência…';
      const result = await insertUploadedImage(file);
      if (result === 'published' && imageStatus) imageStatus.textContent = 'Imagem da área de transferência adicionada.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar a imagem.';
    }
  };
  const onDragOver = event => {
    if ([...(event.dataTransfer?.items ?? [])].some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = async event => {
    const file = [...(event.dataTransfer?.files ?? [])].find(candidate => candidate.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    try {
      if (imageStatus) imageStatus.textContent = 'Enviando imagem…';
      const point = binding.clientToBoardPoint(event.clientX, event.clientY);
      const result = await insertUploadedImage(file, 'file', point);
      if (result === 'published' && imageStatus) imageStatus.textContent = 'Imagem adicionada ao quadro.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar a imagem.';
    }
  };
  imageButton?.addEventListener('click', onImagePickerClick);
  imagePicker?.addEventListener('change', onImageSelected);
  templateButton?.addEventListener('click', onTemplateClick);
  const pasteTarget = globalThis.document;
  pasteTarget?.addEventListener('paste', onPaste);
  canvas.addEventListener('dragover', onDragOver);
  canvas.addEventListener('drop', onDrop);
  const keyTarget = globalThis.window ?? globalThis;
  const onKeyDown = event => {
    const target = event.target;
    if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === ' ') {
      binding.setSpacePressed(true);
      event.preventDefault();
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) history.redo(); else history.undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); history.redo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      void Promise.resolve(onSaveBoardImage()).catch(error => {
        if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível salvar a imagem do quadro.';
      });
      return;
    }
    const toolsByKey = { p: 'pen', h: 'highlighter', a: 'arrow', l: 'line', r: 'rectangle', m: 'mux', u: 'alu', t: 'text', e: 'eraser', s: 'select' };
    if (toolsByKey[key]) {
      event.preventDefault();
      tool = toolsByKey[key];
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.boardTool === tool));
    } else if (key === 'f') binding.fitToScreen();
    else if (key === '+' || key === '=') binding.zoomIn();
    else if (key === '-') binding.zoomOut();
    else if (key === '0') binding.resetZoom();
    else if (key === 'delete' || key === 'backspace') binding.deleteSelected();
  };
  const onKeyUp = event => { if (event.key === ' ') binding.setSpacePressed(false); };
  keyTarget.addEventListener?.('keydown', onKeyDown);
  keyTarget.addEventListener?.('keyup', onKeyUp);
  const actionListeners = actionButtons.map(button => {
    const listener = () => {
      const action = button.dataset.boardAction;
      if (action === 'clear') {
        if ((globalThis.confirm ?? (() => true))('Limpar todos os elementos deste quadro?')) history.clearElements();
      } else if (action === 'zoom-in') binding.zoomIn();
      else if (action === 'zoom-out') binding.zoomOut();
      else if (action === 'zoom-reset') binding.resetZoom();
      else if (action === 'fit') binding.fitToScreen();
    };
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const onOnline = () => { void drainPendingImages(); };
  keyTarget.addEventListener?.('online', onOnline);
  void drainPendingImages();
  refreshHistoryButtons({ canUndo: history.canUndo, canRedo: history.canRedo });
  return {
    doc,
    history,
    canvas: binding,
    insertTemplate,
    renderSnapshot: () => renderBoardSnapshot(doc, boardId),
    destroy() {
      binding.destroy();
      for (const unsubscribe of presenceListeners) unsubscribe?.();
      boardSession?.setLocalPresence?.(null);
      presenceStatus?.remove();
      for (const [button, listener] of buttonListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of colorListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of sizeListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of actionListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of undoListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of redoListeners) button.removeEventListener('click', listener);
      imageButton?.removeEventListener('click', onImagePickerClick);
      imagePicker?.removeEventListener('change', onImageSelected);
      templateButton?.removeEventListener('click', onTemplateClick);
      pasteTarget?.removeEventListener('paste', onPaste);
      canvas.removeEventListener('dragover', onDragOver);
      canvas.removeEventListener('drop', onDrop);
      keyTarget.removeEventListener?.('keydown', onKeyDown);
      keyTarget.removeEventListener?.('keyup', onKeyUp);
      keyTarget.removeEventListener?.('online', onOnline);
      disposed = true;
      pendingUnsubscribe?.();
      history.destroy();
      if (ownsDoc) doc.destroy();
    },
  };
}
