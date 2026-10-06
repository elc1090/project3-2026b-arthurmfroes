const status = document.querySelector('#status');

try {
  const response = await fetch('/health');
  if (!response.ok) throw new Error('Servidor indisponível');
  status.textContent = 'Servidor conectado.';
} catch {
  status.textContent = 'Não foi possível conectar ao servidor.';
}
