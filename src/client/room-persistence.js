import * as Y from 'yjs';
import { coversUpdate, decodeBytes, encodeBytes, updateDigest, verifyReceipt } from '../shared/persistence-coverage.js';

const FIELD = 'roomPersistence';
export const PERSISTENCE_DEFAULTS = Object.freeze({ batchMs: 1000, ackMs: 4000, mandateMs: 30000, staleMs: 6000, recoveryMs: 8000, tickMs: 250 });
const SERVER_ORIGIN = Symbol('room-server-update');

/** One normal sender per connected peer component; direct recovery is always available. */
export function createRoomPersistence(doc, boardId, {
  fetchImpl = globalThis.fetch,
  locationHref = globalThis.location?.href,
  initialServerPaused = false,
  onEvent = () => {},
  eventTracker = null,
  experimentMetrics = null,
  trace = null,
  monotonic = () => performance.now(),
  timing = {},
  now = () => Date.now(),
  random = () => crypto.getRandomValues(new Uint32Array(1))[0],
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  const times = { ...PERSISTENCE_DEFAULTS, ...timing };
  for (const value of Object.values(times)) if (!Number.isFinite(value) || value <= 0) throw new TypeError('Persistence intervals must be positive');
  const url = new URL(`/api/boards/${encodeURIComponent(boardId)}/persistence`, locationHref);
  const serverVector = new Map();
  const pending = new Map();
  const candidates = new Map();
  const rejected = new Set();
  const verified = new Set();
  const tracedReceipts = new Set();
  const withdrawn = new Map();
  let awareness = null;
  let provider = null;
  let publicKey = null;
  let paused = initialServerPaused;
  let peerEnabled = true;
  let destroyed = false;
  let revoked = false;
  let busy = false;
  let controller = null;
  let key = 0;
  let receipt = null;
  let failed = null;
  let retryBatch = null;
  let eligibleAt = 0;
  let candidate = freshCandidate();
  let elected = null;
  let lastAttempt = -Infinity;
  let lastContact = -Infinity;
  let nextAttempt = 0;
  let needsRefresh = true;
  let currentStatus = paused ? 'paused' : 'connecting';
  let latestSnapshot = null;
  let electionViewId = null;
  let lastView = null;
  let lastViewKey = '';
  const log = (type, detail = {}) => { try { return trace?.record(type, detail); } catch { return null; } };
  const describe = (c, eligible, reason) => ({ id: c.id, token: c.token, priority: c.priority, eligible, reason });
  const draw = (reason) => {
    candidate = freshCandidate();
    log('candidate-drawn', { candidateToken: candidate.token, data: { candidate: describe(candidate, true, reason), reason } });
  };
  log('candidate-drawn', { candidateToken: candidate.token, data: { candidate: describe(candidate, !paused, 'initial'), reason: 'initial' } });

  function freshCandidate() { return { id: String(doc.clientID), token: crypto.randomUUID(), priority: random(), born: now() }; }
  function setStatus(status) {
    if (currentStatus !== status) { currentStatus = status; onEvent('server-status', status); }
  }
  function oldestPending() {
    let oldest = Infinity;
    for (const item of pending.values()) oldest = Math.min(oldest, item.since);
    return oldest;
  }
  function snapshot() {
    return { representative: elected, self: candidate.id, role: elected === candidate.id ? 'representative' : 'follower', pending: pending.size, recovering: pending.size > 0 && now() - oldestPending() >= times.recoveryMs, paused, batchMs: times.batchMs, electionViewId, election: lastView };
  }
  function publishStatus() {
    const next = snapshot();
    if (JSON.stringify(next) !== JSON.stringify(latestSnapshot)) { latestSnapshot = next; onEvent('persistence-status', next); }
  }
  function publish() {
    if (!awareness || destroyed) return;
    const available = !paused && !revoked && peerEnabled && now() >= eligibleAt;
    awareness.setLocalStateField(FIELD, { candidate: available ? candidate : null, heartbeat: ++key, failed, receipt });
  }
  function elect(reason = 'view-changed') {
    const available = !paused && !revoked && now() >= eligibleAt ? [candidate] : [];
    if (peerEnabled) for (const value of candidates.values()) {
      if (now() - value.seen < times.staleMs && !rejected.has(value.candidate.token)) available.push(value.candidate);
    }
    available.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const next = available[0]?.id ?? null;
    if (trace) {
      const view = [describe(candidate, !paused && !revoked && now() >= eligibleAt, paused ? 'paused' : revoked ? 'revoked' : now() < eligibleAt ? 'cooldown' : 'available')];
      if (peerEnabled) for (const value of candidates.values()) {
        const expired = now() - value.seen >= times.staleMs;
        const failed = rejected.has(value.candidate.token);
        view.push(describe(value.candidate, !expired && !failed, expired ? 'expired' : failed ? 'failed' : 'available'));
      }
      for (const c of withdrawn.values()) if (!view.some((v) => v.id === c.id)) view.push(c);
      view.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      const material = JSON.stringify({ candidates: view, representative: next });
      if (material !== lastViewKey) {
        const prior = lastView;
        lastViewKey = material; electionViewId = crypto.randomUUID();
        const why = reason === 'view-changed' && view.some((c) => c.reason === 'expired') && !prior?.candidates.some((c) => c.reason === 'expired') ? 'presence-expired' : reason;
        lastView = { candidates: view, representative: next, reason: why, rule: 'lowest-priority-then-id' };
        log('election-view', { electionViewId, candidateToken: candidate.token, data: lastView });
      }
    }
    if (next !== elected) {
      elected = next;
      if (next === candidate.id) needsRefresh = true;
      onEvent('persistence-election', { representative: elected, self: candidate.id });
    }
  }
  function observe(bytes, origin) {
    if (origin === SERVER_ORIGIN || destroyed || bytes.byteLength <= 2) return;
    pending.set(crypto.randomUUID(), { bytes: bytes.slice(), since: now() });
    publishStatus();
  }
  doc.on('update', observe);
  // Reopened IndexedDB content has no in-memory pending queue; recover it as a batch.
  const restored = Y.encodeStateAsUpdate(doc);
  if (restored.byteLength > 2) observe(restored);

  async function acceptReceipt(value, fromPeer = false, attempt = null) {
    if (destroyed || paused || revoked || !publicKey || !value?.signature || verified.has(value.signature)) return false;
    const receiptId = trace ? await updateDigest(new TextEncoder().encode(String(value.signature).slice(0, 256))) : null;
    const batchId = value.payload?.boardId === boardId && typeof value.payload?.batchId === 'string' ? value.payload.batchId : attempt?.batchId;
    const context = { ...(batchId ? { batchId } : {}), ...(receiptId ? { receiptId } : {}), ...(attempt ? { attemptId: attempt.id, electionViewId: attempt.view } : {}) };
    const path = fromPeer ? 'peer' : 'server';
    const observationKey = `${value.signature}:received`;
    const firstObservation = !tracedReceipts.has(observationKey);
    if (batchId && firstObservation) {
      tracedReceipts.add(observationKey);
      if (tracedReceipts.size > 128) tracedReceipts.delete(tracedReceipts.values().next().value);
      log('ack-received', { ...context, data: { path, ...(attempt ? { elapsedMs: Math.max(0, monotonic() - attempt.started) } : {}) } });
    }
    if (!await verifyReceipt(value, publicKey, boardId)) {
      if (!tracedReceipts.has(`${value.signature}:rejected`)) { tracedReceipts.add(`${value.signature}:rejected`); log('ack-rejected', { ...context, data: { path, reason: 'invalid-receipt' } }); }
      return false;
    }
    if (destroyed || paused || revoked || verified.has(value.signature)) return false;
    for (const [client, clock] of Object.entries(value.payload.coverage.vector)) {
      serverVector.set(Number(client), Math.max(serverVector.get(Number(client)) ?? 0, clock));
    }
    verified.add(value.signature);
    if (verified.size > 128) verified.delete(verified.values().next().value);
    const pendingBefore = pending.size;
    for (const [id, item] of pending) {
      if (!coversUpdate(value.payload.coverage, item.bytes)) continue;
      pending.delete(id);
      const detail = { boardId, updateId: value.payload.batchId, committedAt: value.payload.committedAt, actionId: await updateDigest(item.bytes), sourcePath: fromPeer ? 'peer-receipt' : 'server', receiptSignature: value.signature };
      if (destroyed) return false;
      const event = eventTracker ? eventTracker.emit('durable-ack', detail) : detail;
      onEvent('durable-ack', event);
    }
    if (batchId) log('ack-verified', { ...context, data: { path, confirmedUpdates: pendingBefore - pending.size, remainingUpdates: pending.size,
      ...(attempt ? { elapsedMs: Math.max(0, monotonic() - attempt.started) } : {}) } });
    // Forward the authenticated receipt through the existing peer mesh.
    if (receipt?.signature !== value.signature) { receipt = value; publish(); if (batchId && awareness && peerEnabled) log('receipt-forwarded', { ...context, data: { path: 'peer' } }); }
    publishStatus();
    return true;
  }

  function onAwareness({ added, updated, removed }) {
    if (!awareness || !peerEnabled) return;
    for (const id of removed) { const old = candidates.get(id); if (old) withdrawn.set(String(id), describe(old.candidate, false, 'peer-left')); candidates.delete(id); }
    for (const id of [...added, ...updated]) {
      if (id === awareness.clientID) continue;
      const state = awareness.getStates().get(id)?.[FIELD];
      const c = state?.candidate;
      if (c && typeof c.id === 'string' && c.id === String(id) && typeof c.token === 'string' && Number.isFinite(c.priority)) {
        const old = candidates.get(id);
        withdrawn.delete(String(id));
        candidates.set(id, { candidate: c, seen: old?.heartbeat === state.heartbeat ? old.seen : now(), heartbeat: state.heartbeat });
      } else { const old = candidates.get(id); if (old) withdrawn.set(String(id), describe(old.candidate, false, 'withdrawn')); candidates.delete(id); }
      if (typeof state?.failed === 'string') {
        rejected.add(state.failed);
        if (rejected.size > 128) rejected.delete(rejected.values().next().value);
      }
      if (state?.receipt) void acceptReceipt(state.receipt, true).catch((error) => onEvent('error', error));
    }
    while (withdrawn.size > 64) withdrawn.delete(withdrawn.keys().next().value);
    elect(removed.length ? 'peer-left' : 'peer-view-changed'); publishStatus();
  }

  async function exchange(batch = null) {
    controller = new AbortController();
    let deadline; let attempt = null; let timedOut = false;
    if (batch && trace) {
      const digest = await updateDigest(batch.bytes);
      attempt = { id: crypto.randomUUID(), batchId: batch.id, view: electionViewId ?? crypto.randomUUID(), started: monotonic() };
      log('batch-send', { batchId: batch.id, attemptId: attempt.id, electionViewId: attempt.view,
        data: { updateBytes: batch.bytes.byteLength, digest, reason: !peerEnabled || elected !== candidate.id ? 'direct-recovery' : 'representative', retry: Boolean(batch.attempted) } });
      batch.attempted = true;
    }
    const request = (async () => {
      const body = { stateVector: encodeBytes(Y.encodeStateVector(doc)), ...(batch ? { batchId: batch.id, update: encodeBytes(batch.bytes) } : {}), ...(attempt ? { trace: { attemptId: attempt.id, electionViewId: attempt.view, traceSessionId: trace.identity.traceSessionId, docClientId: String(doc.clientID) } } : {}) };
      const serialized = JSON.stringify(body);
      try { experimentMetrics?.recordHttp('sent', serialized, body); } catch {}
      const response = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: serialized, signal: controller.signal });
      if ([401, 403, 404].includes(response.status)) {
        revoked = true; publish();
        onEvent(response.status === 401 ? 'session-expired' : 'membership-revoked', { boardId, source: 'persistence' });
        throw new Error('Board persistence access denied');
      }
      if (!response.ok) throw new Error(`Persistence HTTP ${response.status}`);
      const payload = await response.text();
      const data = JSON.parse(payload);
      try { experimentMetrics?.recordHttp('received', payload, data); } catch {}
      if (attempt && data.receipt?.signature) {
        const receiptId = await updateDigest(new TextEncoder().encode(String(data.receipt.signature).slice(0, 256)));
        tracedReceipts.add(`${data.receipt.signature}:received`);
        log('ack-received', { batchId: batch.id, attemptId: attempt.id, electionViewId: attempt.view, receiptId,
          data: { path: 'server', elapsedMs: Math.max(0, monotonic() - attempt.started) } });
      }
      return data;
    })();
    try {
      const data = await Promise.race([request, new Promise((_, reject) => {
        deadline = setTimeout(() => { timedOut = true; controller?.abort(); reject(new Error('Persistence acknowledgment timed out')); }, times.ackMs);
      })]);
      if (destroyed || paused || revoked) return false;
      // Only the authenticated same-origin response supplies verification keys.
      publicKey = await crypto.subtle.importKey('jwk', data.key, 'Ed25519', false, ['verify']);
      if (!await verifyReceipt(data.receipt, publicKey, boardId)) { await acceptReceipt(data.receipt, false, attempt); throw new Error('Invalid server persistence receipt'); }
      if (destroyed || paused || revoked) return false;
      const remote = decodeBytes(data.update);
      if (remote.byteLength > 2 && eventTracker) {
        if (lastContact === -Infinity) await eventTracker.observeSyncBatch(remote, { sourcePath: 'server', state: 'persistence-bootstrap' });
        else await eventTracker.observeUpdate(remote, { sourcePath: 'server', actionKind: 'server-update' });
      }
      if (destroyed || paused || revoked) return false;
      Y.applyUpdate(doc, remote, SERVER_ORIGIN);
      await acceptReceipt(data.receipt, false, attempt);
      if (!batch && retryBatch && coversUpdate(data.receipt.payload.coverage, retryBatch.bytes)) retryBatch = null;
      lastContact = now(); needsRefresh = false; nextAttempt = 0;
      setStatus('connected');
      return true;
    } catch (error) {
      if (attempt) log('attempt-failed', { batchId: batch.id, attemptId: attempt.id, electionViewId: attempt.view,
        data: { reason: paused || destroyed ? 'cancelled' : revoked ? 'access-denied' : timedOut ? 'timeout' : 'request-failed', elapsedMs: Math.max(0, monotonic() - attempt.started) } });
      throw error;
    } finally { clearTimeout(deadline); controller = null; }
  }

  async function tick() {
    if (destroyed || revoked) return;
    if (now() - candidate.born >= times.mandateMs) { draw('mandate-renewed'); publish(); }
    elect(); publishStatus();
    if (paused || busy || now() < nextAttempt) return;
    const oldest = Math.min(...[...pending.values()].map((item) => item.since), Infinity);
    const isRepresentative = elected === candidate.id;
    const recovery = now() - oldest >= times.recoveryMs;
    const isolated = !peerEnabled || candidates.size === 0;
    const pollDue = (isRepresentative || isolated) && now() - lastContact >= times.recoveryMs;
    if (!needsRefresh && !pollDue && !(pending.size && (isRepresentative || recovery))) return;
    if (now() - lastAttempt < times.batchMs) return;
    busy = true; lastAttempt = now();
    try {
      if (needsRefresh || pollDue && !pending.size) { await exchange(); }
      else {
        if (!retryBatch) {
          const bytes = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(serverVector));
          retryBatch = { id: crypto.randomUUID(), bytes };
        }
        if (await exchange(retryBatch)) retryBatch = null;
      }
    } catch (error) {
      if (!destroyed && !paused && !revoked) {
        failed = candidate.token; rejected.add(failed);
        draw('request-failed'); eligibleAt = now() + times.staleMs;
        nextAttempt = now() + times.batchMs; needsRefresh = true;
        setStatus('disconnected'); onEvent('error', error); publish();
      }
    } finally { busy = false; publishStatus(); }
  }

  const timer = schedule(() => { publish(); void tick(); }, times.tickMs);
  void tick();
  return Object.freeze({
    origin: SERVER_ORIGIN,
    get status() { return currentStatus; },
    get persistenceStatus() { return snapshot(); },
    attachProvider(nextProvider) {
      if (destroyed || revoked) return;
      this.detachProvider(); provider = nextProvider; awareness = provider.awareness;
      awareness.on('change', onAwareness);
      onAwareness({ added: [...awareness.getStates().keys()], updated: [], removed: [] });
      publish();
    },
    detachProvider(previous = provider) {
      if (previous !== provider || !awareness) return;
      awareness.off('change', onAwareness); awareness.setLocalStateField(FIELD, null);
      awareness = null; provider = null; candidates.clear(); elect();
    },
    setPeerEnabled(value) { peerEnabled = value; candidates.clear(); withdrawn.clear(); publish(); elect(value ? 'peer-resumed' : 'peer-paused'); publishStatus(); },
    pause() { paused = true; controller?.abort(); setStatus('paused'); publish(); elect('server-paused'); publishStatus(); },
    resume() { if (destroyed || revoked) return; paused = false; needsRefresh = true; nextAttempt = 0; setStatus('connecting'); publish(); elect('server-resumed'); void tick(); },
    destroy() {
      if (destroyed) return;
      this.detachProvider(); destroyed = true; controller?.abort(); cancel(timer);
      doc.off('update', observe); candidates.clear(); pending.clear();
    },
    // Exposed for deterministic protocol tests; normal operation uses the timer.
    tick,
  });
}
