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
  document.querySelector('#board-title').textContent = board.title;
  const content = document.querySelector('#board-content');
  content.replaceChildren();
  if (!board.isMember) {
    document.querySelector('#board-access-message').textContent = 'Este quadro existe, mas você ainda não é membro. O conteúdo não foi carregado.';
    return;
  }

  const result = await requestJson(`/api/boards/${encodeURIComponent(boardId)}/content`);
  document.querySelector('#board-access-message').textContent = `${result.elements.length} elemento(s) no quadro.`;
  for (const element of result.elements) {
    const item = document.createElement('li');
    item.textContent = `${element.type} · ${element.id}`;
    content.append(item);
  }
  if (!result.elements.length) {
    const item = document.createElement('li');
    item.textContent = 'Este quadro ainda não tem conteúdo.';
    content.append(item);
  }
}

async function showAccount(account) {
  authPanel.hidden = true;
  accountPanel.hidden = false;
  document.querySelector('#account-name').textContent = account.username;
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
