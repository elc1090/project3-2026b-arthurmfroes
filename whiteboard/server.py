#!/usr/bin/env python3
"""
Whiteboard Local Server for Arquitetura de Computadores
Provides real-time multi-user collaboration (WebSockets), static file serving,
and API endpoints for saving canvas state, exporting PNG for AI inspection,
and loading templates/feedback.
"""

import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import json
import base64
import time
import socket
import asyncio
import uuid
import webbrowser
from datetime import datetime

PORT = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(BASE_DIR, "index.html")) and os.path.exists(os.path.join(BASE_DIR, "whiteboard", "index.html")):
    BASE_DIR = os.path.join(BASE_DIR, "whiteboard")
REPO_DIR = os.path.dirname(BASE_DIR) if os.path.basename(BASE_DIR) == 'whiteboard' else BASE_DIR
TEMPLATES_DIR = os.path.join(BASE_DIR, 'templates')

os.makedirs(TEMPLATES_DIR, exist_ok=True)

# Curated catalog of all course diagrams
TEMPLATES_CATALOG = [
    # 0. Prova Real Oficial (UFSM)
    {
        "filename": "prova_q1_add3.jpg",
        "title": "🏆 Prova Q1: add3 $rd, $rs, $rt (Monociclo)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questão 1 da prova real (3.0 pts). Adicionar instrução rd = rs + rt + rd modificando o banco de registradores e inserindo 2ª ULA."
    },
    {
        "filename": "prova_q2_subabs.jpg",
        "title": "🏆 Prova Q2: subabs $rd, $rs, $rt (Monociclo)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questão 2 da prova real (3.0 pts). Adicionar instrução rd = |rs - rt|. Cuidado com a seleção pelo bit de sinal!"
    },
    {
        "filename": "prova_q3_relu.jpg",
        "title": "🏆 Prova Q3: relu $rs (Multiciclo + FSM)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questão 3 da prova real (4.0 pts). Instrução if (rs > 0) rs = rs else rs = 0 no multiciclo com novos estados na FSM."
    },
    {
        "filename": "prova1_pag_1.jpg",
        "title": "🏆 Prova Completa - Página 1 (Q1 add3)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Enunciado e datapath original da Questão 1 da prova."
    },
    {
        "filename": "prova1_pag_2.jpg",
        "title": "🏆 Prova Completa - Página 2 (Q2 subabs)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Enunciado e datapath original da Questão 2 da prova."
    },
    {
        "filename": "prova1_pag_3.jpg",
        "title": "🏆 Prova Completa - Página 3 (Q3 relu)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Enunciado e diagrama multiciclo original da Questão 3 da prova."
    },
    {
        "filename": "prova2024_pag_1_desempenho_sinais.jpg",
        "title": "🏆 Prova 2024 - Pág 1: Desempenho e Sinais (Add, Beq, Lw)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questões 1, 2 e 3 da Prova 2024 (Nota 10,0). Cálculo de CPI e falhas de sinais no Mono e Multiciclo."
    },
    {
        "filename": "prova2024_pag_2_jal_datapath.jpg",
        "title": "🏆 Prova 2024 - Pág 2: Datapaths JAL (Mono e Multi)",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questão 4 da Prova 2024 (4.5 pts). Adicionar instrução JAL no Monociclo e no Multiciclo."
    },
    {
        "filename": "prova2024_pag_3_jal_fsm.jpg",
        "title": "🏆 Prova 2024 - Pág 3: FSM Multiciclo JAL",
        "category": "🏆 Prova Real (UFSM)",
        "badge": "Prova",
        "desc": "Questão 4 da Prova 2024. Máquina de estados completa para adicionar os passos de JAL."
    },

    # 1. Incompletos para Praticar / Preencher
    {
        "filename": "incompleto_mono_sem_controle.jpg",
        "title": "Monociclo em Branco (Sem Linhas de Controle)",
        "category": "Incompletos (Para Praticar)",
        "badge": "Treino",
        "desc": "Datapath completo com blocos e MUXes, mas sem fios de controle. Ideal para desenhar os sinais de cada instrução."
    },
    {
        "filename": "incompleto_multi_sem_controle.jpg",
        "title": "Multiciclo em Branco (Bloco Operacional com MUXes)",
        "category": "Incompletos (Para Praticar)",
        "badge": "Treino",
        "desc": "Bloco operacional com IR, MDR, A, B, ALUOut e MUXes, pronto para traçar a propagação dos passos."
    },
    {
        "filename": "incompleto_mono_add_sub_lw_sw.jpg",
        "title": "Monociclo Básico (ADD, SUB, LW, SW)",
        "category": "Incompletos (Para Praticar)",
        "badge": "Treino",
        "desc": "Datapath simplificado sem branch e sem jump, para praticar as primeiras instruções."
    },
    {
        "filename": "incompleto_mono_apenas_regs_alu.jpg",
        "title": "Monociclo Inicial (Apenas Banco de Registradores e ULA)",
        "category": "Incompletos (Para Praticar)",
        "badge": "Treino",
        "desc": "Blocos essenciais de operações Tipo R para entender o fluxo de dados entre registradores e ULA."
    },
    {
        "filename": "incompleto_multi_apenas_registradores.jpg",
        "title": "Multiciclo Inicial (Registradores Internos)",
        "category": "Incompletos (Para Praticar)",
        "badge": "Treino",
        "desc": "Esquemático com os registradores temporários IR, MDR, A, B, ALUOut para praticar a lógica de multiplexação."
    },

    # 2. Completos de Referência
    {
        "filename": "completo_mono_datapath_controle.jpg",
        "title": "Monociclo Completo com Controle",
        "category": "Completos (Referência)",
        "badge": "Completo",
        "desc": "Caminho de dados monociclo com unidade de controle principal, ALU Control e todos os barramentos azuis."
    },
    {
        "filename": "completo_mono_com_jump.jpg",
        "title": "Monociclo Completo com Jump",
        "category": "Completos (Referência)",
        "badge": "Completo",
        "desc": "Datapath completo com suporte à instrução incondicional Jump (formato J) e MUX do PC."
    },
    {
        "filename": "completo_mono_tabela_sinais.jpg",
        "title": "Tabela da Verdade dos Sinais de Controle (Monociclo)",
        "category": "Completos (Referência)",
        "badge": "Tabela",
        "desc": "Tabela oficial dos sinais RegDst, ALUSrc, MemtoReg, RegWrite, MemRead, MemWrite, Branch, ALUOp."
    },
    {
        "filename": "completo_multi_datapath.jpg",
        "title": "Multiciclo Completo com Controle",
        "category": "Completos (Referência)",
        "badge": "Completo",
        "desc": "Caminho de dados multiciclo completo com sinais IorD, ALUSelA, ALUSelB, PCSource, IRWrite, etc."
    },
    {
        "filename": "completo_multi_fsm_10_estados.png",
        "title": "FSM Multiciclo Completa (10 Estados)",
        "category": "Completos (Referência)",
        "badge": "FSM",
        "desc": "Máquina de estados finitos detalhada de 10 estados (0 a 9) com todas as condições de transição e sinais."
    },
    {
        "filename": "completo_multi_excecoes.jpg",
        "title": "Multiciclo Completo com Exceções",
        "category": "Completos (Referência)",
        "badge": "Exceções",
        "desc": "Hardware estendido para suporte a exceções (EPC, Cause, registrador de status, vetor 0x80000180)."
    },
    {
        "filename": "completo_multi_fsm_excecoes.jpg",
        "title": "FSM Completa com Estados de Exceção (10 e 11)",
        "category": "Completos (Referência)",
        "badge": "FSM",
        "desc": "FSM estendida com os estados 10 (Instrução Indefinida) e 11 (Overflow Aritmético)."
    },

    # 3. Os 5 Passos do Multiciclo
    {
        "filename": "passo_1_busca_fetch.jpg",
        "title": "Passo 1: Busca de Instrução (IR = Mem[PC]; PC = PC + 4)",
        "category": "Passos Multiciclo",
        "badge": "Passo 1",
        "desc": "Destaque do caminho percorrido durante a busca da instrução e incremento do PC."
    },
    {
        "filename": "passo_2_decodificacao_branch.jpg",
        "title": "Passo 2: Decodificação e Branch Antecipado",
        "category": "Passos Multiciclo",
        "badge": "Passo 2",
        "desc": "Leitura de registradores (A e B) e cálculo antecipado do endereço de salto na ULA."
    },
    {
        "filename": "passo_3_tipo_r_execucao.jpg",
        "title": "Passo 3: Execução Tipo R (ALUOut = A op B)",
        "category": "Passos Multiciclo",
        "badge": "Passo 3",
        "desc": "Cálculo da operação aritmética ou lógica na ULA para instruções Tipo R."
    },
    {
        "filename": "passo_4_tipo_r_writeback.jpg",
        "title": "Passo 4: Write-Back Tipo R (Reg[rd] = ALUOut)",
        "category": "Passos Multiciclo",
        "badge": "Passo 4",
        "desc": "Gravação do resultado da ULA no registrador de destino rd."
    },
    {
        "filename": "passo_3_memoria_endereco.jpg",
        "title": "Passo 3: Memória (Cálculo de Endereço A + offset)",
        "category": "Passos Multiciclo",
        "badge": "Passo 3",
        "desc": "Cálculo do endereço efetivo de memória para instruções LW e SW."
    },
    {
        "filename": "passo_4_load_leitura.jpg",
        "title": "Passo 4: Leitura da Memória (MDR = Mem[ALUOut])",
        "category": "Passos Multiciclo",
        "badge": "Passo 4",
        "desc": "Acesso de leitura à memória de dados para instrução LW."
    },
    {
        "filename": "passo_5_load_writeback.jpg",
        "title": "Passo 5: Write-Back LW (Reg[rt] = MDR)",
        "category": "Passos Multiciclo",
        "badge": "Passo 5",
        "desc": "Conclusão do LW: gravação do dado da memória no registrador rt."
    },
    {
        "filename": "passo_4_store_memoria.jpg",
        "title": "Passo 4: Escrita na Memória SW (Mem[ALUOut] = B)",
        "category": "Passos Multiciclo",
        "badge": "Passo 4",
        "desc": "Gravação do dado do registrador B na memória de dados (conclusão do SW)."
    },
    {
        "filename": "passo_3_branch_desvio.jpg",
        "title": "Passo 3: Decisão de Branch (if A == B then PC = ALUOut)",
        "category": "Passos Multiciclo",
        "badge": "Passo 3",
        "desc": "Comparação de registradores na ULA e atualização condicional do PC."
    },
    {
        "filename": "passo_3_jump_salto.jpg",
        "title": "Passo 3: Salto Incondicional Jump",
        "category": "Passos Multiciclo",
        "badge": "Passo 3",
        "desc": "Atualização do PC com o endereço de 26 bits deslocado."
    },

    # 4. Exercícios dos Slides
    {
        "filename": "exercicio_4_1_and.jpg",
        "title": "Exercício 4.1: Sinais e Recursos da Instrução AND",
        "category": "Exercícios dos Slides",
        "badge": "Ex 4.1",
        "desc": "Identificar sinais de controle e blocos ativos/inativos para a instrução AND Rd, Rs, Rt."
    },
    {
        "filename": "exercicio_4_2_lwi.jpg",
        "title": "Exercício 4.2: Implementando Nova Instrução LWI Rt, Rd(Rs)",
        "category": "Exercícios dos Slides",
        "badge": "Ex 4.2",
        "desc": "Load Word com deslocamento em registrador. Quais blocos e sinais adicionar ao datapath?"
    },
    {
        "filename": "exercicio_4_3_speedup.jpg",
        "title": "Exercício 4.3: Latências, Multiplicador e Speedup",
        "category": "Exercícios dos Slides",
        "badge": "Ex 4.3",
        "desc": "Calcular tempo de ciclo com e sem multiplicador e avaliar o ganho real de desempenho."
    },
    {
        "filename": "exercicio_4_4_caminho_critico.jpg",
        "title": "Exercício 4.4: Caminho Crítico e Tempo de Relógio",
        "category": "Exercícios dos Slides",
        "badge": "Ex 4.4",
        "desc": "Calcular o ciclo para processadores que só fazem fetch, branch relativo ou condicional."
    },
    {
        "filename": "exercicio_5_8_jr.jpg",
        "title": "Exercício 5.8: Adicionando Instrução JR $ra (Jump Register)",
        "category": "Exercícios dos Slides",
        "badge": "Ex 5.8",
        "desc": "Desenhar as modificações necessárias no caminho de dados para suportar PC = Reg[rs]."
    },
    {
        "filename": "exercicio_5_11_lwpi.jpg",
        "title": "Exercício 5.11 a 5.14: LWPI (Pós-Incremento) e SWAP",
        "category": "Exercícios dos Slides",
        "badge": "Ex 5.11",
        "desc": "Por que o Monociclo não suporta LWPI sem duplicar portas e como o Multiciclo resolve em 6 ciclos."
    },
    {
        "filename": "exercicio_5_29_stuck_at.jpg",
        "title": "Exercício 5.29: Falhas Presas (Stuck-at) no Multiciclo",
        "category": "Exercícios dos Slides",
        "badge": "Ex 5.29",
        "desc": "Efeito de sinais presos em 0 ou 1 (IRWrite=0, PCWrite=0, PCWriteCond=0, etc.)."
    },
    {
        "filename": "exercicio_5_49_eret.jpg",
        "title": "Exercício 5.49 e 5.50: Instrução ERET e Tratamento de Exceções",
        "category": "Exercícios dos Slides",
        "badge": "Ex 5.49",
        "desc": "Implementação do retorno de exceção PC = EPC no caminho de dados e FSM."
    }
]

def get_local_ip():
    """Detects real local LAN IP of the current machine (e.g. 192.168.x.x)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return '127.0.0.1'

# In-memory canonical state of board elements
current_board_elements = []
connected_clients = {}  # clientId -> { "ws": WebSocket, "name": str, "color": str }
ACTUAL_PORT = PORT

def load_initial_elements():
    """Load existing vector elements from current_board.json if present."""
    global current_board_elements
    json_path = os.path.join(BASE_DIR, 'current_board.json')
    if os.path.exists(json_path):
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict) and 'elements' in data:
                    current_board_elements = data['elements']
                elif isinstance(data, list):
                    current_board_elements = data
        except Exception as e:
            print(f"Aviso ao carregar current_board.json inicial: {e}")

load_initial_elements()
for element in current_board_elements:
    element.setdefault('id', str(uuid.uuid4()))


def apply_board_patch(changes):
    """Apply only changes whose previous value still matches the shared board."""
    result = []
    for change in changes:
        element_id = change.get('id')
        if not element_id:
            continue
        index = next((i for i, el in enumerate(current_board_elements) if el.get('id') == element_id), None)
        current = current_board_elements[index] if index is not None else None
        after = change.get('after')
        if current == change.get('before') and (after is None or after.get('id') == element_id):
            if after is None:
                if index is not None:
                    current_board_elements.pop(index)
            elif index is not None:
                current_board_elements[index] = after
            else:
                position = change.get('afterIndex', len(current_board_elements))
                current_board_elements.insert(position, after)
        index = next((i for i, el in enumerate(current_board_elements) if el.get('id') == element_id), None)
        result.append({'id': element_id, 'after': current_board_elements[index] if index is not None else None,
                       'afterIndex': index})
    return result


def save_elements_to_disk():
    """Save vector elements to current_board.json (does NOT create image prints)."""
    try:
        current_json = os.path.join(BASE_DIR, 'current_board.json')
        with open(current_json, 'w', encoding='utf-8') as f:
            json.dump({'elements': current_board_elements}, f, indent=2, ensure_ascii=False)

        root_json = os.path.join(REPO_DIR, 'current_board.json')
        try:
            with open(root_json, 'w', encoding='utf-8') as f:
                json.dump({'elements': current_board_elements}, f, indent=2, ensure_ascii=False)
        except Exception:
            pass
    except Exception as e:
        print(f"Erro ao persistir current_board.json: {e}")

save_task = None
def schedule_save_elements():
    global save_task
    try:
        loop = asyncio.get_running_loop()
        if save_task and not save_task.done():
            save_task.cancel()

        async def _delayed_save():
            await asyncio.sleep(1.0)
            save_elements_to_disk()

        save_task = loop.create_task(_delayed_save())
    except Exception:
        save_elements_to_disk()

async def broadcast(message: dict, exclude: str = None):
    text = json.dumps(message, ensure_ascii=False)
    to_remove = []
    for cid, client in list(connected_clients.items()):
        if exclude and cid == exclude:
            continue
        try:
            await client["ws"].send_text(text)
        except Exception:
            to_remove.append(cid)
    for cid in to_remove:
        if cid in connected_clients:
            del connected_clients[cid]

# ==================== FastAPI App Setup ====================
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn

    app = FastAPI(title="Whiteboard MIPS - Colaborativo")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/network-info")
    async def api_network_info():
        ip = get_local_ip()
        return {
            "local_ip": ip,
            "port": ACTUAL_PORT,
            "local_url": f"http://{ip}:{ACTUAL_PORT}",
            "clients_count": len(connected_clients)
        }

    @app.get("/api/templates")
    async def api_templates():
        templates = []
        for item in TEMPLATES_CATALOG:
            fpath = os.path.join(TEMPLATES_DIR, item['filename'])
            if os.path.exists(fpath):
                templates.append({
                    'filename': item['filename'],
                    'url': f"/templates/{item['filename']}",
                    'title': item['title'],
                    'category': item['category'],
                    'badge': item.get('badge', ''),
                    'desc': item.get('desc', '')
                })
        return templates

    @app.get("/api/status")
    async def api_status():
        board_png = os.path.join(BASE_DIR, 'current_board.png')
        feedback_file = os.path.join(BASE_DIR, 'ai_feedback.json')

        has_board = os.path.exists(board_png)
        mtime = os.path.getmtime(board_png) if has_board else 0

        has_feedback = os.path.exists(feedback_file)
        feedback_mtime = os.path.getmtime(feedback_file) if has_feedback else 0

        return {
            'has_board': has_board,
            'board_last_modified': datetime.fromtimestamp(mtime).isoformat() if has_board else None,
            'has_feedback': has_feedback,
            'feedback_last_modified': datetime.fromtimestamp(feedback_mtime).isoformat() if has_feedback else None
        }

    @app.get("/api/ai-feedback")
    async def api_get_ai_feedback():
        feedback_file = os.path.join(BASE_DIR, 'ai_feedback.json')
        if os.path.exists(feedback_file):
            try:
                with open(feedback_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                return {"error": str(e), "notes": []}
        return {"notes": [], "timestamp": None}

    @app.post("/api/ai-feedback")
    async def api_post_ai_feedback(request: Request):
        feedback_file = os.path.join(BASE_DIR, 'ai_feedback.json')
        try:
            payload = await request.json()
            with open(feedback_file, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
            return {'status': 'ok', 'saved': True}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f'Erro ao salvar feedback: {e}')

    @app.post("/api/save")
    async def api_save_board(request: Request):
        try:
            payload = await request.json()
            image_data = payload.get('image', '')
            state_data = payload.get('state', {})
            timestamp_str = datetime.now().strftime('%Y%m%d_%H%M%S')

            # Process Base64 PNG image (only when explicitly requested)
            if image_data.startswith('data:image/png;base64,'):
                b64_str = image_data.split('data:image/png;base64,')[1]
                img_bytes = base64.b64decode(b64_str)

                current_png = os.path.join(BASE_DIR, 'current_board.png')
                with open(current_png, 'wb') as f:
                    f.write(img_bytes)

                root_png = os.path.join(REPO_DIR, 'current_board.png')
                try:
                    with open(root_png, 'wb') as f:
                        f.write(img_bytes)
                except Exception:
                    pass

            # Save current_board.json (vector elements)
            if state_data:
                current_json = os.path.join(BASE_DIR, 'current_board.json')
                with open(current_json, 'w', encoding='utf-8') as f:
                    json.dump(state_data, f, indent=2, ensure_ascii=False)

                root_json = os.path.join(REPO_DIR, 'current_board.json')
                try:
                    with open(root_json, 'w', encoding='utf-8') as f:
                        json.dump(state_data, f, indent=2, ensure_ascii=False)
                except Exception:
                    pass

                new_elements = state_data.get('elements')
                if new_elements is not None:
                    current_board_elements.clear()
                    current_board_elements.extend(new_elements)

            return {
                'status': 'ok',
                'timestamp': timestamp_str,
                'message': 'Quadro salvo com sucesso! O assistente de IA já consegue visualizar o desenho.',
                'image_path': 'whiteboard/current_board.png'
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f'Erro ao salvar quadro: {e}')

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        client_id = str(uuid.uuid4())[:8]
        connected_clients[client_id] = {
            "ws": websocket,
            "name": "Amigo",
            "color": "#2563eb"
        }

        try:
            # 1. Send initial board state & client ID
            await websocket.send_text(json.dumps({
                "type": "init",
                "clientId": client_id,
                "elements": current_board_elements,
                "userCount": len(connected_clients)
            }, ensure_ascii=False))

            # 2. Notify all others about presence
            await broadcast({
                "type": "presence",
                "userCount": len(connected_clients),
                "joined": client_id
            }, exclude=client_id)

            # 3. Message loop
            while True:
                data_text = await websocket.receive_text()
                try:
                    msg = json.loads(data_text)
                except Exception:
                    continue

                msg_type = msg.get("type")

                if msg_type == "join":
                    connected_clients[client_id]["name"] = msg.get("name", "Amigo")
                    connected_clients[client_id]["color"] = msg.get("color", "#2563eb")
                    await broadcast({
                        "type": "presence",
                        "userCount": len(connected_clients),
                        "user": {
                            "clientId": client_id,
                            "name": connected_clients[client_id]["name"],
                            "color": connected_clients[client_id]["color"]
                        }
                    })

                elif msg_type == "cursor":
                    msg["clientId"] = client_id
                    await broadcast(msg, exclude=client_id)

                elif msg_type == "stroke_live":
                    msg["clientId"] = client_id
                    await broadcast(msg, exclude=client_id)

                elif msg_type == "board_patch":
                    changes = apply_board_patch(msg.get('changes', []))
                    schedule_save_elements()
                    # Echo the canonical result, including rejected stale edits.
                    await broadcast({'type': 'board_patch', 'changes': changes, 'clientId': client_id})

                elif msg_type == "element_add":
                    el = msg.get("element")
                    if el:
                        current_board_elements.append(el)
                        schedule_save_elements()
                    msg["clientId"] = client_id
                    await broadcast(msg, exclude=client_id)

                elif msg_type == "board_sync":
                    elements = msg.get("elements")
                    if elements is not None:
                        current_board_elements.clear()
                        current_board_elements.extend(elements)
                        schedule_save_elements()
                    msg["clientId"] = client_id
                    await broadcast(msg, exclude=client_id)

                elif msg_type == "board_clear":
                    current_board_elements.clear()
                    schedule_save_elements()
                    msg["clientId"] = client_id
                    await broadcast(msg, exclude=client_id)

        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            if client_id in connected_clients:
                del connected_clients[client_id]
            await broadcast({
                "type": "presence",
                "userCount": len(connected_clients),
                "left": client_id
            })
            await broadcast({
                "type": "cursor_remove",
                "clientId": client_id
            })

    # Serve index.html with no-cache headers for instant updates
    @app.get("/")
    async def get_index():
        return FileResponse(
            os.path.join(BASE_DIR, "index.html"),
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
        )

    # Mount static files (style.css, app.js, templates, etc.)
    app.mount("/", StaticFiles(directory=BASE_DIR), name="static")

    HAS_FASTAPI = True

except ImportError:
    HAS_FASTAPI = False


def run_server(port=PORT, open_browser=True):
    global ACTUAL_PORT
    actual_port = port

    # Keep the port shared with the tunnel; never silently choose another one.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("", port))
        except OSError as error:
            raise SystemExit(f"Porta {port} ocupada. Execute ./fechar_servidor.sh antes de iniciar.") from error

    ACTUAL_PORT = actual_port
    local_ip = get_local_ip()

    url_local = f"http://localhost:{actual_port}"
    url_wifi = f"http://{local_ip}:{actual_port}"

    print("=" * 68)
    print(" 🚀 QUADRO BRANCO MIPS - SESSÃO COLABORATIVA EM TEMPO REAL")
    print(f" 📡 No seu computador:        {url_local}")
    print(f" 👥 Para amigos no mesmo Wi-Fi: {url_wifi}")
    print("-" * 68)
    print(" 🌐 Para amigos fora de casa (pela Internet):")
    print(f"    Rode no terminal: npx localtunnel --port {actual_port}")
    print(f"    ou:               cloudflared tunnel --url http://localhost:{actual_port}")
    print("=" * 68)
    print(" Dica: Desenhe, cole prints (Ctrl+V) ou carregue diagramas da matéria.")
    print(" Todos os desenhos e ponteiros dos amigos sincronizam em tempo real!")
    print(" Pressione Ctrl+C no terminal para encerrar.")
    print("=" * 68)

    if open_browser:
        webbrowser.open(url_local)

    if HAS_FASTAPI:
        import uvicorn
        uvicorn.run(app, host="0.0.0.0", port=actual_port, log_level="warning")
    else:
        # Fallback to standard library http.server
        import http.server
        import socketserver

        class FallbackHandler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=BASE_DIR, **kwargs)

        with socketserver.TCPServer(("", actual_port), FallbackHandler) as httpd:
            httpd.serve_forever()

if __name__ == '__main__':
    open_b = '--no-browser' not in sys.argv
    run_server(PORT, open_browser=open_b)
