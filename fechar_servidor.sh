#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

python3 - <<'PY'
import os
from pathlib import Path
import signal
import time

base = Path.cwd()
scripts = {
    base / 'whiteboard/server.py',
    base / 'compartilhar.py',
    base / 'start_whiteboard.py',
    base / 'start_whiteboard.sh',
    base / 'start_whiteboard_tunnel.sh',
    base / 'iniciar_tunel.sh',
}
processes = {}
targets = set()
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    pid = int(entry.name)
    if pid in (os.getpid(), os.getppid()):
        continue
    try:
        args = (entry / 'cmdline').read_bytes().decode().strip('\0').split('\0')
        cwd = (entry / 'cwd').resolve(strict=True)
        status = (entry / 'status').read_text()
        parent = int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
        processes[pid] = parent
        executable = Path(args[0]).name
        # Also find a tunnel left orphaned by an older launcher.
        if executable in ('cloudflared', 'cloudflared.exe') and cwd == base and '--url' in args:
            url_index = args.index('--url') + 1
            if url_index < len(args) and args[url_index] in {
                'http://localhost:8080', 'http://127.0.0.1:8080',
                'http://localhost:8765', 'http://127.0.0.1:8765',
            }:
                targets.add(pid)
        if executable.startswith('python') or executable in ('bash', 'sh'):
            # Examine only the script argument, never text passed to -c.
            for arg in args[1:]:
                if arg in ('-c', '-m'):
                    break
                if arg.startswith('-'):
                    continue
                if (cwd / arg).resolve() in scripts:
                    targets.add(pid)
                break
    except (OSError, ValueError, UnicodeError, StopIteration):
        continue

# Include cloudflared and other children launched by these scripts.
while True:
    children = {pid for pid, parent in processes.items() if parent in targets}
    if children <= targets:
        break
    targets.update(children)

if not targets:
    print('Nenhum servidor ou túnel deste quadro em execução.')
else:
    for pid in sorted(targets):
        try:
            os.kill(pid, signal.SIGTERM)
            os.kill(pid, signal.SIGCONT)  # Allow suspended processes to terminate.
        except ProcessLookupError:
            pass
    def still_running():
        remaining = []
        for pid in sorted(targets):
            try:
                status = Path(f'/proc/{pid}/status').read_text()
                state = next(line.split()[1] for line in status.splitlines() if line.startswith('State:'))
                if state != 'Z':
                    remaining.append(pid)
            except FileNotFoundError:
                pass
        return remaining

    deadline = time.monotonic() + 6
    while still_running() and time.monotonic() < deadline:
        time.sleep(0.1)
    remaining = still_running()
    if remaining:
        print('Finalizando processos que não responderam ao encerramento:', ', '.join(map(str, remaining)))
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.2)
    if still_running():
        print('Não foi possível encerrar os PIDs:', ', '.join(map(str, still_running())))
        raise SystemExit(1)
    print('Servidor e túnel deste quadro encerrados.')
PY
