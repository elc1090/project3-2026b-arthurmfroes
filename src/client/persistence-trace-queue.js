import { TRACE_LIMITS, traceBytes } from '../shared/persistence-trace.js';

export function openPersistenceTraceQueue(accountId, boardId, { indexedDB = globalThis.indexedDB, limits = {} } = {}) {
  const config = { ...TRACE_LIMITS, ...limits };
  const ready = new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('IndexedDB indisponível para o diagnóstico')); return; }
    const request = indexedDB.open(`whiteboard-trace:${accountId}:${boardId}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true }).createIndex('eventId', 'event.eventId', { unique: true });
      request.result.createObjectStore('state');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Fila de diagnóstico bloqueada por outra aba'));
  });
  let serial = Promise.resolve(); let closed = false;
  const run = (mode, fn) => {
    const result = serial.then(async () => {
      if (closed) throw new Error('Fila de diagnóstico fechada');
      const db = await ready;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['events', 'state'], mode); let result;
        fn(tx.objectStore('events'), tx.objectStore('state'), (value) => { result = value; });
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Falha na fila de diagnóstico'));
      });
    });
    serial = result.catch(() => {}); return result;
  };
  return {
    append(event) {
      return run('readwrite', (store, state, result) => {
        const existing = store.index('eventId').get(event.eventId);
        existing.onsuccess = () => {
          if (!existing.result) store.add({ event, byteLength: traceBytes(event) });
          const read = store.getAll(); read.onsuccess = () => {
            const rows = read.result; let bytes = rows.reduce((sum, row) => sum + row.byteLength, 0); let dropped = 0;
            while (rows.length > config.localEvents || bytes > config.localBytes) { const row = rows.shift(); store.delete(row.id); bytes -= row.byteLength; dropped++; }
            const count = state.get('dropped'); count.onsuccess = () => { state.put((count.result ?? 0) + dropped, 'dropped'); result({ dropped: (count.result ?? 0) + dropped, pending: rows.length }); };
          };
        };
      });
    },
    read() {
      return run('readonly', (store, state, result) => {
        const all = store.getAll(); all.onsuccess = () => {
          const events = [];
          for (const row of all.result) {
            if (events.length >= config.requestEvents || traceBytes({ events: [...events, row.event] }) > config.requestBytes) break;
            events.push(row.event);
          }
          const count = state.get('dropped'); count.onsuccess = () => result({ events, pending: all.result.length, dropped: count.result ?? 0 });
        };
      });
    },
    acknowledge(ids) {
      return run('readwrite', (store) => { for (const id of ids) { const read = store.index('eventId').getKey(id); read.onsuccess = () => { if (read.result !== undefined) store.delete(read.result); }; } });
    },
    async close() { await serial; closed = true; try { (await ready).close(); } catch { /* The failure was already reported by queue operations. */ } },
  };
}
