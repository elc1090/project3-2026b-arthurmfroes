import * as Y from 'yjs';
import { addElement, createElementId, getBoardMaps, readBoardElements } from '../shared/board-model.js';
import { bindBoardCanvas, CANVAS_ORIGIN } from './board-canvas.js';
import { LocalBoardHistory } from './board-undo.js';
import {
  addImageAssetReference,
  fileImageGeometry,
  readImageDimensions,
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
export function mountBoardCanvas({ boardId, canvas, toolbar, doc: suppliedDoc, elements = [] }) {
  const ownsDoc = !suppliedDoc;
  const doc = suppliedDoc ?? createBoardDocument(elements);
  let tool = 'select';
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
    getLogicalId: id => history.logicalIdFor(id),
    beforeLocalAction: action => history.beginLocalAction(action),
    afterLocalAction: () => history.stopCapturing(),
    deleteElement: id => history.deleteElement(id),
    eraseAt: options => history.eraseAt(options),
  });
  const imageControls = [imagePicker, imageButton, templateButton].filter(Boolean);
  for (const control of imageControls) control.disabled = !boardId;

  async function insertUploadedImage(file, placement = 'file') {
    if (!boardId || !file) return;
    if (!file.type.startsWith('image/')) throw new Error('Selecione um arquivo de imagem.');
    const dimensions = await readImageDimensions(file);
    const currentElements = readBoardElements(doc);
    const geometry = placement === 'template'
      ? templateImageGeometry({
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        viewportWidth: canvas.width,
        viewportHeight: canvas.height,
        centerX: canvas.width / 2,
        centerY: canvas.height / 2,
        existingElements: currentElements,
      })
      : fileImageGeometry({
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        canvasWidth: canvas.width,
        centerX: canvas.width / 2,
        centerY: canvas.height / 2,
      });
    const asset = await uploadBoardImage(boardId, file);
    const id = createElementId();
    const element = {
      id,
      type: 'image',
      geometry,
      style: {},
      data: { assetId: asset.assetId, mimeType: asset.mimeType, width: dimensions.width, height: dimensions.height },
    };
    history.beginLocalAction({
      kind: 'create',
      logicalId: id,
      index: getBoardMaps(doc).order.length,
      element,
    });
    try {
      addImageAssetReference(doc, {
        asset,
        geometry,
        intrinsicWidth: dimensions.width,
        intrinsicHeight: dimensions.height,
        idFactory: () => id,
        origin: CANVAS_ORIGIN,
      });
    } finally {
      history.stopCapturing();
    }
  }

  const onImagePickerClick = () => imagePicker?.click();
  const onImageSelected = async () => {
    const file = imagePicker?.files?.[0];
    if (imagePicker) imagePicker.value = '';
    if (!file) return;
    try {
      if (imageStatus) imageStatus.textContent = 'Enviando imagem…';
      await insertUploadedImage(file);
      if (imageStatus) imageStatus.textContent = 'Imagem adicionada ao quadro.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar a imagem.';
    }
  };
  const onTemplateClick = async () => {
    if (!boardId) return;
    try {
      if (imageStatus) imageStatus.textContent = 'Carregando modelo…';
      const response = await fetch('/api/templates/fsm-reference', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível carregar o modelo.');
      const blob = await response.blob();
      const file = new File([blob], 'fsm-reference.png', { type: blob.type || 'image/png' });
      await insertUploadedImage(file, 'template');
      if (imageStatus) imageStatus.textContent = 'Modelo adicionado ao quadro.';
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
      await insertUploadedImage(file);
      if (imageStatus) imageStatus.textContent = 'Imagem da área de transferência adicionada.';
    } catch (error) {
      if (imageStatus) imageStatus.textContent = error.message ?? 'Não foi possível adicionar a imagem.';
    }
  };
  imageButton?.addEventListener('click', onImagePickerClick);
  imagePicker?.addEventListener('change', onImageSelected);
  templateButton?.addEventListener('click', onTemplateClick);
  const pasteTarget = globalThis.document;
  pasteTarget?.addEventListener('paste', onPaste);
  refreshHistoryButtons({ canUndo: history.canUndo, canRedo: history.canRedo });
  return {
    doc,
    history,
    destroy() {
      binding.destroy();
      for (const [button, listener] of buttonListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of undoListeners) button.removeEventListener('click', listener);
      for (const [button, listener] of redoListeners) button.removeEventListener('click', listener);
      imageButton?.removeEventListener('click', onImagePickerClick);
      imagePicker?.removeEventListener('change', onImageSelected);
      templateButton?.removeEventListener('click', onTemplateClick);
      pasteTarget?.removeEventListener('paste', onPaste);
      history.destroy();
      if (ownsDoc) doc.destroy();
    },
  };
}
