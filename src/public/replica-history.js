import { diffInspectionSnapshots } from './inspection-diff.js';

const PAGE_SIZE = 25;

export function mountReplicaHistory({ root, send }) {
  const section = document.createElement('section');
  section.id = 'replica-history';
  section.setAttribute('aria-label', 'Histórico de inspeção');
  section.style.cssText = 'margin-top:1rem;padding-top:1rem;border-top:1px solid #cbd5e1';
  section.innerHTML = `
    <h3>Histórico de inspeção</h3>
    <p data-history-status role="status">Carregando histórico…</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:.75rem">
      <section><h4>Snapshots</h4><ol data-history-snapshots style="max-height:16rem;overflow:auto;padding-left:1.5rem"></ol>
        <button type="button" data-history-more-snapshots>Mais snapshots</button></section>
      <section><h4>Eventos de réplica</h4><ol data-history-events style="max-height:16rem;overflow:auto;padding-left:1.5rem"></ol>
        <button type="button" data-history-more-events>Mais eventos</button></section>
    </div>
    <section data-history-diff hidden><h4>Comparação visual por objeto</h4><p data-history-diff-summary></p>
      <div data-history-diff-items style="display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.6rem"></div></section>`;
  root.append(section);
  const status = section.querySelector('[data-history-status]');
  const snapshotsList = section.querySelector('[data-history-snapshots]');
  const eventsList = section.querySelector('[data-history-events]');
  const moreSnapshots = section.querySelector('[data-history-more-snapshots]');
  const moreEvents = section.querySelector('[data-history-more-events]');
  const diffSection = section.querySelector('[data-history-diff]');
  const snapshots = [];
  let snapshotCursor = null;
  let eventCursor = null;
  let requestSerial = 0;
  let refreshGeneration = 0;
  const pending = new Map();

  function request(type, fields = {}) {
    const requestId = `history-${++requestSerial}`;
    pending.set(requestId, { type, resolve: null, reject: null });
    if (!send({ type, requestId, ...fields })) {
      pending.delete(requestId);
      return Promise.reject(new Error('Canal de diagnóstico desconectado.'));
    }
    return new Promise((resolve, reject) => {
      const entry = pending.get(requestId);
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Timeout ao carregar histórico.'));
      }, 8000);
    });
  }

  function onMessage(event) {
    const message = event.detail;
    const entry = pending.get(message?.requestId);
    if (!entry) return;
    if (message.type === 'history-page' || message.type === 'history-snapshot' || message.type === 'history-error') {
      clearTimeout(entry.timer);
      pending.delete(message.requestId);
      if (message.type === 'history-error') entry.reject(new Error(message.error));
      else entry.resolve(message);
    }
  }

  function renderSnapshotRows(rows) {
    for (const row of rows) {
      snapshots.push(row);
      const item = document.createElement('li');
      item.dataset.snapshotId = String(row.id);
      item.style.margin = '.3rem 0';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `#${row.id} · ${row.replicaId} · recebido ${row.receivedAt}${row.sequence == null ? '' : ` · seq ${row.sequence}`}${row.clock ? ` · relógio ${row.clock}` : ''}`;
      button.style.cssText = 'width:100%;text-align:left;background:#fff;color:#0f172a;border:1px solid #cbd5e1';
      button.addEventListener('click', () => compareWithPrevious(row));
      item.append(button);
      snapshotsList.append(item);
    }
  }

  function renderEventRows(rows) {
    for (const row of rows) {
      const item = document.createElement('li');
      item.dataset.eventId = String(row.id);
      item.style.margin = '.4rem 0';
      const event = row.event ?? {};
      const time = event.observedAt ?? event.committedAt ?? row.receivedAt;
      item.textContent = `${row.replicaId} · ${event.type ?? 'evento'} · seq ${event.sequence ?? '—'} · relógio ${time ?? '—'} · recebido ${row.receivedAt}`;
      eventsList.append(item);
    }
  }

  async function load(kind, before = null, generation = refreshGeneration) {
    try {
      const result = await request('history-list', { kind, before, limit: PAGE_SIZE });
      if (generation !== refreshGeneration) return;
      if (kind === 'snapshots') {
        snapshotCursor = result.nextBefore;
        renderSnapshotRows(result.rows);
        moreSnapshots.disabled = result.rows.length < PAGE_SIZE;
      } else {
        eventCursor = result.nextBefore;
        renderEventRows(result.rows);
        moreEvents.disabled = result.rows.length < PAGE_SIZE;
      }
      status.textContent = 'Snapshots e eventos seguem ordem de recebimento na VPS; sequence e relógios são locais à réplica e não definem ordem entre réplicas.';
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function compareWithPrevious(selected) {
    const older = snapshots.find((row) => row.replicaId === selected.replicaId && row.id < selected.id);
    if (!older) {
      status.textContent = 'Não há snapshot anterior desta réplica nesta página. Carregue mais snapshots para comparar.';
      return;
    }
    try {
      const [beforeResult, afterResult] = await Promise.all([
        request('history-snapshot', { snapshotId: older.id }),
        request('history-snapshot', { snapshotId: selected.id }),
      ]);
      if (!beforeResult.snapshot || !afterResult.snapshot) throw new Error('Um snapshot expirou pela retenção limitada.');
      renderDiff(older, beforeResult.snapshot, selected, afterResult.snapshot);
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function renderDiff(beforeMeta, before, afterMeta, after) {
    const difference = diffInspectionSnapshots(before.elements, after.elements);
    const items = section.querySelector('[data-history-diff-items]');
    items.replaceChildren();
    const changes = [
      ...difference.added.map((entry) => ({ kind: 'Adicionado', id: entry.id, before: null, after: entry.after })),
      ...difference.removed.map((entry) => ({ kind: 'Removido', id: entry.id, before: entry.before, after: null })),
      ...difference.changed.map((entry) => ({ kind: 'Alterado', id: entry.id, before: entry.before, after: entry.after })),
    ];
    section.querySelector('[data-history-diff-summary]').textContent = `${beforeMeta.replicaId}: snapshot #${beforeMeta.id} → #${afterMeta.id} · ${difference.added.length} adicionados · ${difference.removed.length} removidos · ${difference.changed.length} alterados`;
    if (!changes.length) items.textContent = 'Nenhum objeto mudou entre estes snapshots.';
    for (const change of changes) items.append(renderChange(change));
    diffSection.hidden = false;
  }

  function renderChange(change) {
    const card = document.createElement('article');
    card.style.cssText = 'padding:.5rem;border:1px solid #cbd5e1;border-radius:.5rem;background:white';
    const title = document.createElement('strong');
    title.textContent = `${change.kind} · ${change.id}`;
    const summary = document.createElement('p');
    summary.textContent = `${describeElement(change.before)} → ${describeElement(change.after)}`;
    summary.style.cssText = 'margin:.25rem 0;font-size:.75rem;color:#475569;overflow-wrap:anywhere';
    const previews = document.createElement('div');
    previews.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.35rem;margin-top:.4rem';
    previews.append(renderObjectPreview('Antes', change.before), renderObjectPreview('Depois', change.after));
    card.append(title, summary, previews);
    return card;
  }

  function renderObjectPreview(label, element) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'min-width:0;text-align:center;font-size:.75rem;color:#475569';
    const caption = document.createElement('div');
    caption.textContent = label;
    const canvas = document.createElement('canvas');
    canvas.width = 180; canvas.height = 110;
    canvas.style.cssText = 'display:block;width:100%;height:auto;border:1px solid #e2e8f0;background:#fff';
    wrapper.append(caption, canvas);
    const context = canvas.getContext('2d');
    if (!element) {
      context.fillStyle = '#f1f5f9'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#64748b'; context.fillText('Objeto ausente', 8, 20);
      return wrapper;
    }
    drawObject(context, element);
    return wrapper;
  }

  section.querySelector('[data-history-more-snapshots]').addEventListener('click', () => {
    if (snapshotCursor) void load('snapshots', snapshotCursor);
  });
  section.querySelector('[data-history-more-events]').addEventListener('click', () => {
    if (eventCursor) void load('events', eventCursor);
  });
  root.addEventListener('replica-history-message', onMessage);

  return Object.freeze({
    refresh() {
      refreshGeneration += 1;
      snapshots.length = 0; snapshotCursor = null; eventCursor = null;
      moreSnapshots.disabled = true; moreEvents.disabled = true;
      snapshotsList.replaceChildren(); eventsList.replaceChildren(); diffSection.hidden = true;
      void load('snapshots'); void load('events');
    },
    destroy() {
      root.removeEventListener('replica-history-message', onMessage);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Histórico desmontado.')); }
      pending.clear();
      section.remove();
    },
  });
}

function describeElement(element) {
  if (!element) return 'ausente';
  const geometry = element.geometry ?? {};
  const style = element.style ?? {};
  const color = style.color ?? 'cor padrão';
  const width = style.strokeWidth ?? 'espessura padrão';
  if (element.type === 'image') return `imagem ${geometry.width}×${geometry.height} em (${geometry.x}, ${geometry.y}), asset ${element.data?.assetId ?? 'indisponível'}, ${color}`;
  if (['rect', 'mux', 'alu'].includes(element.type)) return `${element.type} ${geometry.width}×${geometry.height} em (${geometry.x}, ${geometry.y}), ${color}, traço ${width}`;
  if (element.type === 'path') return `traço com ${geometry.points?.length ?? 0} pontos, ${color}, espessura ${width}`;
  if (element.type === 'line' || element.type === 'arrow') return `${element.type} (${geometry.x1}, ${geometry.y1}) → (${geometry.x2}, ${geometry.y2}), ${color}, traço ${width}`;
  if (element.type === 'text') return `texto “${(element.data?.text ?? '').slice(0, 40)}”, em (${geometry.x}, ${geometry.y}), ${color}`;
  return `${element.type}, ${color}`;
}

function drawObject(context, element) {
  const geometry = element.geometry ?? {};
  const bounds = getBounds(element);
  context.fillStyle = '#f8fafc'; context.fillRect(0, 0, 180, 110);
  context.strokeStyle = '#e2e8f0'; context.strokeRect(0, 0, 180, 110);
  if (!bounds) return;
  const scale = Math.min(150 / Math.max(bounds.width, 1), 75 / Math.max(bounds.height, 1));
  const x = 15 + (150 - bounds.width * scale) / 2 - bounds.x * scale;
  const y = 17 + (75 - bounds.height * scale) / 2 - bounds.y * scale;
  context.save(); context.translate(x, y); context.scale(scale, scale);
  context.strokeStyle = element.style?.color ?? '#1e293b'; context.fillStyle = context.strokeStyle;
  context.lineWidth = Math.max(1, (element.style?.strokeWidth ?? 2) / scale);
  if (['rect', 'mux', 'alu'].includes(element.type)) {
    context.fillStyle = element.type === 'rect' ? 'rgba(255,255,255,.65)' : '#fff';
    context.fillRect(geometry.x, geometry.y, geometry.width, geometry.height);
    context.strokeRect(geometry.x, geometry.y, geometry.width, geometry.height);
    if (element.type === 'mux' || element.type === 'alu') context.fillText(element.type.toUpperCase(), geometry.x + geometry.width / 3, geometry.y + geometry.height / 2);
  } else if (element.type === 'path' && geometry.points?.length) {
    context.beginPath(); context.moveTo(geometry.points[0].x, geometry.points[0].y);
    for (const point of geometry.points.slice(1)) context.lineTo(point.x, point.y); context.stroke();
  } else if (['line', 'arrow'].includes(element.type)) {
    context.beginPath(); context.moveTo(geometry.x1, geometry.y1); context.lineTo(geometry.x2, geometry.y2); context.stroke();
  } else if (element.type === 'text') {
    context.font = '12px sans-serif'; context.fillText((element.data?.text ?? '').slice(0, 30), geometry.x, geometry.y + 12);
  } else if (element.type === 'image') {
    context.fillStyle = '#dbeafe'; context.fillRect(geometry.x, geometry.y, geometry.width, geometry.height);
    context.fillStyle = '#1e3a8a'; context.font = '10px sans-serif'; context.fillText('Imagem', geometry.x + 3, geometry.y + 14);
  }
  context.restore();
}

function getBounds(element) {
  const { type, geometry = {}, data = {}, style = {} } = element;
  if (['image', 'rect', 'mux', 'alu'].includes(type)) return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  if (type === 'path' && geometry.points?.length) {
    const xs = geometry.points.map((point) => point.x); const ys = geometry.points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (type === 'line' || type === 'arrow') return { x: Math.min(geometry.x1, geometry.x2), y: Math.min(geometry.y1, geometry.y2), width: Math.abs(geometry.x2 - geometry.x1), height: Math.abs(geometry.y2 - geometry.y1) };
  if (type === 'text') return { x: geometry.x, y: geometry.y, width: Math.max(30, (data.text ?? '').length * ((style.strokeWidth ?? 2) + 5)), height: 20 };
  return null;
}
