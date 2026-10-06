const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 1024 * 1024;

export function mountReplicaPanel({ boardId, session, root = document.querySelector('#replica-panel') }) {
  if (!boardId || !session?.doc || !root) throw new TypeError('Replica panel requires an active board session.');
  const cards = root.querySelector('#replica-previews');
  const status = root.querySelector('#replica-panel-status');
  const localState = root.querySelector('#replica-local-state');
  const serverState = root.querySelector('#replica-server-state');
  const peerState = root.querySelector('#replica-peer-state');
  const pauseServerButton = root.querySelector('#replica-pause-server');
  const resumeServerButton = root.querySelector('#replica-resume-server');
  const pausePeerButton = root.querySelector('#replica-pause-peer');
  const resumePeerButton = root.querySelector('#replica-resume-peer');
  let destroyed = false;
  let socket = null;
  let reconnectTimer = null;
  let publishTimer = null;
  let statusTimer = null;
  const localReplicaId = getStableReplicaId(boardId);
  let currentServerElements = null;
  let currentPeerViews = [];
  let diagnosticState = 'conectando';
  let refreshIntervalMs = 1_000;
  let peerPaused = false;
  const previewCards = new Map();
  const imageBitmaps = new Map();

  function cardFor(replicaId, label) {
    let card = previewCards.get(replicaId);
    if (card) {
      card.title.textContent = label;
      return card;
    }
    const article = document.createElement('article');
    article.className = 'replica-preview-card';
    article.dataset.replicaId = replicaId;
    const heading = document.createElement('h4');
    heading.textContent = label;
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    canvas.setAttribute('aria-label', `Prévia de ${label}`);
    const caption = document.createElement('p');
    caption.className = 'replica-preview-caption';
    article.append(heading, canvas, caption);
    cards.append(article);
    card = { article, title: heading, canvas, caption, version: 0 };
    previewCards.set(replicaId, card);
    return card;
  }

  function removeUnusedCards(used) {
    for (const [replicaId, card] of previewCards) {
      if (used.has(replicaId)) continue;
      card.article.remove();
      previewCards.delete(replicaId);
    }
  }

  function readBoardProjection(doc) {
    const elementMap = doc.getMap('elements');
    const seen = new Set();
    const elements = [];
    for (const id of doc.getArray('order').toArray()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const record = elementMap.get(id);
      if (!record || typeof record.toJSON !== 'function') continue;
      const value = record.toJSON();
      if (value.deleted === true) continue;
      elements.push({ id, type: value.type, geometry: value.geometry, style: value.style ?? {}, data: value.data ?? {} });
    }
    return elements;
  }

  async function drawPreview(replicaId, label, elements) {
    const card = cardFor(replicaId, label);
    const version = ++card.version;
    const bounds = elementsBounds(elements);
    const imageIds = [...new Set(elements.filter((element) => element.type === 'image').map((element) => element.data.assetId))];
    const loadedImages = await Promise.all(imageIds.map(loadPreviewImage));
    const previewImages = new Map(imageIds.map((assetId, index) => [assetId, loadedImages[index]]));
    if (destroyed || card.version !== version) return;
    const context = card.canvas.getContext('2d');
    context.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    context.strokeStyle = '#e2e8f0';
    context.lineWidth = 1;
    for (let x = 0; x < PREVIEW_WIDTH; x += 20) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, PREVIEW_HEIGHT); context.stroke();
    }
    for (let y = 0; y < PREVIEW_HEIGHT; y += 20) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(PREVIEW_WIDTH, y); context.stroke();
    }
    if (!elements.length) {
      card.caption.textContent = '0 objetos · quadro vazio';
      card.article.dataset.elementCount = '0';
      card.article.dataset.elementTypes = '';
      return;
    }
    const extent = bounds ?? { minX: 0, minY: 0, width: 1, height: 1 };
    const scale = Math.min((PREVIEW_WIDTH - 24) / Math.max(extent.width, 1), (PREVIEW_HEIGHT - 24) / Math.max(extent.height, 1));
    const offsetX = 12 + (PREVIEW_WIDTH - 24 - extent.width * scale) / 2 - extent.minX * scale;
    const offsetY = 12 + (PREVIEW_HEIGHT - 24 - extent.height * scale) / 2 - extent.minY * scale;
    context.save();
    context.translate(offsetX, offsetY);
    context.scale(scale, scale);
    for (const element of elements) drawElement(context, element, previewImages.get(element.data.assetId));
    context.restore();
    const types = [...new Set(elements.map((element) => element.type))].join(', ');
    card.caption.textContent = `${elements.length} ${elements.length === 1 ? 'objeto' : 'objetos'} · ${types}`;
    card.article.dataset.elementCount = String(elements.length);
    card.article.dataset.elementTypes = types;
  }

  function loadPreviewImage(assetId) {
    if (!imageBitmaps.has(assetId)) {
      const promise = fetch(`/api/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}`, {
        credentials: 'same-origin', cache: 'no-store',
      }).then(async (response) => {
        if (!response.ok) throw new Error('Não foi possível carregar a imagem da prévia.');
        return createImageBitmap(await response.blob());
      }).catch((error) => {
        imageBitmaps.delete(assetId);
        return { error };
      });
      imageBitmaps.set(assetId, promise);
    }
    return imageBitmaps.get(assetId);
  }

  function renderPreviews() {
    const used = new Set();
    used.add('local');
    void drawPreview('local', 'Este navegador · projeção efêmera', readBoardProjection(session.doc));
    if (currentServerElements) {
      used.add('vps');
      void drawPreview('vps', 'VPS persistida · projeção diagnóstica', currentServerElements);
    }
    for (const peer of currentPeerViews) {
      if (peer.replicaId === localReplicaId) continue;
      used.add(peer.replicaId);
      void drawPreview(peer.replicaId, `${peer.username} · outra réplica`, peer.elements);
    }
    removeUnusedCards(used);
  }

  function updateStatus() {
    const server = session.serverStatus;
    const p2p = session.p2pStatus;
    localState.textContent = 'Estado local: ativo';
    serverState.textContent = `Conexão VPS: ${server === 'connected' ? 'ativa' : server === 'paused' ? 'pausada neste navegador' : server}`;
    const peerCount = session.p2pPeerCount ?? p2p.peerCount ?? 0;
    peerState.textContent = `P2P: ${peerCount > 0 ? `${peerCount} peer(s) conectado(s)` : peerPaused ? 'desconectado ou pausado' : p2p.connected ? 'aguardando conexão direta' : 'desconectado'}`;
    status.textContent = `Canal de diagnóstico ${diagnosticState}; prévias são projeções efêmeras, não confirmações de persistência. A prévia da VPS é atualizada a cada ~${Math.round(refreshIntervalMs / 100) / 10}s.`;
    pauseServerButton.disabled = server === 'paused';
    resumeServerButton.disabled = server !== 'paused';
    pausePeerButton.disabled = peerPaused;
    resumePeerButton.disabled = !peerPaused;
  }

  function sendSnapshot() {
    if (destroyed || socket?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({ type: 'snapshot', elements: readBoardProjection(session.doc) });
    if (new TextEncoder().encode(payload).byteLength > MAX_DIAGNOSTIC_MESSAGE_BYTES) {
      status.textContent = 'Projeção local acima do limite de diagnóstico; estado do quadro não foi alterado.';
      return;
    }
    socket.send(payload);
  }

  function scheduleSnapshot() {
    if (publishTimer !== null) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = null;
      sendSnapshot();
      renderPreviews();
    }, 125);
  }

  function connectDiagnostics() {
    if (destroyed) return;
    const url = new URL(`/api/boards/${encodeURIComponent(boardId)}/replicas`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('replicaId', localReplicaId.slice('peer:'.length));
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener('open', () => {
      if (socket !== current || destroyed) return;
      diagnosticState = 'ativo';
      sendSnapshot();
      updateStatus();
    });
    current.addEventListener('message', (event) => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        refreshIntervalMs = message.refreshIntervalMs ?? refreshIntervalMs;
        renderPreviews();
        updateStatus();
      } else if (message.type === 'replicas' && message.projectionOnly === true) {
        currentServerElements = Array.isArray(message.vps?.elements) ? message.vps.elements : null;
        currentPeerViews = Array.isArray(message.peers) ? message.peers.filter((peer) => Array.isArray(peer.elements)) : [];
        renderPreviews();
      } else if (message.type === 'event') {
        root.dispatchEvent(new CustomEvent('replica-diagnostic-event', { detail: message }));
      }
    });
    current.addEventListener('close', () => {
      if (socket !== current || destroyed) return;
      diagnosticState = 'desconectado';
      updateStatus();
      reconnectTimer = setTimeout(connectDiagnostics, 1000);
    });
    current.addEventListener('error', () => {
      if (socket !== current) return;
      diagnosticState = 'indisponível';
      updateStatus();
    });
  }

  const unsubscribeServer = session.on('server-status', updateStatus);
  const unsubscribePeer = session.on('p2p-status', updateStatus);
  const onDocumentUpdate = () => scheduleSnapshot();
  const onPauseServer = () => { session.pauseServerSync(); updateStatus(); };
  const onResumeServer = () => { session.resumeServerSync(); updateStatus(); };
  const onPausePeer = () => { session.pausePeerSync(); peerPaused = true; updateStatus(); };
  const onResumePeer = () => { session.resumePeerSync(); peerPaused = false; updateStatus(); };
  session.doc.on('update', onDocumentUpdate);
  pauseServerButton.addEventListener('click', onPauseServer);
  resumeServerButton.addEventListener('click', onResumeServer);
  pausePeerButton.addEventListener('click', onPausePeer);
  resumePeerButton.addEventListener('click', onResumePeer);
  updateStatus();
  renderPreviews();
  connectDiagnostics();
  statusTimer = setInterval(updateStatus, 250);

  return Object.freeze({
    publishEvent(event) {
      if (destroyed || socket?.readyState !== WebSocket.OPEN || !event || typeof event.type !== 'string') return false;
      const payload = JSON.stringify({ type: 'event', event });
      if (new TextEncoder().encode(payload).byteLength > 8_192) return false;
      socket.send(payload);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (publishTimer !== null) clearTimeout(publishTimer);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (statusTimer !== null) clearInterval(statusTimer);
      session.doc.off('update', onDocumentUpdate);
      unsubscribeServer();
      unsubscribePeer();
      pauseServerButton.removeEventListener('click', onPauseServer);
      resumeServerButton.removeEventListener('click', onResumeServer);
      pausePeerButton.removeEventListener('click', onPausePeer);
      resumePeerButton.removeEventListener('click', onResumePeer);
      socket?.close(1000, 'Replica panel closed');
      for (const image of imageBitmaps.values()) {
        Promise.resolve(image).then((bitmap) => bitmap.close?.()).catch(() => {});
      }
      previewCards.clear();
      cards.replaceChildren();
    },
  });
}

function elementsBounds(elements) {
  const bounds = elements.map(elementBounds).filter(Boolean);
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map((item) => item.x));
  const minY = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function elementBounds(element) {
  const { geometry, data, style } = element;
  if (['image', 'rect', 'mux', 'alu'].includes(element.type)
    && [geometry?.x, geometry?.y, geometry?.width, geometry?.height].every(Number.isFinite)) {
    return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  }
  if (element.type === 'path' && Array.isArray(geometry?.points) && geometry.points.length) {
    const xs = geometry.points.map((point) => point.x);
    const ys = geometry.points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (['line', 'arrow'].includes(element.type) && [geometry?.x1, geometry?.y1, geometry?.x2, geometry?.y2].every(Number.isFinite)) {
    return { x: Math.min(geometry.x1, geometry.x2), y: Math.min(geometry.y1, geometry.y2), width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1) };
  }
  if (element.type === 'text' && Number.isFinite(geometry?.x) && Number.isFinite(geometry?.y)) {
    const size = (style?.strokeWidth ?? 2) * 4 + 11;
    return { x: geometry.x, y: geometry.y, width: (data?.text ?? '').length * size * .6, height: size * 1.3 };
  }
  return null;
}

function drawElement(context, element, bitmap) {
  const { geometry, style = {}, data = {} } = element;
  context.save();
  context.strokeStyle = style.color ?? '#1e293b';
  context.fillStyle = style.color ?? '#1e293b';
  context.lineWidth = style.strokeWidth ?? 2;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (element.type === 'image') {
    if (bitmap && !bitmap.error) context.drawImage(bitmap, geometry.x, geometry.y, geometry.width, geometry.height);
    else { context.fillStyle = '#fecaca'; context.fillRect(geometry.x, geometry.y, geometry.width, geometry.height); }
  } else if (element.type === 'path' && Array.isArray(geometry.points) && geometry.points.length > 1) {
    context.beginPath();
    if (style.tool === 'highlighter') { context.globalAlpha = .35; context.lineWidth *= 2.8; }
    context.moveTo(geometry.points[0].x, geometry.points[0].y);
    for (const point of geometry.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  } else if (element.type === 'line' || element.type === 'arrow') {
    context.beginPath(); context.moveTo(geometry.x1, geometry.y1); context.lineTo(geometry.x2, geometry.y2); context.stroke();
    if (element.type === 'arrow') {
      const angle = Math.atan2(geometry.y2 - geometry.y1, geometry.x2 - geometry.x1);
      const size = Math.max(8, context.lineWidth * 3);
      context.beginPath(); context.moveTo(geometry.x2, geometry.y2);
      context.lineTo(geometry.x2 - size * Math.cos(angle - Math.PI / 6), geometry.y2 - size * Math.sin(angle - Math.PI / 6));
      context.lineTo(geometry.x2 - size * Math.cos(angle + Math.PI / 6), geometry.y2 - size * Math.sin(angle + Math.PI / 6));
      context.closePath(); context.fill();
    }
  } else if (element.type === 'rect') {
    context.fillStyle = 'rgba(255,255,255,.7)'; context.fillRect(geometry.x, geometry.y, geometry.width, geometry.height); context.strokeRect(geometry.x, geometry.y, geometry.width, geometry.height);
  } else if (element.type === 'mux' || element.type === 'alu') {
    context.fillStyle = '#fff'; context.beginPath();
    context.moveTo(geometry.x, geometry.y);
    context.lineTo(geometry.x + geometry.width, geometry.y + geometry.height * (element.type === 'mux' ? .15 : .35));
    context.lineTo(geometry.x + geometry.width, geometry.y + geometry.height * (element.type === 'mux' ? .85 : .65));
    context.lineTo(geometry.x, geometry.y + geometry.height);
    context.closePath(); context.fill(); context.stroke();
    context.fillStyle = style.color ?? '#1e293b'; context.font = 'bold 11px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(element.type === 'mux' ? 'MUX' : 'ULA / ALU', geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
  } else if (element.type === 'text') {
    const size = (style.strokeWidth ?? 2) * 4 + 11;
    context.fillStyle = style.color ?? '#1e293b'; context.font = `${size}px monospace`; context.textBaseline = 'top'; context.fillText(data.text ?? '', geometry.x, geometry.y);
  }
  context.restore();
}

function getStableReplicaId(boardId) {
  const key = `t3-replica:${boardId}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = `peer:${crypto.randomUUID()}`;
      sessionStorage.setItem(key, id);
    } else if (!id.startsWith('peer:')) {
      id = `peer:${id}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `peer:${crypto.randomUUID()}`;
  }
}
