const message = document.querySelector('#message');
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const authPanel = document.querySelector('#auth-panel');
const accountPanel = document.querySelector('#account-panel');
const formTitle = document.querySelector('#form-title');
const toggleForm = document.querySelector('#toggle-form');

function showAccount(account) {
  authPanel.hidden = true;
  accountPanel.hidden = false;
  document.querySelector('#account-name').textContent = account.username;
  message.textContent = '';
}

function showForm(mode) {
  const registering = mode === 'register';
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  formTitle.textContent = registering ? 'Criar conta' : 'Entrar';
  toggleForm.textContent = registering ? 'Já tenho uma conta' : 'Criar uma conta';
  message.textContent = '';
}

async function sendJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Não foi possível concluir a solicitação.');
  return result;
}

function values(form) {
  return Object.fromEntries(new FormData(form));
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await sendJson('/api/auth/login', values(loginForm));
    showAccount(result.account);
  } catch (error) {
    message.textContent = error.message;
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await sendJson('/api/auth/register', values(registerForm));
    registerForm.reset();
    showForm('login');
    message.textContent = 'Conta criada. Entre para continuar.';
  } catch (error) {
    message.textContent = error.message;
  }
});

toggleForm.addEventListener('click', () => showForm(registerForm.hidden ? 'register' : 'login'));

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await sendJson('/api/auth/logout', {});
    accountPanel.hidden = true;
    authPanel.hidden = false;
    loginForm.reset();
    showForm('login');
    message.textContent = 'Você saiu da conta.';
  } catch (error) {
    message.textContent = error.message;
  }
});

try {
  const response = await fetch('/api/auth/session');
  const result = await response.json();
  if (result.authenticated) showAccount(result.account);
} catch {
  message.textContent = 'Não foi possível conectar ao servidor.';
}
