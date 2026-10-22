import { mountReplicaPanel } from './replica-panel.js';
import { mountBoardTimelineUI } from './board-timeline-ui.js';
import { mountBoardSyncStatusUI } from './board-sync-status-ui.js';

const message = document.querySelector('#message');
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const authPanel = document.querySelector('#auth-panel');
const accountPanel = document.querySelector('#account-panel');
const formTitle = document.querySelector('#form-title');
const toggleForm = document.querySelector('#toggle-form');
const catalogView = document.querySelector('#board-catalog-view');
const boardDetail = document.querySelector('#board-detail');
const boardList = document.querySelector('#board-list');
const requestAccessTemplate = document.querySelector('#request-access-template');
const pendingRequestsPanel = document.querySelector('#pending-requests-panel');
const pendingRequestsList = document.querySelector('#pending-requests');
const membersPanel = document.querySelector('#members-panel');
const membersList = document.querySelector('#board-members');
const workspaceSidebar = document.querySelector('#workspace-sidebar');
const studyLayout = document.querySelector('#study-layout');
const workspaceSidebarTitle = document.querySelector('#workspace-sidebar-title');
const workspaceModeButtons = [...document.querySelectorAll('[data-workspace-mode]')];
let currentAccountId = null;
let mountedBoard = null;
let mountedStudyUI = null;
let mountedReplicaPanel = null;
let mountedTimeline = null;
let mountedSyncStatusUI = null;
let mountedSyncExperimentUI = null;
let unobserveBoardEvents = [];
let boardSession = null;
let accessPolling = null;
let catalogFocusBoardId = null;
let canvasResizeObserver = null;
let pendingRequestsVersion = 0;
let pendingRequestCount = 0;

const sidebarOpen = () => studyLayout.dataset.sidebar === 'open';

function syncModeButtons() {
  for (const button of workspaceModeButtons) {
    button.setAttribute('aria-pressed', String(sidebarOpen() && button.dataset.workspaceMode === workspaceSidebar.dataset.mode));
  }
}

function setWorkspaceMode(mode) {
  workspaceSidebar.dataset.mode = mode;
  const button = workspaceModeButtons.find((item) => item.dataset.workspaceMode === mode);
  workspaceSidebarTitle.textContent = button?.textContent.trim() ?? '';
  if (mode === 'board') delete button?.dataset.attention;
  syncModeButtons();
}

function setSidebarOpen(open) {
  studyLayout.dataset.sidebar = open ? 'open' : 'closed';
  syncModeButtons();
}

for (const button of workspaceModeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.workspaceMode;
    if (sidebarOpen() && workspaceSidebar.dataset.mode === mode) {
      setSidebarOpen(false);
      return;
    }
    setWorkspaceMode(mode);
    setSidebarOpen(true);
  });
}
document.querySelector('#workspace-close').addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !sidebarOpen() || boardDetail.hidden) return;
  if (event.target?.matches?.('input, textarea, select')) return;
  setSidebarOpen(false);
});

function stopAccessPolling() {
  if (accessPolling) clearInterval(accessPolling.timer);
  accessPolling = null;
}

async function closeCurrentBoard() {
  stopAccessPolling();
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  for (const unsubscribe of unobserveBoardEvents) unsubscribe?.();
  unobserveBoardEvents = [];
  document.querySelector('#replica-panel')?.removeEventListener('replica-diagnostic-event', onReplicaDiagnosticEvent);
  mountedTimeline?.destroy();
  mountedTimeline = null;
  mountedSyncStatusUI?.destroy();
  mountedSyncStatusUI = null;
  mountedSyncExperimentUI?.destroy();
  mountedSyncExperimentUI = null;
  mountedReplicaPanel?.destroy();
  mountedReplicaPanel = null;
  mountedStudyUI?.destroy();
  mountedStudyUI = null;
  mountedBoard?.destroy();
  mountedBoard = null;
  const session = boardSession;
  boardSession = null;
  if (session) await session.destroy();
}

function onReplicaDiagnosticEvent(event) {
  const envelope = event.detail;
  if (envelope?.type !== 'event' || !envelope.event || typeof envelope.event.type !== 'string') return;
  const detail = {
    ...envelope.event,
    replicaId: envelope.event.replicaId ?? envelope.replicaId,
  };
  mountedTimeline?.appendEvent(detail.type, detail);
  mountedSyncStatusUI?.appendEvent(detail.type, detail);
}

function showForm(mode) {
  const registering = mode === 'register';
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  formTitle.textContent = registering ? 'Criar conta' : 'Entrar';
  toggleForm.textContent = registering ? 'Já tenho uma conta' : 'Criar uma conta';
  message.textContent = '';
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Não foi possível concluir a solicitação.');
  return result;
}

function postJson(path, payload) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function values(form) {
  return Object.fromEntries(new FormData(form));
}

async function loadCatalog(search = '') {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  const { boards } = await requestJson(`/api/boards${query.size ? `?${query}` : ''}`);
  const requested = new Set();
  await Promise.all(boards.filter((board) => !board.isMember).map(async (board) => {
    const { pending } = await requestJson(`/api/boards/${encodeURIComponent(board.id)}/access-request`);
    if (pending) requested.add(board.id);
  }));
  boardList.replaceChildren(...boards.map((board) => renderBoardRow(
    board,
    board.isMember ? 'member' : requested.has(board.id) ? 'requested' : 'none',
  )));
  if (!boards.length) {
    const item = document.createElement('li');
    item.className = 'board-empty';
    item.textContent = search ? 'Nenhum quadro com esse título.' : 'Nenhum quadro ainda. Crie o primeiro acima.';
    boardList.append(item);
  }
  if (requested.size) startCatalogPolling();
  boardList.querySelector('.is-focus')?.scrollIntoView({ block: 'center' });
}

function renderBoardRow(board, state) {
  const item = document.createElement('li');
  item.dataset.boardId = board.id;
  item.dataset.state = state;
  if (board.id === catalogFocusBoardId) item.classList.add('is-focus');
  const row = document.createElement(state === 'member' ? 'a' : 'div');
  row.className = 'board-row';
  if (state === 'member') row.href = board.href;
  const title = document.createElement('span');
  title.className = 'board-row__title';
  title.textContent = board.title;
  if (state === 'none') {
    const request = requestAccessTemplate.content.firstElementChild.cloneNode(true);
    request.setAttribute('aria-label', `Solicitar acesso a ${board.title}`);
    request.addEventListener('click', async () => {
      request.disabled = true;
      try {
        await requestJson(`/api/boards/${encodeURIComponent(board.id)}/access-requests`, { method: 'POST' });
        item.replaceWith(renderBoardRow(board, 'requested'));
        message.textContent = 'Pedido enviado. Um membro do quadro precisa aceitar.';
        startCatalogPolling();
      } catch (error) {
        request.disabled = false;
        message.textContent = error.message;
      }
    });
    row.append(title, request);
  } else {
    const badge = document.createElement('span');
    badge.className = 'board-badge';
    badge.textContent = state === 'member' ? 'Membro' : 'Solicitado';
    row.append(title, badge);
  }
  item.append(row);
  return item;
}

function renderMembers(boardId, members) {
  membersList.replaceChildren();
  for (const member of members) {
    const item = document.createElement('li');
    const avatar = document.createElement('span');
    avatar.className = 'member-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = member.username.slice(0, 1);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = member.username;
    item.append(avatar, name);
    if (member.accountId === currentAccountId) {
      const you = document.createElement('span');
      you.className = 'member-you';
      you.textContent = '(você)';
      name.append(' ', you);
    } else {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'member-revoke';
      revoke.textContent = 'Revogar acesso';
      revoke.addEventListener('click', async () => {
        try {
          await requestJson(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(member.accountId)}/revoke`, { method: 'POST' });
          const result = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/members`);
          renderMembers(boardId, result.members);
        } catch (error) {
          message.textContent = error.message;
        }
      });
      item.append(revoke);
    }
    membersList.append(item);
  }
}

function renderPendingRequests(boardId, requests) {
  if (requests.length > pendingRequestCount) {
    if (!sidebarOpen()) {
      setWorkspaceMode('board');
      setSidebarOpen(true);
    } else if (workspaceSidebar.dataset.mode !== 'board') {
      workspaceModeButtons.find((button) => button.dataset.workspaceMode === 'board').dataset.attention = '';
      message.textContent = 'Novo pedido de acesso em Quadro.';
    }
  }
  pendingRequestCount = requests.length;
  pendingRequestsList.replaceChildren();
  for (const pending of requests) {
    const item = document.createElement('li');
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = `Aceitar pedido de ${pending.username}`;
    accept.addEventListener('click', async () => {
      try {
        await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests/${encodeURIComponent(pending.accountId)}/accept`, { method: 'POST' });
        const version = ++pendingRequestsVersion;
        const [{ members }, { requests: remaining }] = await Promise.all([
          requestJson(`/api/boards/${encodeURIComponent(boardId)}/members`),
          requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests`),
        ]);
        if (version === pendingRequestsVersion) {
          renderMembers(boardId, members);
          renderPendingRequests(boardId, remaining);
        }
      } catch (error) {
        message.textContent = error.message;
      }
    });
    item.append(accept);
    pendingRequestsList.append(item);
  }
  if (!requests.length) {
    const item = document.createElement('li');
    item.textContent = 'Nenhum pedido pendente.';
    pendingRequestsList.append(item);
  }
}

// The real page sizes the canvas bitmap to its on-screen box so the board fills the stage.
function fitCanvasToStage(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  const bitmapWidth = Math.round(width);
  const bitmapHeight = Math.round(height);
  if (!bitmapWidth || !bitmapHeight) return;
  if (canvas.width === bitmapWidth && canvas.height === bitmapHeight) return;
  canvas.width = bitmapWidth;
  canvas.height = bitmapHeight;
  mountedBoard?.canvas.render();
}

function startAccessPolling(boardId) {
  stopAccessPolling();
  const state = { mode: 'member', inFlight: false, timer: null };
  accessPolling = state;
  state.timer = setInterval(async () => {
    if (state.inFlight || accessPolling !== state) return;
    state.inFlight = true;
    try {
      const version = ++pendingRequestsVersion;
      const { requests } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests`);
      if (accessPolling === state && version === pendingRequestsVersion) renderPendingRequests(boardId, requests);
    } catch {
      // A later poll can recover from a temporary connection failure.
    } finally {
      state.inFlight = false;
    }
  }, 5000);
}

function startCatalogPolling() {
  if (accessPolling?.mode === 'catalog') return;
  stopAccessPolling();
  const state = { mode: 'catalog', inFlight: false, timer: null };
  accessPolling = state;
  state.timer = setInterval(async () => {
    if (state.inFlight || accessPolling !== state) return;
    const waiting = [...boardList.querySelectorAll('li[data-state="requested"]')];
    if (!waiting.length) {
      stopAccessPolling();
      return;
    }
    state.inFlight = true;
    try {
      for (const item of waiting) {
        const { board } = await requestJson(`/api/boards/${encodeURIComponent(item.dataset.boardId)}`);
        if (accessPolling !== state || !board.isMember) continue;
        if (board.id === catalogFocusBoardId) {
          stopAccessPolling();
          await loadBoard(board.id);
          return;
        }
        item.replaceWith(renderBoardRow(board, 'member'));
        message.textContent = `Seu pedido para “${board.title}” foi aceito.`;
      }
    } catch {
      // A later poll can recover from a temporary connection failure.
    } finally {
      state.inFlight = false;
    }
  }, 5000);
}

async function loadBoard(boardId) {
  catalogView.hidden = true;
  boardDetail.hidden = false;
  const { board } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}`);
  await closeCurrentBoard();
  pendingRequestCount = 0;
  setWorkspaceMode('board');
  setSidebarOpen(false);
  document.querySelector('#board-title').textContent = board.title;
  document.querySelector('#board-workspace').hidden = true;
  if (!board.isMember) {
    boardDetail.hidden = true;
    catalogView.hidden = false;
    catalogFocusBoardId = board.id;
    await loadCatalog();
    message.textContent = `Você ainda não é membro de “${board.title}”. Peça acesso na lista.`;
    return;
  }

  message.textContent = '';
  pendingRequestsPanel.hidden = false;
  membersPanel.hidden = false;
  const { members } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/members`);
  renderMembers(boardId, members);

  const { requests } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests`);
  renderPendingRequests(boardId, requests);

  const [{ mountBoardCanvas, openBoardSession, mountSyncExperimentUI }, { mountBoardStudyUI }] = await Promise.all([
    import('/board.bundle.js'),
    import('/board-study-ui.js'),
  ]);
  boardSession = await openBoardSession(boardId);
  mountedBoard = mountBoardCanvas({
    boardId,
    canvas: document.querySelector('#board-canvas'),
    toolbar: document.querySelector('#board-toolbar'),
    secondaryToolbar: document.querySelector('#board-secondary-actions'),
    studyToolbar: document.querySelector('#study-gallery'),
    presenceContainer: document.querySelector('#replica-panel'),
    doc: boardSession.doc,
    boardSession,
    displayName: document.querySelector('#account-name').textContent,
    onSaveBoardImage: () => mountedStudyUI?.saveManualBoardImage(),
  });
  mountedStudyUI = mountBoardStudyUI({
    boardId,
    canvas: document.querySelector('#board-canvas'),
    mountedBoard,
  });
  mountedReplicaPanel = mountReplicaPanel({ boardId, session: boardSession });
  mountedTimeline = mountBoardTimelineUI({ session: boardSession, container: document.querySelector('#board-timeline') });
  mountedSyncStatusUI = mountBoardSyncStatusUI({ session: boardSession, container: document.querySelector('#board-sync-status') });
  mountedSyncExperimentUI = mountSyncExperimentUI({ session: boardSession, container: document.querySelector('#sync-experiment'), boardId, replicaId: sessionStorage.getItem(`t3-replica:${boardId}`) });
  const replicaPanelRoot = document.querySelector('#replica-panel');
  replicaPanelRoot.addEventListener('replica-diagnostic-event', onReplicaDiagnosticEvent);
  for (const type of ['update-observed', 'sync-batch']) {
    unobserveBoardEvents.push(boardSession.on(type, (detail) => {
      mountedReplicaPanel?.publishEvent({ type, ...detail });
    }));
  }
  document.querySelector('#board-access-message').textContent = 'Quadro compartilhado aberto neste navegador.';
  document.querySelector('#board-workspace').hidden = false;
  const boardCanvas = document.querySelector('#board-canvas');
  canvasResizeObserver = new ResizeObserver(() => fitCanvasToStage(boardCanvas));
  canvasResizeObserver.observe(boardCanvas);
  fitCanvasToStage(boardCanvas);
  startAccessPolling(boardId);
}

async function showAccount(account) {
  authPanel.hidden = true;
  accountPanel.hidden = false;
  document.querySelector('#account-name').textContent = account.username;
  currentAccountId = account.id;
  message.textContent = '';
  const boardMatch = location.pathname.match(/^\/boards\/([^/]+)\/?$/);
  if (boardMatch) {
    await loadBoard(decodeURIComponent(boardMatch[1]));
  } else {
    catalogFocusBoardId = null;
    catalogView.hidden = false;
    boardDetail.hidden = true;
    await loadCatalog();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { account } = await postJson('/api/auth/login', values(loginForm));
    await showAccount(account);
  } catch (error) {
    message.textContent = error.message;
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await postJson('/api/auth/register', values(registerForm));
    registerForm.reset();
    showForm('login');
    message.textContent = 'Conta criada. Entre para continuar.';
  } catch (error) {
    message.textContent = error.message;
  }
});

toggleForm.addEventListener('click', () => showForm(registerForm.hidden ? 'register' : 'login'));

document.querySelector('#create-board-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { board } = await postJson('/api/boards', values(event.currentTarget));
    location.assign(board.href);
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector('#board-search').addEventListener('input', async (event) => {
  try {
    await loadCatalog(event.currentTarget.value.trim());
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await postJson('/api/auth/logout', {});
    accountPanel.hidden = true;
    authPanel.hidden = false;
    await closeCurrentBoard();
    loginForm.reset();
    showForm('login');
  } catch (error) {
    message.textContent = error.message;
  }
});

try {
  const result = await requestJson('/api/auth/session');
  if (result.authenticated) await showAccount(result.account);
} catch {
  message.textContent = 'Não foi possível conectar ao servidor.';
}
