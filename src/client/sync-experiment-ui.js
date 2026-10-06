import {
  createLiveSyncMetricsSnapshot,
  exportLiveSyncMetricsCsv,
  exportSyncExperimentJson,
} from './sync-experiment.js';

const BYTE_SCOPE = 'Payload da aplicação: JSON UTF-8 no WebSocket e frames binários no datachannel. Não inclui overhead WS/TCP/TLS/SCTP/DTLS/IP nem retransmissões.';
const REFRESH_INTERVAL_MS = 500;

/** Mount live, per-session traffic counters with reset and local JSON/CSV export. */
export function mountSyncExperimentUI({ session, container, boardId = null, replicaId = null, download = browserDownload }) {
  if (!session || typeof session.resetExperimentMetrics !== 'function'
    || !session.experimentMetrics || typeof container?.append !== 'function'
    || !container.ownerDocument) {
    throw new TypeError('A board session and attached DOM container are required');
  }
  if (typeof download !== 'function') throw new TypeError('download must be a function');

  const document = container.ownerDocument;
  const root = document.createElement('section');
  const heading = document.createElement('h2');
  const scope = document.createElement('p');
  const summary = document.createElement('pre');
  const resetButton = document.createElement('button');
  const jsonButton = document.createElement('button');
  const csvButton = document.createElement('button');
  const status = document.createElement('p');
  const listeners = [];
  let destroyed = false;

  root.dataset.syncExperiment = '';
  heading.textContent = 'Tráfego desta réplica';
  scope.textContent = BYTE_SCOPE;
  resetButton.type = jsonButton.type = csvButton.type = 'button';
  resetButton.textContent = 'Zerar contadores';
  jsonButton.textContent = 'Baixar JSON';
  csvButton.textContent = 'Baixar CSV';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  function on(target, type, listener) {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  }

  function liveSnapshot() {
    return createLiveSyncMetricsSnapshot({
      boardId,
      replicaId,
      metrics: session.experimentMetrics,
    });
  }

  function render() {
    if (destroyed) return;
    const metrics = session.experimentMetrics;
    summary.textContent = ['websocket', 'webrtc'].map(channel => {
      const sent = metrics[channel].sent;
      const received = metrics[channel].received;
      return `${channel}: enviados ${sent.bytes} B / ${sent.updateMessages} updates / ${sent.awarenessBytes} B Awareness; recebidos ${received.bytes} B / ${received.updateMessages} updates / ${received.awarenessBytes} B Awareness`;
    }).join('\n');
  }

  on(resetButton, 'click', () => {
    session.resetExperimentMetrics();
    status.textContent = 'Contadores zerados nesta réplica.';
    render();
  });
  on(jsonButton, 'click', () => {
    download('sync-metrics.json', exportSyncExperimentJson(liveSnapshot()), 'application/json');
    status.textContent = 'Snapshot JSON exportado.';
  });
  on(csvButton, 'click', () => {
    download('sync-metrics.csv', exportLiveSyncMetricsCsv(liveSnapshot()), 'text/csv;charset=utf-8');
    status.textContent = 'Snapshot CSV exportado.';
  });

  root.append(heading, scope, summary, resetButton, jsonButton, csvButton, status);
  container.append(root);
  render();
  const timer = setInterval(render, REFRESH_INTERVAL_MS);

  return Object.freeze({
    snapshot: liveSnapshot,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      for (const removeListener of listeners) removeListener();
      root.remove();
    },
  });
}

function browserDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
