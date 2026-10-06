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
const accessRequestPanel = document.querySelector('#access-request-panel');
const accessRequestForm = document.querySelector('#access-request-form');
const accessRequestStatus = document.querySelector('#access-request-status');
const pendingRequestsPanel = document.querySelector('#pending-requests-panel');
const pendingRequestsList = document.querySelector('#pending-requests');
const membersPanel = document.querySelector('#members-panel');
const membersList = document.querySelector('#board-members');
let currentAccountId = null;
let mountedBoard = null;
let mountedStudyUI = null;
let mountedReplicaPanel = null;
let mountedTimeline = null;
let mountedSyncStatusUI = null;
let mountedSyncExperimentUI = null;
let unobserveBoardEvents = [];
let boardSession = null;

async function closeCurrentBoard() {
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
  boardList.replaceChildren();
  for (const board of boards) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = board.href;
    link.textContent = board.title;
    const membership = document.createElement('span');
    membership.textContent = board.isMember ? ' (membro)' : ' (sem acesso)';
    item.append(link, membership);
    boardList.append(item);
  }
  if (!boards.length) {
    const item = document.createElement('li');
    item.textContent = 'Nenhum quadro encontrado.';
    boardList.append(item);
  }
}

async function loadBoard(boardId) {
  catalogView.hidden = true;
  boardDetail.hidden = false;
  const { board } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}`);
  await closeCurrentBoard();
  document.querySelector('#board-title').textContent = board.title;
  document.querySelector('#board-workspace').hidden = true;
  if (!board.isMember) {
    document.querySelector('#board-access-message').textContent = 'Este quadro existe, mas você ainda não é membro. O conteúdo não foi carregado.';
    pendingRequestsPanel.hidden = true;
    membersPanel.hidden = true;
    accessRequestPanel.hidden = false;
    const { pending } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-request`);
    accessRequestForm.hidden = pending;
    accessRequestStatus.textContent = pending ? 'Seu pedido está aguardando a aprovação de um membro.' : '';
    return;
  }

  accessRequestPanel.hidden = true;
  pendingRequestsPanel.hidden = false;
  membersPanel.hidden = false;
  const { members } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/members`);
  membersList.replaceChildren();
  for (const member of members) {
    const item = document.createElement('li');
    item.append(document.createTextNode(member.username));
    if (member.accountId === currentAccountId) {
      item.append(document.createTextNode(' (você)'));
    } else {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = 'Revogar acesso';
      revoke.addEventListener('click', async () => {
        try {
          await requestJson(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(member.accountId)}/revoke`, { method: 'POST' });
          await loadBoard(boardId);
        } catch (error) {
          message.textContent = error.message;
        }
      });
      item.append(' ', revoke);
    }
    membersList.append(item);
  }

  const { requests } = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests`);
  pendingRequestsList.replaceChildren();
  for (const pending of requests) {
    const item = document.createElement('li');
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = `Aceitar pedido de ${pending.username}`;
    accept.addEventListener('click', async () => {
      try {
        await requestJson(`/api/boards/${encodeURIComponent(boardId)}/access-requests/${encodeURIComponent(pending.accountId)}/accept`, { method: 'POST' });
        await loadBoard(boardId);
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

  const [{ mountBoardCanvas, openBoardSession, mountSyncExperimentUI }, { mountBoardStudyUI }] = await Promise.all([
    import('/board.bundle.js'),
    import('/board-study-ui.js'),
  ]);
  boardSession = await openBoardSession(boardId);
  mountedBoard = mountBoardCanvas({
    boardId,
    canvas: document.querySelector('#board-canvas'),
    toolbar: document.querySelector('#board-toolbar'),
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
}

accessRequestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const boardMatch = location.pathname.match(/^\/boards\/([^/]+)\/?$/);
  if (!boardMatch) return;
  try {
    await requestJson(`/api/boards/${encodeURIComponent(decodeURIComponent(boardMatch[1]))}/access-requests`, { method: 'POST' });
    accessRequestForm.hidden = true;
    accessRequestStatus.textContent = 'Seu pedido está aguardando a aprovação de um membro.';
  } catch (error) {
    message.textContent = error.message;
  }
});

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
