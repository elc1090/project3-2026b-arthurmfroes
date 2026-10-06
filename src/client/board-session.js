import { WebrtcProvider } from 'y-webrtc';
import { openOfflineBoard } from './offline-board.js';
import { createServerSyncProvider } from './server-sync-provider.js';
import { createSyncEventTracker } from './sync-event-tracker.js';

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
  let peerEpoch = null;
  let accessRevoked = false;
  let signalingRetry = null;
  let signalingAttempt = 0;
  let peerConnectGeneration = 0;
  const sessionListeners = new Map();
  const signalingListenerCleanups = new WeakMap();

  function emit(type, detail) {
    onEvent(type, detail);
    for (const listener of sessionListeners.get(type) ?? []) listener(detail);
  }

  const eventTracker = createSyncEventTracker(boardId, { onEvent: emit });

  const serverSync = createServerSyncProvider(doc, boardId, {
    WebSocketImpl,
    locationHref,
    initialServerPaused,
    onEvent: emit,
    eventTracker,
  });

  function onDocumentUpdate(update, origin) {
    if (origin === serverSync.origin || update.byteLength <= 2) return;
    const fromPeerRoom = origin === peerProvider?.room;
    const detail = {
      sourcePath: fromPeerRoom ? 'peer-room' : 'local',
      actionKind: fromPeerRoom
        ? 'peer-update'
        : origin?.description === 'canvas-local-action'
          ? 'canvas-gesture'
          : origin?.description === 'semantic-undo'
            ? 'undo'
            : 'yjs-update',
      ...(fromPeerRoom ? {
        directPeerConnectedAtObservation: [...(peerProvider?.room?.webrtcConns?.values() ?? [])]
          .some((connection) => connection.connected === true),
      } : {}),
    };
    const observation = fromPeerRoom && peerProvider?.room?.synced !== true
      ? eventTracker.observeSyncBatch(update, { ...detail, state: 'peer-room-not-yet-synced' })
      : eventTracker.observeUpdate(update, detail);
    void observation.catch((error) => emit('error', error));
  }
  doc.on('update', onDocumentUpdate);

  function publishPeerState() {
    const room = peerProvider?.room;
    const webrtcPeers = room ? [...room.webrtcConns.keys()] : [];
    const bcPeers = room ? [...room.bcConns] : [];
    peerState = {
      connected: Boolean(peerProvider?.connected),
      webrtcPeers,
      bcPeers,
      peerCount: room
        ? [...room.webrtcConns.values()].filter((connection) => connection.connected).length
        : 0,
      topic: peerProvider?.roomName ?? null,
      epoch: peerProvider ? peerEpoch : null,
    };
    emit('p2p-status', peerState);
  }

  function removeSignalingListeners(provider) {
    signalingListenerCleanups.get(provider)?.();
    signalingListenerCleanups.delete(provider);
  }

  function disposePeerProvider(provider) {
    removeSignalingListeners(provider);
    const room = provider.room;
    const connections = room ? [...room.webrtcConns.values()] : [];
    const peerClosed = connections.map((connection) => new Promise((resolve) => {
      if (connection.closed || connection.peer.destroyed) {
        resolve();
      } else {
        connection.peer.once('close', resolve);
      }
    }));
    provider.destroy();
    return Promise.resolve(provider.key).then(() => Promise.all(peerClosed)).then(() => {
      if (connections.length) {
        emit('p2p-peers-removed', { topic: provider.roomName, peers: connections.map(({ remotePeerId }) => remotePeerId) });
      }
    });
  }

  function stopAfterAccessRevoked(type, detail = {}) {
    if (accessRevoked || destroyed) return;
    accessRevoked = true;
    peerPaused = true;
    peerConnectGeneration += 1;
    if (signalingRetry !== null) clearTimeout(signalingRetry);
    signalingRetry = null;
    const previousProvider = peerProvider;
    peerProvider = null;
    if (previousProvider) void disposePeerProvider(previousProvider);
    serverSync.pause();
    serverSync.destroy();
    publishPeerState();
    emit(type, { boardId, epoch: peerEpoch, ...detail });
  }

  function rotatePeerProvider(provider, nextEpoch) {
    if (destroyed || accessRevoked || peerProvider !== provider) return;
    if (Number.isSafeInteger(nextEpoch) && nextEpoch <= peerEpoch) return;

    peerConnectGeneration += 1;
    const generation = peerConnectGeneration;
    peerProvider = null;
    if (Number.isSafeInteger(nextEpoch)) peerEpoch = nextEpoch;
    const disposed = disposePeerProvider(provider);
    publishPeerState();
    void disposed.then(() => {
      if (destroyed || accessRevoked || peerPaused || generation !== peerConnectGeneration) return;
      void connectPeer();
    }).catch((error) => emit('error', error));
  }

  function listenForBoardEpoch(provider) {
    const connections = provider.signalingConns ?? [];
    const listeners = [];
    for (const connection of connections) {
      if (typeof connection?.on !== 'function' || typeof connection?.off !== 'function') continue;
      const onMessage = (message) => {
        if (peerProvider !== provider || !message || typeof message !== 'object') return;
        if (message.type === 'board-epoch-changed'
          && message.boardId === boardId
          && message.topic === provider.roomName
          && Number.isSafeInteger(message.epoch)) {
          rotatePeerProvider(provider, message.epoch);
          return;
        }
        if (message.type !== 'error' || message.topic !== provider.roomName) return;
        if (message.error === 'not_member') {
          stopAfterAccessRevoked('membership-revoked', { source: 'signaling' });
        } else if (message.error === 'unknown_topic' || message.error === 'stale_epoch') {
          rotatePeerProvider(provider);
        }
      };
      connection.on('message', onMessage);
      listeners.push([connection, onMessage]);
    }
    signalingListenerCleanups.set(provider, () => {
      for (const [connection, listener] of listeners) connection.off('message', listener);
    });
  }

  function scheduleSignalingRetry() {
    if (destroyed || peerPaused || accessRevoked || signalingRetry !== null || peerProvider) return;
    const delay = SIGNALING_RETRY_DELAYS_MS[Math.min(signalingAttempt, SIGNALING_RETRY_DELAYS_MS.length - 1)];
    signalingAttempt += 1;
    signalingRetry = setTimeout(() => {
      signalingRetry = null;
      void connectPeer();
    }, delay);
  }

  async function connectPeer() {
    if (destroyed || peerPaused || accessRevoked || peerProvider) return;
    const generation = ++peerConnectGeneration;
    try {
      const accessUrl = new URL(`/api/boards/${encodeURIComponent(boardId)}/signaling`, locationHref);
      const response = await fetchImpl(accessUrl, { credentials: 'same-origin' });
      const access = await response.json();
      if (destroyed || peerPaused || accessRevoked || peerProvider || generation !== peerConnectGeneration) return;
      if (response.status === 403) {
        stopAfterAccessRevoked('membership-revoked', { source: 'signaling-access' });
        return;
      }
      if (response.status === 401) {
        stopAfterAccessRevoked('session-expired', { source: 'signaling-access' });
        return;
      }
      if (!response.ok) throw new Error(access.error ?? 'Board peer access is unavailable');
      if (!Number.isSafeInteger(access.epoch)) throw new Error('The signaling response has no board epoch');

      const signalingUrl = new URL('/api/signaling', locationHref);
      signalingUrl.protocol = signalingUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const nextProvider = new WebrtcProvider(access.topic, doc, {
        signaling: [signalingUrl.toString()],
        password: access.password,
        maxConns: 8,
        filterBcConns: true,
      });
      peerEpoch = access.epoch;
      peerProvider = nextProvider;
      listenForBoardEpoch(nextProvider);
      nextProvider.on('status', publishPeerState);
      nextProvider.on('peers', (event) => {
        if (event.removed?.length) {
          emit('p2p-peers-removed', { topic: nextProvider.roomName, peers: event.removed });
        }
        publishPeerState();
      });
      nextProvider.on('synced', (event) => emit('p2p-synced', event));
      signalingAttempt = 0;
      publishPeerState();
    } catch (error) {
      if (destroyed || peerPaused || accessRevoked || generation !== peerConnectGeneration) return;
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
    get p2pEpoch() { return peerEpoch; },
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
      if (destroyed || accessRevoked || !peerPaused) return;
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
      doc.off('update', onDocumentUpdate);
      const activeProvider = peerProvider;
      peerProvider = null;
      if (activeProvider) disposePeerProvider(activeProvider);
      destroyPromise = Promise.resolve(activeProvider?.key).then(() => offline.destroy());
      return destroyPromise;
    },
  });
}
