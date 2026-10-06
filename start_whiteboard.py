#!/usr/bin/env python3
"""
Launcher for the Arquitetura de Computadores Whiteboard.
Usage: python start_whiteboard.py
"""
import os
import sys
import subprocess

def ensure_dependencies():
    for pkg in ['fastapi', 'uvicorn', 'websockets']:
        try:
            __import__(pkg)
        except ImportError:
            print(f"⏳ Instalando dependência para o quadro colaborativo: {pkg}...")
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "--quiet"])
                print(f"✅ {pkg} instalado com sucesso!")
            except Exception as e:
                print(f"⚠️  Aviso ao instalar {pkg}: {e}")

base_dir = os.path.dirname(os.path.abspath(__file__))
whiteboard_server = os.path.join(base_dir, 'whiteboard', 'server.py')

if __name__ == '__main__':
    ensure_dependencies()
    sys.exit(subprocess.call([sys.executable, whiteboard_server] + sys.argv[1:]))
