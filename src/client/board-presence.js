import * as broadcastChannel from 'lib0/broadcastchannel';

const PRESENCE_FIELD = 'boardPresence';
const CURSOR_THROTTLE_MS = 35;
const PREVIEW_THROTTLE_MS = 45;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_COLOR_LENGTH = 32;
const MAX_PREVIEW_TOOL_LENGTH = 32;
const MAX_PREVIEW_POINTS = 256;

// This adapter targets the pinned y-webrtc Room hooks so Awareness bypasses BC
// while broadcastRoomMessage still sends to every connected WebRTC datachannel.
/** Send transient board presence over y-webrtc's direct peer datachannels. */
export function createBoardPresence(boardId, onEvent = () => {}, {
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let attachedProvider = null;
  let attachedRoom = null;
  let awareness = null;
  let originalAwarenessHandler = null;
  let peerOnlyAwarenessHandler = null;
  let originalBcSubscriber = null;
  let ignoredBcSubscriber = null;
  let originalConnect = null;
  let peerOnlyConnect = null;
  let changeHandler = null;
  let destroyed = false;
  let publishingEnabled = false;
  let localPresence = null;
  let presenceIdentity = null;
  let localCursor = null;
  let localPreview = null;
  let lastCursorSentAt = Number.NEGATIVE_INFINITY;
  let lastPreviewSentAt = Number.NEGATIVE_INFINITY;
  let cursorTimer = null;
  let previewTimer = null;
  const remote = new Map();
  const releasedProviders = new WeakSet();

  function currentLocalState() {
    return {
      user: localPresence,
      cursor: localCursor,
      preview: localPreview,
    };
  }

  function publishLocalState() {
    if (!awareness || !attachedProvider || destroyed || !publishingEnabled) return;
    const priorState = awareness.getLocalState() ?? {};
    awareness.setLocalState({ ...priorState, [PRESENCE_FIELD]: currentLocalState() });
  }

  function cancelCursorTimer() {
    if (cursorTimer !== null) cancel(cursorTimer);
    cursorTimer = null;
  }

  function cancelPreviewTimer() {
    if (previewTimer !== null) cancel(previewTimer);
    previewTimer = null;
  }

  function scheduleCursor() {
    const remaining = CURSOR_THROTTLE_MS - (now() - lastCursorSentAt);
    if (remaining <= 0) {
      lastCursorSentAt = now();
      publishLocalState();
      return;
    }
    if (cursorTimer !== null) return;
    cursorTimer = schedule(() => {
      cursorTimer = null;
      lastCursorSentAt = now();
      publishLocalState();
    }, remaining);
  }

  function schedulePreview() {
    const remaining = PREVIEW_THROTTLE_MS - (now() - lastPreviewSentAt);
    if (remaining <= 0) {
      lastPreviewSentAt = now();
      publishLocalState();
      return;
    }
    if (previewTimer !== null) return;
    previewTimer = schedule(() => {
      previewTimer = null;
      lastPreviewSentAt = now();
      publishLocalState();
    }, remaining);
  }

  function setLocalPresence(value) {
    if (value === null) {
      presenceIdentity = null;
      localPresence = null;
    } else if (value && typeof value === 'object'
      && typeof value.displayName === 'string'
      && value.displayName.length <= MAX_DISPLAY_NAME_LENGTH
      && typeof value.color === 'string'
      && value.color.length <= MAX_COLOR_LENGTH) {
      // Awareness names and colors are presentation data, not authenticated identity.
      presenceIdentity = { displayName: value.displayName, color: value.color };
      localPresence = presenceIdentity;
    } else {
      throw new TypeError('Presence requires a short displayName and color');
    }
    publishLocalState();
  }

  function setLocalCursor(value) {
    if (value === null) {
      localCursor = null;
      cancelCursorTimer();
      lastCursorSentAt = now();
      publishLocalState();
      return;
    }
    localCursor = normalizePoint(value, 'cursor');
    scheduleCursor();
  }

  function setStrokePreview(value) {
    if (value === null) {
      localPreview = null;
      cancelPreviewTimer();
      lastPreviewSentAt = now();
      publishLocalState();
      return;
    }
    if (!value || typeof value !== 'object'
      || typeof value.tool !== 'string'
      || value.tool.length > MAX_PREVIEW_TOOL_LENGTH
      || !Array.isArray(value.points)
      || value.points.length > MAX_PREVIEW_POINTS) {
      throw new TypeError(`A stroke preview needs a tool and at most ${MAX_PREVIEW_POINTS} points`);
    }
    localPreview = {
      tool: value.tool,
      points: value.points.map((point) => normalizePoint(point, 'preview point')),
    };
    schedulePreview();
  }

  function emitRemoteState(clientId, state) {
    const next = state?.[PRESENCE_FIELD] ?? {};
    const previous = remote.get(clientId) ?? {};
    const user = next.user ?? null;
    const cursor = next.cursor ?? null;
    const preview = next.preview ?? null;

    if (!sameValue(previous.user, user)) {
      onEvent('peer-presence', {
        boardId,
        clientId,
        displayName: safeText(user?.displayName, MAX_DISPLAY_NAME_LENGTH),
        color: safeText(user?.color, MAX_COLOR_LENGTH),
        removed: state === null || user === null,
      });
    }
    if (!sameValue(previous.cursor, cursor)) {
      onEvent('peer-cursor', { boardId, clientId, ...(cursor ?? {}), removed: state === null || cursor === null });
    }
    if (!sameValue(previous.preview, preview)) {
      onEvent('peer-stroke-preview', {
        boardId,
        clientId,
        ...(preview ?? {}),
        removed: state === null || preview === null,
      });
    }

    if (state === null) remote.delete(clientId);
    else remote.set(clientId, { user, cursor, preview });
  }

  async function attachProvider(provider) {
    if (destroyed) return false;
    if (!provider) throw new TypeError('A y-webrtc provider is required');
    await provider.key;
    if (destroyed || releasedProviders.has(provider)) return false;
    const room = provider?.room;
    const state = provider?.awareness;
    const handler = room?._awarenessUpdateHandler;
    if (!room || !state || typeof handler !== 'function') {
      throw new Error('Installed y-webrtc Room Awareness hooks are unavailable');
    }
    detachProviderHooks();
    attachedProvider = provider;
    attachedRoom = room;
    awareness = state;
    originalAwarenessHandler = handler;
    peerOnlyAwarenessHandler = function peerOnlyAwarenessUpdate(changed, origin) {
      const wasBroadcastChannelConnected = room.bcconnected;
      room.bcconnected = false;
      try {
        originalAwarenessHandler.call(room, changed, origin);
      } finally {
        room.bcconnected = wasBroadcastChannelConnected;
      }
    };
    originalBcSubscriber = room._bcSubscriber;
    ignoredBcSubscriber = () => {};
    broadcastChannel.unsubscribe(room.name, originalBcSubscriber);
    room._bcSubscriber = ignoredBcSubscriber;
    room.bcconnected = false;
    awareness.off('update', originalAwarenessHandler);
    room._awarenessUpdateHandler = peerOnlyAwarenessHandler;
    awareness.on('update', peerOnlyAwarenessHandler);

    // Room.connect() briefly subscribes to BC and publishes an initial Yjs/awareness
    // snapshot directly. Reconnects clear spatial state first; remove the subscriber
    // immediately afterward and keep its BC-connected flag off for all live updates.
    originalConnect = room.connect;
    peerOnlyConnect = function peerOnlyRoomConnect(...args) {
      try {
        return originalConnect.apply(room, args);
      } finally {
        room.bcconnected = false;
        broadcastChannel.unsubscribe(room.name, ignoredBcSubscriber);
      }
    };
    room.connect = peerOnlyConnect;

    changeHandler = ({ added, updated, removed }) => {
      for (const clientId of [...added, ...updated, ...removed]) {
        if (clientId === awareness.clientID) continue;
        emitRemoteState(clientId, removed.includes(clientId) ? null : awareness.getStates().get(clientId));
      }
    };
    awareness.on('change', changeHandler);

    localCursor = null;
    localPreview = null;
    localPresence = presenceIdentity;
    publishingEnabled = true;
    publishLocalState();
    return true;
  }

  function releaseProvider(provider) {
    if (provider !== attachedProvider) {
      releasedProviders.add(provider);
      return () => {};
    }
    clearForDisconnect();
    return () => detachProviderHooks(provider);
  }

  function detachProviderHooks(provider) {
    if (!awareness) return;
    if (provider && provider !== attachedProvider) return;
    if (peerOnlyAwarenessHandler) {
      awareness.off('update', peerOnlyAwarenessHandler);
      if (attachedRoom && attachedRoom._awarenessUpdateHandler === peerOnlyAwarenessHandler) {
        attachedRoom._awarenessUpdateHandler = originalAwarenessHandler;
      }
    }
    if (ignoredBcSubscriber && attachedRoom) {
      broadcastChannel.unsubscribe(attachedRoom.name, ignoredBcSubscriber);
      if (attachedRoom._bcSubscriber === ignoredBcSubscriber) {
        attachedRoom._bcSubscriber = originalBcSubscriber;
      }
    }
    if (peerOnlyConnect && attachedRoom?.connect === peerOnlyConnect) {
      attachedRoom.connect = originalConnect;
    }
    if (changeHandler) awareness.off('change', changeHandler);
    awareness = null;
    attachedProvider = null;
    attachedRoom = null;
    originalAwarenessHandler = null;
    peerOnlyAwarenessHandler = null;
    originalBcSubscriber = null;
    ignoredBcSubscriber = null;
    originalConnect = null;
    peerOnlyConnect = null;
    changeHandler = null;
    remote.clear();
  }

  function clearForDisconnect() {
    cancelCursorTimer();
    cancelPreviewTimer();
    localPresence = null;
    localCursor = null;
    localPreview = null;
    lastCursorSentAt = Number.NEGATIVE_INFINITY;
    lastPreviewSentAt = Number.NEGATIVE_INFINITY;
    publishLocalState();
    publishingEnabled = false;
  }

  function resumeAfterConnect() {
    // Reapply only non-spatial identity after Room.connect() has sent its empty initial state.
    localCursor = null;
    localPreview = null;
    localPresence = presenceIdentity;
    publishingEnabled = true;
    publishLocalState();
  }

  function destroy() {
    if (destroyed) return;
    clearForDisconnect();
    presenceIdentity = null;
    destroyed = true;
  }

  return Object.freeze({
    attachProvider,
    clearForDisconnect,
    destroy,
    releaseProvider,
    resumeAfterConnect,
    setLocalPresence,
    setLocalCursor,
    setStrokePreview,
  });
}

function normalizePoint(value, label) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || Math.abs(value.x) > 10_000_000 || Math.abs(value.y) > 10_000_000) {
    throw new TypeError(`${label} coordinates must be finite and within the board range`);
  }
  return { x: value.x, y: value.y };
}

function safeText(value, maximumLength) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : null;
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
