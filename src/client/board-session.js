import { WebrtcProvider } from 'y-webrtc';
import { openOfflineBoard } from './offline-board.js';
import { createServerSyncProvider } from './server-sync-provider.js';

const SIGNALING_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Open one browser's durable Y.Doc and attach both network providers to it.
 * The board document remains usable while either network path is unavailable.
 */
export async function openBoardSession(boardId, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  locationHref = globalThis.location?.href,
  initialServerPaused = false,
  initialPeerPaused = false,
  onEvent = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function' || !locationHref) {
    throw new Error('A browser fetch implementation and location are required');
  }

  const offline = openOfflineBoard(boardId);
  await offline.ready;
  const doc = offline.doc;
  let destroyed = false;
  let peerPaused = initialPeerPaused;
  let peerProvider = null;
  let peerState = { connected: false, webrtcPeers: [], bcPeers: [] };
  let signalingRetry = null;
  let signalingAttempt = 0;
  let peerConnectGeneration = 0;
  const sessionListeners = new Map();

  function emit(type, detail) {
    onEvent(type, detail);
    for (const listener of sessionListeners.get(type) ?? []) listener(detail);
  }

  const serverSync = createServerSyncProvider(doc, boardId, {
    WebSocketImpl,
    locationHref,
    initialServerPaused,
    onEvent: emit,
  });

  function publishPeerState() {
    const room = peerProvider?.room;
    peerState = {
      connected: Boolean(peerProvider?.connected),
      webrtcPeers: room ? [...room.webrtcConns.keys()] : [],
      bcPeers: room ? [...room.bcConns] : [],
    };
    emit('p2p-status', peerState);
  }

  function scheduleSignalingRetry() {
    if (destroyed || peerPaused || signalingRetry !== null || peerProvider) return;
    const delay = SIGNALING_RETRY_DELAYS_MS[Math.min(signalingAttempt, SIGNALING_RETRY_DELAYS_MS.length - 1)];
    signalingAttempt += 1;
    signalingRetry = setTimeout(() => {
      signalingRetry = null;
      void connectPeer();
    }, delay);
  }

  async function connectPeer() {
    if (destroyed || peerPaused || peerProvider) return;
    const generation = ++peerConnectGeneration;
    try {
      const accessUrl = new URL(`/api/boards/${encodeURIComponent(boardId)}/signaling`, locationHref);
      const response = await fetchImpl(accessUrl, { credentials: 'same-origin' });
      const access = await response.json();
      if (!response.ok) throw new Error(access.error ?? 'Board peer access is unavailable');
      if (destroyed || peerPaused || peerProvider || generation !== peerConnectGeneration) return;

      const signalingUrl = new URL('/api/signaling', locationHref);
      signalingUrl.protocol = signalingUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      peerProvider = new WebrtcProvider(access.topic, doc, {
        signaling: [signalingUrl.toString()],
        password: access.password,
        maxConns: 8,
        filterBcConns: true,
      });
      peerProvider.on('status', publishPeerState);
      peerProvider.on('peers', publishPeerState);
      peerProvider.on('synced', (event) => emit('p2p-synced', event));
      signalingAttempt = 0;
      publishPeerState();
    } catch (error) {
      emit('error', error);
      scheduleSignalingRetry();
    }
  }

  if (!peerPaused) void connectPeer();

  let destroyPromise;
  return Object.freeze({
    doc,
    ready: Promise.resolve(doc),
    get serverStatus() { return serverSync.status; },
    get p2pStatus() { return { ...peerState }; },
    get p2pPeerCount() {
      return [...(peerProvider?.room?.webrtcConns?.values() ?? [])].filter((connection) => connection.connected).length;
    },
    pauseServerSync() { serverSync.pause(); },
    resumeServerSync() { serverSync.resume(); },
    pausePeerSync() {
      if (destroyed || peerPaused) return;
      peerPaused = true;
      peerConnectGeneration += 1;
      if (signalingRetry !== null) clearTimeout(signalingRetry);
      signalingRetry = null;
      peerProvider?.disconnect();
      publishPeerState();
    },
    resumePeerSync() {
      if (destroyed || !peerPaused) return;
      peerPaused = false;
      if (peerProvider) peerProvider.connect();
      else void connectPeer();
      publishPeerState();
    },
    on(type, listener) {
      if (!sessionListeners.has(type)) sessionListeners.set(type, new Set());
      sessionListeners.get(type).add(listener);
      return () => sessionListeners.get(type)?.delete(listener);
    },
    destroy() {
      if (destroyPromise) return destroyPromise;
      destroyed = true;
      peerConnectGeneration += 1;
      if (signalingRetry !== null) clearTimeout(signalingRetry);
      signalingRetry = null;
      serverSync.destroy();
      const activeProvider = peerProvider;
      peerProvider = null;
      activeProvider?.destroy();
      destroyPromise = Promise.resolve(activeProvider?.key).then(() => offline.destroy());
      return destroyPromise;
    },
  });
}
