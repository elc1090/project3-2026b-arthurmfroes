import { TRACE_LIMITS, validateTraceEvent } from '../shared/persistence-trace.js';
import { openPersistenceTraceQueue } from './persistence-trace-queue.js';

/** Metadata collection belongs to the session, regardless of the visible panel. */
export function createPersistenceTrace(boardId, docClientId, {
  accountId, username, fetchImpl = globalThis.fetch, locationHref = globalThis.location?.href,
  onStatus = () => {}, metrics = null, intervalMs = 10000, queueOptions, now = () => Date.now(), monotonic = () => performance.now(),
} = {}) {
  const traceSessionId = crypto.randomUUID(); let sequence = 0; let queue = null;
  let destroyed = false; let denied = false; let busy = false; let controller = null;
  let lastAttempt = -Infinity; let retryAt = 0; let retry = 0; let droppedReported = 0;
  let status = { available: true, pending: 0, dropped: 0, error: null, username: username ?? 'Você', traceSessionId };
  const url = new URL(`/api/boards/${encodeURIComponent(boardId)}/persistence-trace`, locationHref);
  const listeners = new Set(); const recent = []; const staged = [];
  function publish(change) { if (destroyed) return; status = { ...status, ...change }; onStatus(status); for (const fn of listeners) fn(status); }
  const initialized = (async () => {
    if (!accountId) {
      const response = await fetchImpl(new URL('/api/auth/session', locationHref), { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok || !data.authenticated) { denied = true; throw new Error('Sessão indisponível para o diagnóstico'); }
      accountId = data.account.id; username = data.account.username;
    }
    if (destroyed) return;
    queue = openPersistenceTraceQueue(accountId, boardId, queueOptions);
    for (const e of staged.splice(0)) await append(e);
    const stored = await queue.read(); publish({ ...stored, username: username ?? 'Você' });
  })().catch((error) => publish({ available: false, error: error.message }));
  async function append(event) {
    try {
      const result = await queue.append(event); publish({ ...result, available: true, error: null });
      if (result.dropped > droppedReported && event.type !== 'trace-gap') {
        const dropped = result.dropped - droppedReported; droppedReported = result.dropped;
        record('trace-gap', { data: { dropped, reason: 'local-retention' } });
      }
    } catch (error) { publish({ available: false, error: error.message }); }
  }
  function record(type, detail = {}) {
    if (destroyed || denied) return null;
    const event = { version: 1, eventId: crypto.randomUUID(), boardId, traceSessionId, docClientId: String(docClientId), sequence: ++sequence,
      type, observedAt: new Date(now()).toISOString(), monotonicMs: monotonic(), ...detail, data: detail.data ?? {} };
    try { validateTraceEvent(event); } catch (error) { publish({ available: false, error: error.message }); return null; }
    recent.push(event); if (recent.length > 200) recent.shift();
    if (queue) void append(event); else if (staged.length < TRACE_LIMITS.localEvents) staged.push(event);
    else publish({ dropped: status.dropped + 1, available: false, error: 'Limite local do diagnóstico atingido' });
    return event;
  }
  async function flush({ reconnect = false } = {}) {
    await initialized;
    if (!queue || destroyed || denied || busy || now() < retryAt || (!reconnect && retry === 0 && now() - lastAttempt < intervalMs)) return;
    busy = true; controller = new AbortController(); let timeout;
    try {
      const stored = await queue.read(); publish(stored);
      if (!stored.events.length || destroyed) return;
      lastAttempt = now(); const body = JSON.stringify({ events: stored.events });
      try { metrics?.recordDiagnostic('sent', body); } catch {}
      timeout = setTimeout(() => controller?.abort(), 4000);
      const response = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
      if ([401, 403, 404].includes(response.status)) { denied = true; throw new Error('Acesso ao diagnóstico encerrado'); }
      if (!response.ok) throw new Error(`Diagnóstico HTTP ${response.status}`);
      const payload = await response.text(); try { metrics?.recordDiagnostic('received', payload); } catch {}
      const data = JSON.parse(payload);
      const known = new Set(stored.events.map((e) => e.eventId));
      if (!Array.isArray(data.accepted) || !Array.isArray(data.expired) || [...data.accepted, ...data.expired].some((id) => !known.has(id))) throw new Error('Confirmação de coleta inválida');
      await queue.acknowledge([...data.accepted, ...data.expired]); retry = 0; retryAt = 0;
      const current = await queue.read(); publish({ ...current, available: true, error: null, lastCollectedAt: new Date(now()).toISOString(), expired: data.expired.length });
    } catch (error) {
      if (!destroyed) { const waits = [1000, 2000, 5000, 10000, 30000]; retryAt = now() + waits[Math.min(retry++, waits.length - 1)]; publish({ available: false, error: error.message }); }
    } finally { clearTimeout(timeout); controller = null; busy = false; }
  }
  const timer = setInterval(() => { void flush(); }, Math.min(intervalMs, 1000));
  const online = () => { retryAt = 0; void flush({ reconnect: true }); };
  globalThis.addEventListener?.('online', online);
  return Object.freeze({
    record, flush, get status() { return { ...status }; }, get recent() { return recent.slice(); }, get identity() { return { accountId, username, traceSessionId }; },
    subscribe(fn) { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); },
    async destroy() {
      if (destroyed) return;
      destroyed = true; controller?.abort(); clearInterval(timer); globalThis.removeEventListener?.('online', online); listeners.clear();
      await initialized; await queue?.close();
    },
  });
}
