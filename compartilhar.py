#!/usr/bin/env python3
"""Inicia o quadro e mantém o túnel associado ao servidor que responde em 8765."""
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PORT = 8765
LOCAL_URL = f'http://127.0.0.1:{PORT}'


def ensure_cloudflared():
    installed = shutil.which('cloudflared')
    if installed:
        return installed
    if os.name != 'nt':
        raise RuntimeError('cloudflared não encontrado no PATH. Instale-o antes de iniciar o túnel.')
    binary = BASE_DIR / 'cloudflared.exe'
    if not binary.exists():
        print('Baixando cloudflared para Windows...', flush=True)
        urllib.request.urlretrieve(
            'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
            binary)
    return str(binary)


def board_responds(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200 and b'id="whiteboardCanvas"' in response.read()
    except (OSError, ValueError):
        return False


def port_in_use():
    with socket.socket() as connection:
        connection.settimeout(1)
        return connection.connect_ex(('127.0.0.1', PORT)) == 0


def wait_for_board(url, processes, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError('Servidor ou túnel encerrou durante a inicialização. Veja o erro acima.')
        if board_responds(url):
            return
        time.sleep(0.25)
    raise RuntimeError(f'O quadro não respondeu em {url} após {timeout} segundos.')


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    if os.name != 'nt':
        try:
            os.kill(process.pid, signal.SIGCONT)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def copy_to_clipboard(text):
    commands = [['clip']] if os.name == 'nt' else [
        ['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
    for command in commands:
        if shutil.which(command[0]):
            try:
                result = subprocess.run(command, input=text.encode(), timeout=2,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if result.returncode == 0:
                    return True
            except (OSError, subprocess.TimeoutExpired):
                pass
    return False


def main():
    server = tunnel = None
    try:
        cloudflared = ensure_cloudflared()
        if port_in_use():
            if not board_responds(LOCAL_URL):
                raise RuntimeError(f'A porta {PORT} está ocupada, mas o quadro não responde. '
                                   'Execute ./fechar_servidor.sh e tente novamente.')
            print(f'Usando o quadro já aberto em {LOCAL_URL}', flush=True)
        else:
            print(f'Iniciando o quadro em {LOCAL_URL}', flush=True)
            server = subprocess.Popen(
                [sys.executable, '-u', str(BASE_DIR / 'whiteboard/server.py'), '--no-browser'],
                cwd=BASE_DIR)
        owned = [server] if server is not None else []
        wait_for_board(LOCAL_URL, owned, 15)

        # Isolate this temporary tunnel from the user's named tunnel configuration.
        with tempfile.TemporaryDirectory(prefix='whiteboard-tunnel-') as temp:
            config = Path(temp) / 'config.yml'
            config.write_text('{}\n')
            tunnel = subprocess.Popen(
                [cloudflared, 'tunnel', '--config', str(config), '--no-autoupdate', '--url', LOCAL_URL],
                cwd=BASE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1)
            lines = queue.Queue()

            def read_logs():
                for line in tunnel.stdout:
                    print(line, end='', flush=True)
                    lines.put(line)
                lines.put(None)

            threading.Thread(target=read_logs, daemon=True).start()
            url = None
            connected = False
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline and not (url and connected):
                try:
                    line = lines.get(timeout=0.5)
                except queue.Empty:
                    continue
                if line is None:
                    raise RuntimeError('O cloudflared encerrou antes de conectar. Veja o erro acima.')
                match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
                if match:
                    url = match.group(0)
                if 'Registered tunnel connection' in line:
                    connected = True
            if not url or not connected:
                raise RuntimeError('O túnel não confirmou conexão em 45 segundos. Veja os logs acima.')

            wait_for_board(url, owned + [tunnel], 45)
            print(f'\nQuadro verificado no link público: {url}', flush=True)
            print(f'Acesso local: {LOCAL_URL}', flush=True)
            if copy_to_clipboard(url):
                print('Link copiado para a área de transferência.', flush=True)
            print('Mantenha este terminal aberto. Ctrl+C encerra o túnel e o servidor iniciado aqui.', flush=True)
            while tunnel.poll() is None:
                if server is not None and server.poll() is not None:
                    raise RuntimeError('O servidor encerrou. Fechando o túnel para evitar Bad Gateway.')
                # Drain logs after startup as well, without retaining them in memory.
                try:
                    lines.get(timeout=0.5)
                except queue.Empty:
                    pass
            raise RuntimeError(f'O túnel encerrou com código {tunnel.returncode}.')
    except KeyboardInterrupt:
        print('\nEncerrando servidor e túnel...', flush=True)
        return 0
    except (OSError, RuntimeError) as error:
        print(f'Erro: {error}', file=sys.stderr, flush=True)
        return 1
    finally:
        stop_process(tunnel)
        stop_process(server)


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, interrupted)
    sys.exit(main())
