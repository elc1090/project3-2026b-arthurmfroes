const DEFAULT_LIMIT = 100;

/** Render the current replica's per-action transport and durability evidence. */
export function mountBoardSyncStatusUI({ session, container, limit = DEFAULT_LIMIT }) {
  if (!session || typeof session.subscribeSyncStatus !== 'function') throw new TypeError('A board session is required');
  if (!container || typeof container.append !== 'function') throw new TypeError('A status container is required');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');

  const root = document.createElement('section');
  root.className = 'board-sync-status';
  root.setAttribute('aria-label', 'Estado de sincronização por ação');
  const heading = document.createElement('h2');
  heading.textContent = 'Estado das ações';
  root.append(heading);
  const note = document.createElement('p');
  note.textContent = 'Recebido P2P indica chegada nesta réplica; VPS durável exige confirmação de persistência.';
  root.append(note);
  const table = document.createElement('table');
  table.className = 'board-sync-status__table';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Ação</th><th>Local</th><th>Recebido P2P</th><th>Recebido servidor</th><th>VPS durável</th><th>Estado</th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  table.append(body);
  root.append(table);
  container.append(root);

  let destroyed = false;
  let latestActions = [];
  const remoteEvidence = new Map();

  function render() {
    if (destroyed) return;
    const actions = new Map(latestActions.map((action) => [action.actionId, { ...action }]));
    for (const [actionId, evidence] of remoteEvidence) {
      const action = actions.get(actionId) ?? {
        actionId, local: false, peerReceived: false, serverReceived: false, durableServer: false,
      };
      action.serverReceived ||= evidence.serverReceived;
      action.durableServer ||= evidence.durableServer;
      actions.set(actionId, action);
    }
    const rows = [...actions.values()].slice(-limit).map((action) => {
      const row = document.createElement('tr');
      row.dataset.actionId = action.actionId;
      const id = document.createElement('td');
      id.textContent = action.actionId;
      const local = document.createElement('td');
      local.dataset.flag = 'local';
      local.textContent = action.local ? 'Sim' : '—';
      const peer = document.createElement('td');
      peer.dataset.flag = 'peer';
      peer.textContent = action.peerReceived ? 'Sim' : '—';
      const server = document.createElement('td');
      server.dataset.flag = 'server';
      server.textContent = action.serverReceived ? 'Sim' : '—';
      const durable = document.createElement('td');
      durable.dataset.flag = 'durable';
      durable.textContent = action.durableServer ? 'Sim' : '—';
      const state = document.createElement('td');
      state.dataset.flag = 'pending';
      const pending = action.peerReceived && !action.durableServer;
      state.textContent = pending ? 'Pendente na VPS' : action.durableServer ? 'Durável' : 'Aguardando evidência';
      if (pending) row.dataset.pending = 'true';
      row.append(id, local, peer, server, durable, state);
      return row;
    });
    body.replaceChildren(...rows);
  }

  const unsubscribe = session.subscribeSyncStatus((snapshot) => {
    latestActions = snapshot.actions;
    render();
  });

  return Object.freeze({
    appendEvent(type, detail = {}) {
      if (destroyed || !detail.actionId) return;
      if (type !== 'server-received' && type !== 'durable-persisted') return;
      const evidence = remoteEvidence.get(detail.actionId) ?? { serverReceived: false, durableServer: false };
      if (type === 'server-received') evidence.serverReceived = true;
      if (type === 'durable-persisted') {
        evidence.serverReceived = true;
        evidence.durableServer = true;
      }
      remoteEvidence.set(detail.actionId, evidence);
      while (remoteEvidence.size > limit) remoteEvidence.delete(remoteEvidence.keys().next().value);
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe?.();
      remoteEvidence.clear();
      root.remove();
    },
  });
}
