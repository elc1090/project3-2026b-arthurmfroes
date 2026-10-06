const DEFAULT_LIMIT = 100;

/** Mount a replica-local event timeline. Its order and timestamps are local observations. */
export function mountBoardTimelineUI({ session, container, limit = DEFAULT_LIMIT }) {
  if (!session || typeof session.on !== 'function') throw new TypeError('A board session is required');
  if (!container || typeof container.append !== 'function') throw new TypeError('A timeline container is required');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');

  const root = document.createElement('section');
  root.className = 'board-timeline';
  root.setAttribute('aria-label', 'Linha do tempo de sincronização');

  const heading = document.createElement('h2');
  heading.textContent = 'Eventos observados nesta réplica';
  root.append(heading);

  const note = document.createElement('p');
  note.textContent = 'Ordem, sequência e horário refletem a observação local desta réplica; não formam uma ordem global.';
  root.append(note);

  const list = document.createElement('ol');
  list.className = 'board-timeline__events';
  list.setAttribute('aria-live', 'polite');
  list.setAttribute('aria-relevant', 'additions');
  root.append(list);
  container.append(root);

  const observedSizes = new Map();
  const unsubscriptions = [];
  let destroyed = false;

  function render(type, detail = {}) {
    if (destroyed) return;
    const item = describeEvent(type, detail, observedSizes);
    if (!item) return;

    const row = document.createElement('li');
    row.dataset.eventType = item.kind;
    if (Number.isSafeInteger(detail.sequence)) row.dataset.sequence = String(detail.sequence);

    const summary = document.createElement('p');
    summary.textContent = `${item.label} · réplica ${detail.replicaId ?? 'desconhecida'} · sequência ${detail.sequence ?? 'indisponível'} · ${detail.observedAt ?? 'horário indisponível'} (relógio local)`;
    row.append(summary);

    const updateId = detail.actionId;
    if (updateId) {
      const id = document.createElement('code');
      id.dataset.field = 'action-id';
      id.textContent = `ID do update: ${updateId}`;
      row.append(id);
    }

    const size = item.updateBytes;
    const sizeLine = document.createElement('p');
    sizeLine.dataset.field = 'update-bytes';
    sizeLine.textContent = `Tamanho: ${Number.isSafeInteger(size) && size >= 0 ? `${size} bytes` : 'indisponível'}`;
    row.append(sizeLine);

    if (item.firstArrivalPath) {
      const path = document.createElement('p');
      path.dataset.field = 'first-arrival-path';
      path.textContent = `Primeira chegada observada: ${item.firstArrivalPath}`;
      row.append(path);
    }

    if (detail.updateId) {
      const serverUpdateId = document.createElement('p');
      serverUpdateId.dataset.field = 'server-update-id';
      serverUpdateId.textContent = `ID de transporte: ${detail.updateId}`;
      row.append(serverUpdateId);
    }

    list.append(row);
    while (list.children.length > limit) list.firstElementChild.remove();
  }

  for (const type of ['update-observed', 'sync-batch', 'durable-ack']) {
    unsubscriptions.push(session.on(type, detail => render(type, detail)));
  }

  return Object.freeze({
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const unsubscribe of unsubscriptions) unsubscribe?.();
      root.remove();
      observedSizes.clear();
    },
  });
}

function describeEvent(type, detail, observedSizes) {
  if (type === 'update-observed') {
    if (detail.actionId && Number.isSafeInteger(detail.updateBytes)) {
      observedSizes.set(detail.actionId, detail.updateBytes);
    }
    return {
      kind: `update-${detail.sourcePath ?? 'unknown'}`,
      label: labelForSource(detail.sourcePath, detail.actionKind),
      updateBytes: detail.updateBytes,
      firstArrivalPath: detail.firstArrivalPath,
    };
  }

  if (type === 'sync-batch') {
    return {
      kind: 'sync-batch',
      label: `Lote de sincronização recebido via ${detail.sourcePath ?? 'origem desconhecida'}`,
      updateBytes: detail.updateBytes,
      firstArrivalPath: detail.firstArrivalPath,
    };
  }

  if (type === 'durable-ack') {
    return {
      kind: 'durable-ack',
      label: 'Servidor confirmou persistência',
      updateBytes: detail.updateBytes ?? observedSizes.get(detail.actionId),
      firstArrivalPath: detail.firstArrivalPath,
    };
  }

  return null;
}

function labelForSource(sourcePath, actionKind) {
  if (sourcePath === 'local') return `Edição local${actionKind ? ` (${actionKind})` : ''}`;
  if (sourcePath === 'peer-room') return 'Update recebido por P2P';
  if (sourcePath === 'server') return 'Update recebido do servidor';
  return `Update observado via ${sourcePath ?? 'origem desconhecida'}`;
}
