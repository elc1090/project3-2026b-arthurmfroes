const reasons = {
  initial: 'início da candidatura', available: 'disponível', paused: 'VPS pausada nesta aba', revoked: 'acesso encerrado', cooldown: 'aguardando após falha',
  expired: 'sem sinal recente', failed: 'candidatura com falha', withdrawn: 'candidatura retirada', 'peer-left': 'participante saiu',
  'peer-view-changed': 'mudança nos candidatos conhecidos', 'presence-expired': 'presença expirou', 'view-changed': 'mudança na escolha',
  'mandate-renewed': 'novo sorteio após o mandato', 'request-failed': 'falha no envio', 'peer-resumed': 'P2P retomado', 'peer-paused': 'P2P pausado',
  'server-paused': 'VPS pausada nesta aba', 'server-resumed': 'VPS retomada nesta aba', representative: 'representante escolhido nesta visão',
  'direct-recovery': 'recuperação direta, sem depender do representante', timeout: 'prazo do ACK expirou', cancelled: 'tentativa cancelada nesta aba',
  'access-denied': 'acesso encerrado', 'invalid-receipt': 'assinatura ou quadro inválido', 'local-retention': 'limite da fila local',
};
const labels = { 'candidate-drawn': 'Número sorteado', 'election-view': 'Representante escolhido nesta visão', 'batch-send': 'Lote enviado',
  'attempt-failed': 'Tentativa interrompida', 'server-received': 'VPS recebeu a tentativa', 'server-committed': 'VPS confirmou a gravação',
  'server-ack-sent': 'VPS emitiu a resposta ACK', 'ack-received': 'ACK recebido', 'ack-verified': 'ACK verificado',
  'ack-rejected': 'ACK rejeitado', 'receipt-forwarded': 'Recibo disponibilizado aos peers', 'trace-gap': 'Lacuna na coleta' };
const phrase = (reason) => reasons[reason] ?? reason ?? 'motivo não informado';
const time = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('pt-BR', { hour12: false }) : 'horário não registrado';
const size = (value) => Number.isFinite(value) ? `${value.toLocaleString('pt-BR')} B` : 'tamanho indisponível';

export function mountPersistenceHistory({ session, container, boardId, fetchImpl = globalThis.fetch, isActive = () => container.getClientRects().length > 0, intervalMs = 2000 }) {
  const doc = container.ownerDocument;
  const element = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const root = element('section', undefined, 'persistence-history'); root.setAttribute('aria-label', 'Eleição e persistência');
  const title = element('h2', 'Eleição e persistência');
  const representative = element('p'); representative.dataset.traceRepresentative = '';
  const collection = element('p'); collection.dataset.traceCollection = ''; collection.setAttribute('role', 'status');
  const notice = element('p'); notice.dataset.traceNotice = '';
  const current = element('details'); current.append(element('summary', 'Ver números do sorteio atual'));
  const currentView = element('div'); current.append(currentView);
  const controls = element('div', undefined, 'trace-filters');
  const batch = element('input'); batch.type = 'search'; batch.placeholder = 'ID do lote'; batch.setAttribute('aria-label', 'Filtrar por lote');
  const participant = element('select'); participant.setAttribute('aria-label', 'Filtrar por participante');
  const search = element('button', 'Filtrar'); search.type = 'button';
  const clear = element('button', 'Limpar filtros'); clear.type = 'button';
  const batchLabel = element('label', 'Lote '); batchLabel.append(batch);
  const participantLabel = element('label', 'Participante '); participantLabel.append(participant);
  controls.append(batchLabel, participantLabel, search, clear);
  const list = element('div'); list.dataset.traceBatches = '';
  const elections = element('details'); elections.append(element('summary', 'Visões da eleição e sorteios recentes'));
  const electionList = element('div'); elections.append(electionList);
  const comparison = element('div', undefined, 'trace-comparison'); comparison.setAttribute('aria-label', 'Comparação de visões eleitorais');
  const more = element('button', 'Carregar histórico anterior'); more.type = 'button';
  root.append(title, representative, collection, notice, current, controls, list, elections, comparison, more); container.append(root);
  let destroyed = false; let busy = false; let generation = 0; let controller = null; let error = null;
  let lastUpdate = null; let cursor = null; let batchCursor = null; let dropped = 0; let paginationInitialized = false;
  let filters = { batchId: '', participant: '' };
  const rows = new Map(); const batches = new Map(); const people = new Map(); const open = new Set(); const loadedDetails = new Set(); const comparedViews = new Map();
  const eventKey = (row) => `${row.source}:${row.accountId ?? 'self'}:${row.event.eventId}`;
  function name(clientId, fallback) {
    if (String(clientId) === String(session.doc.clientID)) return session.persistenceTrace?.identity.username || fallback || 'Você';
    return people.get(String(clientId))?.username || fallback || 'Participante não identificado';
  }
  function localRows() {
    return (session.persistenceTrace?.recent ?? []).map((event) => ({ id: 0, source: 'client', local: true,
      accountId: session.persistenceTrace.identity.accountId, username: session.persistenceTrace.identity.username || 'Você', event }));
  }
  function allRows() {
    const merged = new Map();
    for (const row of localRows()) if (!filters.participant || row.accountId === filters.participant) merged.set(eventKey(row), row);
    for (const [key, row] of rows) merged.set(key, row);
    return [...merged.values()].filter((row) => !filters.batchId || row.event.batchId === filters.batchId || row.event.type === 'election-view');
  }
  function detailsKey(node, key) {
    node.open = open.has(key);
    const summary = node.querySelector(':scope > summary');
    if (summary) summary.dataset.traceFocus = `${key}:summary`;
    node.addEventListener('toggle', () => { if (node.open) open.add(key); else open.delete(key); });
  }
  function election(row) {
    const event = row.event; const wrapper = element('div', undefined, 'trace-election');
    wrapper.append(element('p', `Visão de ${row.username || name(event.docClientId)} · ${phrase(event.data.reason)}`));
    const table = element('table'); table.className = 'trace-candidates';
    const head = element('thead'); const tr = element('tr'); ['Participante / aba', 'Número sorteado', 'Situação'].forEach((s) => tr.append(element('th', s))); head.append(tr); table.append(head);
    const body = element('tbody');
    for (const candidate of event.data.candidates ?? []) {
      const line = element('tr');
      const winner = candidate.id === event.data.representative;
      line.append(element('td', `${name(candidate.id, candidate.id === event.docClientId ? row.username : null)} · aba ${candidate.id.slice(-4)}`),
        element('td', candidate.priority.toLocaleString('pt-BR', { useGrouping: false })),
        element('td', `${winner ? 'Escolhido · ' : ''}${candidate.eligible ? 'elegível' : phrase(candidate.reason)}`));
      body.append(line);
    }
    table.append(body); wrapper.append(table);
    const eligible = (event.data.candidates ?? []).filter((c) => c.eligible).sort((a,b) => a.priority - b.priority || a.id.localeCompare(b.id));
    wrapper.append(element('p', eligible[0] && eligible[1]?.priority === eligible[0].priority
      ? 'Números empatados. O ID da aba desempatou a escolha.' : 'O menor número entre os candidatos elegíveis vence.'));
    wrapper.append(element('small', 'Números relatados pelos participantes. Esta visão não prova uma eleição global.'));
    return wrapper;
  }
  function renderStatus() {
    const state = session.persistenceStatus;
    representative.textContent = `Representante visto nesta aba: ${state?.representative ? name(state.representative) : 'nenhum disponível'}. ${phrase(state?.election?.reason)}.`;
    const status = session.persistenceTrace?.status;
    collection.textContent = `Coleta: ${status?.available === false ? 'indisponível' : 'ativa'} · ${status?.pending ?? 0} eventos aguardando envio${status?.dropped ? ` · ${status.dropped} descartados na fila local` : ''}${status?.expired ? ` · ${status.expired} já expirados no servidor` : ''}.${status?.error ? ` ${status.error}.` : ''}`;
    notice.textContent = `${error ? `${error}. Dados já carregados foram preservados. ` : ''}${dropped ? `${dropped} registros expiraram pela retenção; o histórico pode estar incompleto. ` : ''}${lastUpdate ? `Última consulta: ${time(lastUpdate)}. ` : ''}Horários pertencem a quem observou. Ausência de registro não prova ausência de ACK.`;
    if (state?.election) currentView.replaceChildren(election({ username: session.persistenceTrace?.identity.username || 'Você', event: { docClientId: String(session.doc.clientID), data: state.election } }));
  }
  function eventLine(row) {
    const event = row.event; const line = element('li', undefined, 'trace-stage'); line.dataset.traceType = event.type;
    const source = row.source === 'server' ? 'Fato observado pela VPS' : `Relato de ${row.username} · aba ${event.docClientId.slice(-4)}${row.local ? ' · ainda não coletado' : ''}`;
    line.append(element('strong', labels[event.type] ?? 'Evento de diagnóstico'));
    let text = source;
    if (event.type === 'candidate-drawn') text += ` · número ${event.data.candidate?.priority ?? 'não informado'} · ${phrase(event.data.reason)}`;
    if (event.type === 'batch-send') text += ` · ${phrase(event.data.reason)} · ${size(event.data.updateBytes)}${event.data.retry ? ' · retry do mesmo lote' : ''}`;
    if (event.type === 'attempt-failed') text += ` · ${phrase(event.data.reason)}`;
    if (event.type === 'server-committed') text += event.data.deduplicated ? ' · lote já persistido; sem nova gravação' : ' · COMMIT concluído';
    if (event.type.startsWith('ack-')) text += ` · ${event.data.path === 'peer' ? 'recebido pelo P2P' : 'resposta direta da VPS'}`;
    if (event.type === 'ack-rejected') text += ` · ${phrase(event.data.reason)}`;
    if (event.type === 'ack-verified') text += ` · ${event.data.confirmedUpdates ?? 0} updates confirmados · ${event.data.remainingUpdates ?? 0} pendentes`;
    if (Number.isFinite(event.data.elapsedMs)) text += ` · ${Math.round(event.data.elapsedMs)} ms medidos nesta aba`;
    line.append(element('p', text));
    line.append(element('small', `${row.source === 'server' ? 'Relógio VPS' : 'Relógio do relator'}: ${time(event.observedAt)} · sequência local ${event.sequence}${row.receivedAt ? ` · coletado na VPS ${time(row.receivedAt)}` : ''}`));
    return line;
  }
  function render() {
    if (destroyed) return;
    const focused = root.contains(doc.activeElement) ? doc.activeElement.dataset.traceFocus : null;
    renderStatus(); const observed = allRows(); const grouped = new Map();
    for (const row of observed) if (row.event.batchId) {
      const group = grouped.get(row.event.batchId) ?? []; group.push(row); grouped.set(row.event.batchId, group);
    }
    const known = [...batches.values()]; const ids = [...new Set([...known.map((b) => b.batchId), ...grouped.keys()])];
    ids.sort((a,b) => {
      const stamp = (id) => batches.get(id)?.committedAt || grouped.get(id)?.at(-1)?.event.observedAt || '';
      return stamp(b).localeCompare(stamp(a));
    });
    const cards = ids.map((id) => {
      const records = grouped.get(id) ?? []; const info = batches.get(id);
      const persisted = records.find((r) => r.source === 'server' && r.event.type === 'server-committed');
      const sent = records.find((r) => r.event.type === 'batch-send');
      const actor = persisted?.username || info?.username || sent?.username || 'remetente não registrado';
      const card = element('details', undefined, 'trace-batch'); card.dataset.traceBatch = id;
      card.append(element('summary', `Lote · ${actor} · ${info || persisted ? 'Persistido na VPS' : 'Sem confirmação da VPS neste histórico'} · ${size(info?.updateBytes ?? sent?.event.data.updateBytes)} · ${time(info?.committedAt ?? persisted?.event.data.committedAt ?? sent?.event.observedAt)}`));
      detailsKey(card, `batch:${id}`);
      const content = element('div');
      const attempts = new Map();
      for (const row of records) {
        if (!row.event.attemptId) continue;
        const group = attempts.get(row.event.attemptId) ?? []; group.push(row); attempts.set(row.event.attemptId, group);
      }
      if (!attempts.size && !records.length) content.append(element('p', 'Eleição não registrada nesta versão. Os metadados disponíveis mostram a persistência deste lote.'));
      for (const [attemptId, events] of attempts) {
        const sender = events.find((r) => r.event.type === 'batch-send') ?? events.find((r) => r.source === 'server');
        const attemptActor = sender?.username || actor;
        const part = element('section', undefined, 'trace-attempt'); part.append(element('h4', `Tentativa ${[...attempts.keys()].indexOf(attemptId) + 1} · ${attemptActor}${sender ? ` · aba ${sender.event.docClientId.slice(-4)}` : ''}`));
        const viewId = events.find((r) => r.event.electionViewId)?.event.electionViewId;
        const view = observed.find((r) => r.event.type === 'election-view' && r.event.electionViewId === viewId);
        if (view) {
          const detail = element('details'); detail.append(element('summary', `Por que ${attemptActor} enviou? Ver sorteio e candidatos`), election(view)); detailsKey(detail, `view:${id}:${attemptId}`); part.append(detail);
        } else part.append(element('p', 'Visão eleitoral indisponível no histórico retido: não coletada ou expirada.'));
        const stages = element('ol');
        const rank = (type) => type === 'batch-send' ? 0 : type === 'server-received' ? 1 : type === 'server-committed' ? 2 : type === 'server-ack-sent' ? 3 : 4;
        events.sort((a,b) => rank(a.event.type) - rank(b.event.type) || (a.event.traceSessionId === b.event.traceSessionId ? a.event.sequence - b.event.sequence : a.id - b.id));
        for (const event of events) stages.append(eventLine(event)); part.append(stages);
        content.append(part);
      }
      const observations = records.filter((r) => r.event.type.startsWith('ack-') && !r.event.attemptId);
      if (observations.length) { const heading = element('h4', 'Recebimento nos outros participantes'); const stages = element('ol'); observations.forEach((r) => stages.append(eventLine(r))); content.append(heading, stages); }
      const seen = new Set(records.filter((r) => r.event.type === 'ack-verified').map((r) => r.event.docClientId));
      const involvedViews = observed.filter((r) => r.event.type === 'election-view' && records.some((record) => record.event.electionViewId === r.event.electionViewId));
      const observedPeople = new Set(involvedViews.flatMap((r) => (r.event.data.candidates ?? []).filter((c) => c.eligible).map((c) => c.id)));
      for (const person of observedPeople) if (!seen.has(person)) content.append(element('p', `${name(person)} · aba ${person.slice(-4)}: sem registro de recebimento e verificação do ACK.`));
      content.append(element('small', 'Etapas agrupadas por causa e efeito. Relógios de participantes diferentes não definem uma ordem global.'));
      const technical = element('details'); technical.append(element('summary', 'Identificadores técnicos'), element('p', `Lote: ${id}`), element('p', `Tentativas: ${[...attempts.keys()].join(', ') || 'não registradas'}`)); content.append(technical);
      card.append(content);
      card.addEventListener('toggle', () => { if (card.open && !loadedDetails.has(id)) { loadedDetails.add(id); void load({ detail: id }); } });
      return card;
    });
    list.replaceChildren(...(cards.length ? cards : [element('p', 'Nenhum lote neste histórico. Sorteios e eleições aparecem abaixo mesmo antes do primeiro envio.')]));
    const viewRows = observed.filter((r) => ['election-view', 'candidate-drawn', 'trace-gap'].includes(r.event.type)).slice(-60).reverse();
    electionList.replaceChildren(...viewRows.map((r) => {
      if (r.event.type !== 'election-view') return eventLine(r);
      const detail = element('details');
      const compare = element('button', `Comparar visão de ${r.username}`); compare.type = 'button'; compare.dataset.traceFocus = `compare:${r.event.eventId}`; compare.dataset.compareView = r.event.eventId;
      compare.setAttribute('aria-pressed', String(comparedViews.has(r.event.eventId)));
      compare.addEventListener('click', () => {
        if (comparedViews.has(r.event.eventId)) comparedViews.delete(r.event.eventId);
        else { if (comparedViews.size >= 2) comparedViews.delete(comparedViews.keys().next().value); comparedViews.set(r.event.eventId, r); }
        renderComparison();
      });
      detail.append(element('summary', `Visão de ${r.username} · ${time(r.event.observedAt)}`), election(r), compare); detailsKey(detail, `election:${r.event.eventId}`); return detail;
    }));
    renderComparison();
    const previous = participant.value; const options = [element('option', 'Todos os participantes')]; options[0].value = '';
    const unique = new Map([...people.values()].map((p) => [p.accountId, p.username]));
    for (const [id, username] of unique) { const option = element('option', username); option.value = id; options.push(option); }
    participant.replaceChildren(...options); participant.value = previous || filters.participant;
    more.disabled = !cursor && !batchCursor;
    if (focused) [...root.querySelectorAll('[data-trace-focus]')].find((node) => node.dataset.traceFocus === focused)?.focus({ preventScroll: true });
  }
  function renderComparison() {
    const nodes = [...comparedViews.values()].map((row) => election(row));
    comparison.replaceChildren(...nodes);
    for (const button of root.querySelectorAll('[data-compare-view]')) button.setAttribute('aria-pressed', String(comparedViews.has(button.dataset.compareView)));
  }
  function active() { return !destroyed && doc.visibilityState !== 'hidden' && isActive(); }
  async function load({ older = false, detail = null } = {}) {
    if (!active()) return;
    if (busy && !detail && older) return;
    controller?.abort(); controller = new AbortController(); const serial = ++generation; busy = true;
    const url = new URL(`/api/boards/${encodeURIComponent(boardId)}/persistence-trace`, doc.location.href);
    if (detail || filters.batchId) url.searchParams.set('batchId', detail || filters.batchId);
    if (filters.participant) url.searchParams.set('participant', filters.participant);
    if (older && cursor) url.searchParams.set('before', cursor);
    if (older && batchCursor) url.searchParams.set('batchBefore', JSON.stringify(batchCursor));
    try {
      session.recordDiagnosticTraffic?.('sent', url.pathname + url.search);
      const response = await fetchImpl(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`Consulta do histórico HTTP ${response.status}`);
      const payload = await response.text(); session.recordDiagnosticTraffic?.('received', payload); const data = JSON.parse(payload);
      if (destroyed || serial !== generation || !active()) return;
      for (const row of [...data.rows, ...(data.detail ?? [])]) rows.set(eventKey(row), row);
      for (const b of data.batches) batches.set(b.batchId, b);
      for (const p of data.participants) people.set(p.docClientId, p);
      if (!detail && (older || !paginationInitialized)) { cursor = data.nextBefore; batchCursor = data.batchNext; paginationInitialized = true; }
      dropped = data.dropped; lastUpdate = new Date().toISOString(); error = null; render();
    } catch (failure) { if (!destroyed && serial === generation && failure.name !== 'AbortError') { error = failure.message; if (detail) loadedDetails.delete(detail); renderStatus(); } }
    finally { if (serial === generation) busy = false; }
  }
  function reset() { generation++; controller?.abort(); rows.clear(); batches.clear(); loadedDetails.clear(); open.clear(); comparedViews.clear(); paginationInitialized = false; cursor = null; batchCursor = null; filters = { batchId: batch.value.trim(), participant: participant.value }; render(); void load(); }
  const onSearch = () => reset(); const onClear = () => { batch.value = ''; participant.value = ''; reset(); };
  const onMore = () => { void load({ older: true }); };
  const onKey = (event) => { if (event.key === 'Enter') reset(); };
  const visibility = () => { if (!active()) { controller?.abort(); generation++; busy = false; } else if (!busy) void load(); };
  search.addEventListener('click', onSearch); clear.addEventListener('click', onClear); more.addEventListener('click', onMore); batch.addEventListener('keydown', onKey);
  doc.addEventListener('visibilitychange', visibility);
  const observer = new MutationObserver(visibility);
  for (let parent = container.parentElement; parent; parent = parent.parentElement) observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'data-mode', 'data-sidebar'] });
  const unsubscribe = session.on?.('persistence-status', render);
  const uncollect = session.persistenceTrace?.subscribe(render);
  const timer = setInterval(() => { if (active() && !busy) void load(); else if (!active() && busy) visibility(); }, intervalMs);
  render(); void load();
  return { refresh: () => load(), destroy() {
    destroyed = true; generation++; controller?.abort(); clearInterval(timer); observer.disconnect(); unsubscribe?.(); uncollect?.();
    doc.removeEventListener('visibilitychange', visibility); search.removeEventListener('click', onSearch); clear.removeEventListener('click', onClear); more.removeEventListener('click', onMore); batch.removeEventListener('keydown', onKey); root.remove();
  } };
}
