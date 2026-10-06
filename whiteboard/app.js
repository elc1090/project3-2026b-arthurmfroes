/**
 * Whiteboard de Arquitetura de Computadores (Mono & Multiciclo)
 * Catálogo visual completo de diagramas (em branco e completos),
 * carregamento instantâneo, ferramentas de desenho e sincronização com IA.
 */

// Canvas & Context
const canvas = document.getElementById('whiteboardCanvas');
const ctx = canvas.getContext('2d');
const wrapper = document.getElementById('canvasWrapper');

// State
let width = 0;
let height = 0;
let dpr = window.devicePixelRatio || 1;

// Viewport Transform (Pan & Zoom)
let zoom = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;
let spacePressed = false;

// Drawing State
let currentTool = 'pen';
let currentColor = '#1e293b';
let currentSize = 2;
let isDrawing = false;
let startX = 0;
let startY = 0;

// Data Layers
let elements = []; // { type: 'path'|'line'|'arrow'|'rect'|'mux'|'alu'|'text'|'image', ... }
let undoStack = [];
let redoStack = [];
let pendingUndoState = null;
const MAX_UNDO_STACK = 100;
let currentPath = null;
let drawStartState = null;
let selectedElement = null;
let isDraggingElement = false;
let dragStartState = null;
let dragOriginalPos = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

// Auto-save debounce timer
let autoSaveTimer = null;

// ==================== WebSocket Collaboration State ====================
let ws = null;
let wsClientId = null;
let wsConnected = false;
let wsReconnectTimer = null;
let myUserName = localStorage.getItem('whiteboard_username') || ('Amigo ' + Math.floor(100 + Math.random() * 900));
let myUserColor = localStorage.getItem('whiteboard_usercolor') || '#2563eb';
const peerCursors = new Map(); // clientId -> { x, y, name, color, tool, lastSeen }
const peerLiveStrokes = new Map(); // clientId -> { type, points, color, size, tool }
let lastCursorBroadcastTime = 0;
let lastStrokeBroadcastTime = 0;
let hasSentInitialSync = false;

// Static Curated Templates Catalog (Fallback guarantee!)
const STATIC_TEMPLATES = [
  // 0. Prova Real Oficial (UFSM)
  {
    filename: "prova_q1_add3.jpg",
    title: "🏆 Prova Q1: add3 $rd, $rs, $rt (Monociclo)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Questão 1 da prova real (3.0 pts). Adicionar instrução rd = rs + rt + rd modificando o banco de registradores e inserindo 2ª ULA."
  },
  {
    filename: "prova_q2_subabs.jpg",
    title: "🏆 Prova Q2: subabs $rd, $rs, $rt (Monociclo)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Questão 2 da prova real (3.0 pts). Adicionar instrução rd = |rs - rt|. Cuidado com o cálculo de módulo e seleção pelo bit de sinal!"
  },
  {
    filename: "prova_q3_relu.jpg",
    title: "🏆 Prova Q3: relu $rs (Multiciclo + FSM)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Questão 3 da prova real (4.0 pts). Instrução if (rs > 0) rs = rs else rs = 0 no multiciclo com novos estados na FSM."
  },
  {
    filename: "prova1_pag_1.jpg",
    title: "🏆 Prova Completa - Página 1 (Q1 add3)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Enunciado e datapath original da Questão 1 da prova."
  },
  {
    filename: "prova1_pag_2.jpg",
    title: "🏆 Prova Completa - Página 2 (Q2 subabs)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Enunciado e datapath original da Questão 2 da prova."
  },
  {
    filename: "prova1_pag_3.jpg",
    title: "🏆 Prova Completa - Página 3 (Q3 relu)",
    category: "🏆 Prova Real (UFSM)",
    badge: "prova",
    badgeText: "PROVA",
    desc: "Enunciado e diagrama multiciclo original da Questão 3 da prova."
  },

  // 1. Incompletos (Para Praticar / Preencher)
  {
    filename: "incompleto_mono_sem_controle.jpg",
    title: "Monociclo em Branco (Sem Linhas de Controle)",
    category: "Incompletos (Para Praticar)",
    badge: "treino",
    badgeText: "Treino",
    desc: "Datapath completo com blocos e MUXes, mas sem fios de controle. Ideal para desenhar os sinais de cada instrução."
  },
  {
    filename: "incompleto_multi_sem_controle.jpg",
    title: "Multiciclo em Branco (Bloco Operacional com MUXes)",
    category: "Incompletos (Para Praticar)",
    badge: "treino",
    badgeText: "Treino",
    desc: "Bloco operacional com IR, MDR, A, B, ALUOut e MUXes, pronto para traçar a propagação dos passos."
  },
  {
    filename: "incompleto_mono_add_sub_lw_sw.jpg",
    title: "Monociclo Básico (ADD, SUB, LW, SW)",
    category: "Incompletos (Para Praticar)",
    badge: "treino",
    badgeText: "Treino",
    desc: "Datapath simplificado sem branch e sem jump, para praticar as primeiras instruções."
  },
  {
    filename: "incompleto_mono_apenas_regs_alu.jpg",
    title: "Monociclo Inicial (Apenas Banco de Registradores e ULA)",
    category: "Incompletos (Para Praticar)",
    badge: "treino",
    badgeText: "Treino",
    desc: "Blocos essenciais de operações Tipo R para entender o fluxo de dados entre registradores e ULA."
  },
  {
    filename: "incompleto_multi_apenas_registradores.jpg",
    title: "Multiciclo Inicial (Registradores Internos)",
    category: "Incompletos (Para Praticar)",
    badge: "treino",
    badgeText: "Treino",
    desc: "Esquemático com os registradores temporários IR, MDR, A, B, ALUOut para praticar a lógica de multiplexação."
  },

  // 2. Completos (Referência & Estudo)
  {
    filename: "completo_mono_datapath_controle.jpg",
    title: "Monociclo Completo com Controle",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "Completo",
    desc: "Caminho de dados monociclo com unidade de controle principal, ALU Control e todos os barramentos azuis."
  },
  {
    filename: "completo_mono_com_jump.jpg",
    title: "Monociclo Completo com Jump",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "Completo",
    desc: "Datapath completo com suporte à instrução incondicional Jump (formato J) e MUX do PC."
  },
  {
    filename: "completo_mono_tabela_sinais.jpg",
    title: "Tabela de Sinais de Controle (Monociclo)",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "Tabela",
    desc: "Tabela oficial dos sinais RegDst, ALUSrc, MemtoReg, RegWrite, MemRead, MemWrite, Branch, ALUOp."
  },
  {
    filename: "completo_multi_datapath.jpg",
    title: "Multiciclo Completo com Controle",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "Completo",
    desc: "Caminho de dados multiciclo completo com sinais IorD, ALUSelA, ALUSelB, PCSource, IRWrite, etc."
  },
  {
    filename: "completo_multi_fsm_10_estados.png",
    title: "FSM Multiciclo Completa (10 Estados)",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "FSM",
    desc: "Máquina de estados finitos detalhada de 10 estados (0 a 9) com todas as condições de transição e sinais."
  },
  {
    filename: "completo_multi_excecoes.jpg",
    title: "Multiciclo Completo com Exceções",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "Exceções",
    desc: "Hardware estendido para suporte a exceções (EPC, Cause, registrador de status, vetor 0x80000180)."
  },
  {
    filename: "completo_multi_fsm_excecoes.jpg",
    title: "FSM Completa com Exceções (Estados 10 e 11)",
    category: "Completos (Referência)",
    badge: "completo",
    badgeText: "FSM",
    desc: "FSM estendida com os estados 10 (Instrução Indefinida) e 11 (Overflow Aritmético)."
  },

  // 3. Passos do Multiciclo
  {
    filename: "passo_1_busca_fetch.jpg",
    title: "Passo 1: Busca de Instrução (IR = Mem[PC]; PC = PC + 4)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 1",
    desc: "Destaque do caminho percorrido durante a busca da instrução e incremento do PC."
  },
  {
    filename: "passo_2_decodificacao_branch.jpg",
    title: "Passo 2: Decodificação e Branch Antecipado",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 2",
    desc: "Leitura de registradores (A e B) e cálculo antecipado do endereço de salto na ULA."
  },
  {
    filename: "passo_3_tipo_r_execucao.jpg",
    title: "Passo 3: Execução Tipo R (ALUOut = A op B)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 3",
    desc: "Cálculo da operação aritmética ou lógica na ULA para instruções Tipo R."
  },
  {
    filename: "passo_4_tipo_r_writeback.jpg",
    title: "Passo 4: Write-Back Tipo R (Reg[rd] = ALUOut)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 4",
    desc: "Gravação do resultado da ULA no registrador de destino rd."
  },
  {
    filename: "passo_3_memoria_endereco.jpg",
    title: "Passo 3: Memória (Cálculo de Endereço A + offset)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 3",
    desc: "Cálculo do endereço efetivo de memória para instruções LW e SW."
  },
  {
    filename: "passo_4_load_leitura.jpg",
    title: "Passo 4: Leitura da Memória (MDR = Mem[ALUOut])",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 4",
    desc: "Acesso de leitura à memória de dados para instrução LW."
  },
  {
    filename: "passo_5_load_writeback.jpg",
    title: "Passo 5: Write-Back LW (Reg[rt] = MDR)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 5",
    desc: "Conclusão do LW: gravação do dado da memória no registrador rt."
  },
  {
    filename: "passo_4_store_memoria.jpg",
    title: "Passo 4: Escrita na Memória SW (Mem[ALUOut] = B)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 4",
    desc: "Gravação do dado do registrador B na memória de dados (conclusão do SW)."
  },
  {
    filename: "passo_3_branch_desvio.jpg",
    title: "Passo 3: Decisão de Branch (if A == B then PC = ALUOut)",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 3",
    desc: "Comparação de registradores na ULA e atualização condicional do PC."
  },
  {
    filename: "passo_3_jump_salto.jpg",
    title: "Passo 3: Salto Incondicional Jump",
    category: "Passos Multiciclo",
    badge: "passo",
    badgeText: "Passo 3",
    desc: "Atualização do PC com o endereço de 26 bits deslocado."
  },

  // 4. Exercícios dos Slides
  {
    filename: "exercicio_4_1_and.jpg",
    title: "Exercício 4.1: Sinais e Recursos da Instrução AND",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 4.1",
    desc: "Identificar sinais de controle e blocos ativos/inativos para a instrução AND Rd, Rs, Rt."
  },
  {
    filename: "exercicio_4_2_lwi.jpg",
    title: "Exercício 4.2: Implementando Nova Instrução LWI Rt, Rd(Rs)",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 4.2",
    desc: "Load Word com deslocamento em registrador. Quais blocos e sinais adicionar ao datapath?"
  },
  {
    filename: "exercicio_4_3_speedup.jpg",
    title: "Exercício 4.3: Latências, Multiplicador e Speedup",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 4.3",
    desc: "Calcular tempo de ciclo com e sem multiplicador e avaliar o ganho real de desempenho."
  },
  {
    filename: "exercicio_4_4_caminho_critico.jpg",
    title: "Exercício 4.4: Caminho Crítico e Tempo de Relógio",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 4.4",
    desc: "Calcular o ciclo para processadores que só fazem fetch, branch relativo ou condicional."
  },
  {
    filename: "exercicio_5_8_jr.jpg",
    title: "Exercício 5.8: Adicionando Instrução JR $ra (Jump Register)",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 5.8",
    desc: "Desenhar as modificações necessárias no caminho de dados para suportar PC = Reg[rs]."
  },
  {
    filename: "exercicio_5_11_lwpi.jpg",
    title: "Exercício 5.11 a 5.14: LWPI (Pós-Incremento) e SWAP",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 5.11",
    desc: "Por que o Monociclo não suporta LWPI sem duplicar portas e como o Multiciclo resolve em 6 ciclos."
  },
  {
    filename: "exercicio_5_29_stuck_at.jpg",
    title: "Exercício 5.29: Falhas Presas (Stuck-at) no Multiciclo",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 5.29",
    desc: "Efeito de sinais presos em 0 ou 1 (IRWrite=0, PCWrite=0, PCWriteCond=0, etc.)."
  },
  {
    filename: "exercicio_5_49_eret.jpg",
    title: "Exercício 5.49 e 5.50: Instrução ERET e Tratamento de Exceções",
    category: "Exercícios dos Slides",
    badge: "ex",
    badgeText: "Ex 5.49",
    desc: "Implementação do retorno de exceção PC = EPC no caminho de dados e FSM."
  }
];

// DOM Elements
const templateSelect = document.getElementById('templateSelect');
const optgroupExam = document.getElementById('optgroup-exam');
const optgroupIncomplete = document.getElementById('optgroup-incomplete');
const optgroupComplete = document.getElementById('optgroup-complete');
const optgroupSteps = document.getElementById('optgroup-steps');
const optgroupExercises = document.getElementById('optgroup-exercises');
const btnOpenGallery = document.getElementById('btnOpenGallery');
const galleryModal = document.getElementById('galleryModal');
const btnCloseGallery = document.getElementById('btnCloseGallery');
const galleryGrid = document.getElementById('galleryGrid');

const btnSaveAI = document.getElementById('btnSaveAI');
const btnExportPNG = document.getElementById('btnExportPNG');
const btnClearCanvas = document.getElementById('btnClearCanvas');
const syncBadge = document.getElementById('syncBadge');
const syncText = document.getElementById('syncText');
const fileInput = document.getElementById('fileInput');
const zoomLevelEl = document.getElementById('zoomLevel');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnZoomReset = document.getElementById('btnZoomReset');
const btnZoomFit = document.getElementById('btnZoomFit');
const toolPalette = document.getElementById('toolPalette');
const btnTogglePalette = document.getElementById('btnTogglePalette');
const studySidebar = document.getElementById('studySidebar');
const btnToggleSidebar = document.getElementById('btnToggleSidebar');
const btnCloseSidebar = document.getElementById('btnCloseSidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const canvasHint = document.getElementById('canvasHint');

// Collaboration DOM Elements
const btnCollaborate = document.getElementById('btnCollaborate');
const collabModal = document.getElementById('collabModal');
const btnCloseCollab = document.getElementById('btnCloseCollab');
const collabBadge = document.getElementById('collabBadge');
const collabLocalUrl = document.getElementById('collabLocalUrl');
const btnCopyLocalUrl = document.getElementById('btnCopyLocalUrl');
const btnCopyTunnelCmd = document.getElementById('btnCopyTunnelCmd');
const btnCopyCloudflareCmd = document.getElementById('btnCopyCloudflareCmd');
const collabUsernameInput = document.getElementById('collabUsernameInput');
const collabColorPicker = document.getElementById('collabColorPicker');
const collabStatusText = document.getElementById('collabStatusText');
const collabStatusIndicator = document.getElementById('collabStatusIndicator');

// Initialize
window.addEventListener('load', () => {
  resizeCanvas();
  populateDropdown(STATIC_TEMPLATES);
  buildGalleryModal(STATIC_TEMPLATES);
  loadTemplateOptions(); // fetch dynamic from server if available
  loadSavedBoard();
  setupEventListeners();
  setupHotkeys();
  updateUndoRedoUI();
  setupCollabUI();
  initWebSocket();

  // Watch for container resizes dynamically
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      resizeCanvas();
    });
    ro.observe(wrapper);
  }

  // Fade out hint after 8s
  setTimeout(() => {
    if (canvasHint) canvasHint.style.opacity = '0';
  }, 8000);
});

window.addEventListener('resize', resizeCanvas);

function resizeCanvas() {
  width = wrapper.clientWidth;
  height = wrapper.clientHeight;
  dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  render();
}

// Coordinate conversions (Screen <-> Virtual Canvas)
function screenToCanvas(sx, sy) {
  return {
    x: (sx - panX) / zoom,
    y: (sy - panY) / zoom
  };
}

function canvasToScreen(cx, cy) {
  return {
    x: cx * zoom + panX,
    y: cy * zoom + panY
  };
}

// Image cache for fast, flicker-free undo/redo
const imageCache = new Map();

function ensureElementIds() {
  const seen = new Set();
  for (const el of elements) {
    if (!el.id || seen.has(el.id)) {
      el.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
    seen.add(el.id);
  }
}

function serializeBoardState() {
  ensureElementIds();
  return JSON.stringify(elements, (key, value) => {
    if (key === 'imgObj') return undefined;
    return value;
  });
}

function updateUndoRedoUI() {
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  if (btnUndo) {
    btnUndo.disabled = undoStack.length === 0;
    btnUndo.style.opacity = undoStack.length === 0 ? '0.45' : '1';
    btnUndo.style.cursor = undoStack.length === 0 ? 'not-allowed' : 'pointer';
  }
  if (btnRedo) {
    btnRedo.disabled = redoStack.length === 0;
    btnRedo.style.opacity = redoStack.length === 0 ? '0.45' : '1';
    btnRedo.style.cursor = redoStack.length === 0 ? 'not-allowed' : 'pointer';
  }
}

// Each history entry contains only the changes made by this browser.
function boardChanges(before, after) {
  const old = new Map(before.map((el, index) => [el.id, { el, index }]));
  const next = new Map(after.map((el, index) => [el.id, { el, index }]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
    const a = old.get(id), b = next.get(id);
    if (JSON.stringify(a?.el) === JSON.stringify(b?.el)) return [];
    return [{ id, before: a?.el || null, after: b?.el || null,
      beforeIndex: a?.index, afterIndex: b?.index }];
  });
}

function applyBoardChanges(board, changes) {
  const result = board.slice();
  for (const change of changes) {
    const index = result.findIndex(el => el.id === change.id);
    if (change.after === null) {
      if (index >= 0) result.splice(index, 1);
    } else {
      if (index >= 0) result.splice(index, 1);
      const position = change.afterIndex ?? (index >= 0 ? index : result.length);
      // History values must remain immutable when the restored element is edited.
      result.splice(position, 0, JSON.parse(JSON.stringify(change.after)));
    }
  }
  return result;
}

function pushUndoState(stateStr) {
  pendingUndoState = stateStr;
}

function recordState() {
  pushUndoState(serializeBoardState());
  scheduleAutoSave();
}

function commitLocalAction() {
  if (pendingUndoState === null) return false;
  const changes = boardChanges(JSON.parse(pendingUndoState), JSON.parse(serializeBoardState()));
  pendingUndoState = null;
  if (changes.length) {
    undoStack.push(changes);
    if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
    redoStack = [];
    sendWsMessage({ type: 'board_patch', changes });
  }
  updateUndoRedoUI();
  return true;
}

function reverseChanges(changes) {
  return changes.map(change => ({ id: change.id, before: change.after, after: change.before,
    beforeIndex: change.afterIndex, afterIndex: change.beforeIndex }));
}

function travelHistory(from, to, label) {
  if (isDrawing || isDraggingElement || from.length === 0) return;
  const current = JSON.parse(serializeBoardState());
  const changes = reverseChanges(from.pop()).filter(change => {
    const el = current.find(el => el.id === change.id) || null;
    // Preserve subsequent edits by another participant to the same element.
    return JSON.stringify(el) === JSON.stringify(change.before);
  });
  if (changes.length) {
    elements = applyBoardChanges(current, changes);
    to.push(changes);
    if (to.length > MAX_UNDO_STACK) to.shift();
    selectedElement = null;
    rehydrateImages();
    render();
    scheduleAutoSave();
    sendWsMessage({ type: 'board_patch', changes });
  }
  updateUndoRedoUI();
  showSyncBadge(changes.length ? label : 'Ação já alterada por outro participante', 'saving');
}

function undo() {
  travelHistory(undoStack, redoStack, 'Sua ação foi desfeita');
}

function redo() {
  travelHistory(redoStack, undoStack, 'Sua ação foi refeita');
}

// Remote changes also update the starting point of an ongoing gesture,
// so they are never recorded as part of that local action.
function receiveBoardChanges(changes) {
  const rebase = state => state === null ? null : JSON.stringify(applyBoardChanges(JSON.parse(state), changes));
  pendingUndoState = rebase(pendingUndoState);
  drawStartState = rebase(drawStartState);
  dragStartState = rebase(dragStartState);
  eraseStartState = rebase(eraseStartState);
  elements = applyBoardChanges(elements, changes);
  if (selectedElement) selectedElement = elements.find(el => el.id === selectedElement.id) || null;
  rehydrateImages();
  render();
}

function rehydrateImages() {
  elements.forEach(el => {
    if (el.type === 'image') {
      if (el.imgObj && el.imgObj.complete) {
        imageCache.set(el.src, el.imgObj);
        return;
      }
      if (imageCache.has(el.src)) {
        el.imgObj = imageCache.get(el.src);
      } else {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          imageCache.set(el.src, img);
          render();
        };
        img.src = el.src;
        el.imgObj = img;
        if (img.complete) {
          imageCache.set(el.src, img);
        }
      }
    }
  });
}

// Render Canvas
function render() {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // Apply Pan & Zoom
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // Render elements
  elements.forEach(el => drawElement(ctx, el));

  // Render active drawing path/shape preview
  if (isDrawing && currentPath) {
    drawElement(ctx, currentPath);
  }

  // Render peer live strokes in progress
  peerLiveStrokes.forEach(stroke => {
    drawElement(ctx, stroke);
  });

  // Draw selection outline
  if (selectedElement) {
    drawSelectionBox(ctx, selectedElement);
  }

  // Draw peer cursors
  const now = Date.now();
  peerCursors.forEach((peer) => {
    if (now - peer.lastSeen < 15000) {
      drawPeerCursor(ctx, peer);
    }
  });

  ctx.restore();
  updateZoomIndicator();
}

function drawElement(context, el) {
  context.save();

  if (el.type === 'path') {
    if (!el.points || el.points.length < 2) {
      context.restore();
      return;
    }
    context.beginPath();
    context.strokeStyle = el.color;
    context.lineWidth = el.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (el.tool === 'highlighter') {
      context.globalAlpha = 0.35;
      context.lineWidth = el.size * 2.8;
    } else {
      context.globalAlpha = 1.0;
    }

    context.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) {
      context.lineTo(el.points[i].x, el.points[i].y);
    }
    context.stroke();
  }
  else if (el.type === 'line') {
    context.beginPath();
    context.strokeStyle = el.color;
    context.lineWidth = el.size;
    context.lineCap = 'round';
    context.moveTo(el.x1, el.y1);
    context.lineTo(el.x2, el.y2);
    context.stroke();
  }
  else if (el.type === 'arrow') {
    context.beginPath();
    context.strokeStyle = el.color;
    context.fillStyle = el.color;
    context.lineWidth = el.size;
    context.lineCap = 'round';

    // Draw main line
    context.moveTo(el.x1, el.y1);
    context.lineTo(el.x2, el.y2);
    context.stroke();

    // Draw arrowhead
    const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const headLen = Math.max(10, el.size * 3.5);
    context.beginPath();
    context.moveTo(el.x2, el.y2);
    context.lineTo(
      el.x2 - headLen * Math.cos(angle - Math.PI / 6),
      el.y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    context.lineTo(
      el.x2 - headLen * Math.cos(angle + Math.PI / 6),
      el.y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    context.closePath();
    context.fill();
  }
  else if (el.type === 'rect') {
    context.strokeStyle = el.color;
    context.lineWidth = el.size;
    context.fillStyle = 'rgba(255, 255, 255, 0.7)';
    const rx = Math.min(el.x1, el.x2);
    const ry = Math.min(el.y1, el.y2);
    const rw = Math.abs(el.x2 - el.x1);
    const rh = Math.abs(el.y2 - el.y1);
    context.fillRect(rx, ry, rw, rh);
    context.strokeRect(rx, ry, rw, rh);
  }
  else if (el.type === 'mux') {
    const rx = Math.min(el.x1, el.x2);
    const ry = Math.min(el.y1, el.y2);
    const rw = Math.max(30, Math.abs(el.x2 - el.x1));
    const rh = Math.max(50, Math.abs(el.y2 - el.y1));

    context.strokeStyle = el.color;
    context.lineWidth = el.size;
    context.fillStyle = '#ffffff';

    context.beginPath();
    context.moveTo(rx, ry);
    context.lineTo(rx + rw, ry + rh * 0.15);
    context.lineTo(rx + rw, ry + rh * 0.85);
    context.lineTo(rx, ry + rh);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = el.color;
    context.font = 'bold 11px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('MUX', rx + rw / 2, ry + rh / 2);
  }
  else if (el.type === 'alu') {
    const rx = Math.min(el.x1, el.x2);
    const ry = Math.min(el.y1, el.y2);
    const rw = Math.max(50, Math.abs(el.x2 - el.x1));
    const rh = Math.max(60, Math.abs(el.y2 - el.y1));

    context.strokeStyle = el.color;
    context.lineWidth = el.size;
    context.fillStyle = '#ffffff';

    context.beginPath();
    context.moveTo(rx, ry);
    context.lineTo(rx + rw, ry + rh * 0.35);
    context.lineTo(rx + rw, ry + rh * 0.65);
    context.lineTo(rx, ry + rh);
    context.lineTo(rx, ry + rh * 0.60);
    context.lineTo(rx + rw * 0.25, ry + rh * 0.50);
    context.lineTo(rx, ry + rh * 0.40);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = el.color;
    context.font = 'bold 11px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('ULA / ALU', rx + rw * 0.45, ry + rh / 2);
  }
  else if (el.type === 'text') {
    context.fillStyle = el.color;
    context.font = `${el.size * 4 + 11}px 'Fira Code', monospace`;
    context.textBaseline = 'top';
    context.fillText(el.text, el.x, el.y);
  }
  else if (el.type === 'image') {
    if (el.imgObj && el.imgObj.complete) {
      context.drawImage(el.imgObj, el.x, el.y, el.width, el.height);
    } else if (!el.imgObj) {
      const img = new Image();
      img.onload = () => render();
      img.src = el.src;
      el.imgObj = img;
    }
  }

  context.restore();
}

function drawSelectionBox(context, el) {
  let bbox = getElementBoundingBox(el);
  if (!bbox) return;

  context.save();
  context.strokeStyle = '#3b82f6';
  context.lineWidth = 1.5;
  context.setLineDash([4, 4]);
  context.strokeRect(bbox.x - 4, bbox.y - 4, bbox.width + 8, bbox.height + 8);
  context.restore();
}

function getElementBoundingBox(el) {
  if (el.type === 'image') {
    return { x: el.x, y: el.y, width: el.width, height: el.height };
  } else if (el.type === 'rect' || el.type === 'mux' || el.type === 'alu') {
    const x = Math.min(el.x1, el.x2);
    const y = Math.min(el.y1, el.y2);
    return { x, y, width: Math.abs(el.x2 - el.x1), height: Math.abs(el.y2 - el.y1) };
  } else if (el.type === 'text') {
    const fontSize = el.size * 4 + 11;
    const estWidth = el.text.length * (fontSize * 0.6);
    return { x: el.x, y: el.y, width: estWidth, height: fontSize * 1.3 };
  }
  return null;
}

// Compute total bounding box of all elements on canvas
function getElementsBounds() {
  if (elements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  elements.forEach(el => {
    const b = getElementBoundingBox(el);
    if (b) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    } else if (el.type === 'path' && el.points) {
      el.points.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    } else if (el.x1 !== undefined && el.x2 !== undefined) {
      minX = Math.min(minX, el.x1, el.x2);
      minY = Math.min(minY, el.y1, el.y2);
      maxX = Math.max(maxX, el.x1, el.x2);
      maxY = Math.max(maxY, el.y1, el.y2);
    }
  });

  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Fit all elements centered onto screen
function fitToScreen() {
  const bounds = getElementsBounds();
  if (!bounds || bounds.width === 0 || bounds.height === 0) {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    render();
    return;
  }

  const padding = 50;
  const availW = Math.max(100, width - padding * 2);
  const availH = Math.max(100, height - padding * 2);

  const scaleX = availW / bounds.width;
  const scaleY = availH / bounds.height;
  const newZoom = Math.min(scaleX, scaleY, 1.25);

  const cx = bounds.minX + bounds.width / 2;
  const cy = bounds.minY + bounds.height / 2;

  zoom = Math.max(0.15, Math.min(3.0, newZoom));
  panX = width / 2 - cx * zoom;
  panY = height / 2 - cy * zoom;

  render();
  updateEraserCursorSize();
}

// ==================== Dropdown & Gallery Builder ====================
function populateDropdown(catalog) {
  if (optgroupExam) optgroupExam.innerHTML = '';
  optgroupIncomplete.innerHTML = '';
  optgroupComplete.innerHTML = '';
  optgroupSteps.innerHTML = '';
  optgroupExercises.innerHTML = '';

  catalog.forEach(t => {
    const opt = document.createElement('option');
    opt.value = `templates/${t.filename}`;
    opt.textContent = t.title;

    if (t.category.includes('Prova Real') && optgroupExam) {
      optgroupExam.appendChild(opt);
    } else if (t.category.includes('Incompletos')) {
      optgroupIncomplete.appendChild(opt);
    } else if (t.category.includes('Completos')) {
      optgroupComplete.appendChild(opt);
    } else if (t.category.includes('Passos')) {
      optgroupSteps.appendChild(opt);
    } else {
      optgroupExercises.appendChild(opt);
    }
  });
}

function buildGalleryModal(catalog) {
  galleryGrid.innerHTML = '';

  catalog.forEach(t => {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.dataset.category = t.category;

    const badgeClass = `badge-${t.badge || 'completo'}`;

    card.innerHTML = `
      <div>
        <div class="card-top">
          <span class="card-badge ${badgeClass}">${t.badgeText || t.badge || 'Diagrama'}</span>
          <span style="font-size:10px; color:#64748b;">MIPS</span>
        </div>
        <div class="card-title">${t.title}</div>
        <div class="card-desc">${t.desc || ''}</div>
      </div>
      <button class="card-btn">
        <span>✏️ Carregar no Quadro</span>
      </button>
    `;

    card.addEventListener('click', () => {
      loadTemplateToCanvas(`templates/${t.filename}`);
      closeGalleryModal();
    });

    galleryGrid.appendChild(card);
  });
}

function openGalleryModal() {
  galleryModal.classList.add('open');
}

function closeGalleryModal() {
  galleryModal.classList.remove('open');
}

function filterGallery(category) {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });

  document.querySelectorAll('.gallery-card').forEach(card => {
    if (category === 'all' || card.dataset.category === category) {
      card.style.display = 'flex';
    } else {
      card.style.display = 'none';
    }
  });
}

// Templates Loader from Server API (with automatic fallback)
async function loadTemplateOptions() {
  try {
    const res = await fetch('/api/templates');
    if (res.ok) {
      const list = await res.json();
      if (list && list.length > 0) {
        populateDropdown(list);
        buildGalleryModal(list);
      }
    }
  } catch (err) {
    console.log('Usando catálogo estático embutido.');
  }
}

// ALWAYS adds the diagram to the board WITHOUT removing existing items
function loadTemplateToCanvas(url) {
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.onload = () => {
    recordState(); // Save state for undo

    // Determine comfortable size for screen
    let maxW = Math.max(600, width * 0.85);
    let maxH = Math.max(450, height * 0.85);
    let w = img.width;
    let h = img.height;

    const scale = Math.min(maxW / w, maxH / h, 1.0);
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    let posX, posY;

    if (elements.length === 0) {
      // If canvas is empty, place right in the center
      const center = screenToCanvas(width / 2, height / 2);
      posX = Math.round(center.x - w / 2);
      posY = Math.round(center.y - h / 2);
    } else {
      // If canvas already has items, place to the right of existing elements
      const bounds = getElementsBounds();
      if (bounds) {
        posX = Math.round(bounds.maxX + 80); // 80px gap to the right
        posY = Math.round(bounds.minY);       // Align with top of existing elements
      } else {
        const center = screenToCanvas(width / 2, height / 2);
        posX = Math.round(center.x - w / 2);
        posY = Math.round(center.y - h / 2);
      }
    }

    const el = {
      type: 'image',
      src: url,
      x: posX,
      y: posY,
      width: w,
      height: h,
      imgObj: img
    };

    elements.push(el);
    selectedElement = el;

    // Center and fit all elements on screen so user sees both previous work and the new diagram!
    fitToScreen();
    scheduleAutoSave();
    broadcastBoardSync();
    showToast('➕ Novo diagrama adicionado ao quadro! O conteúdo anterior foi preservado.');
    showSyncBadge('Novo diagrama adicionado!', 'synced');
  };
  img.src = url;
}

window.loadTemplateByName = function(fname) {
  studySidebar.classList.add('closed');
  sidebarBackdrop.classList.remove('active');
  loadTemplateToCanvas(`templates/${fname}`);
};

function setActiveTool(tool) {
  currentTool = tool;
  selectedElement = null;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tool-btn[data-tool="${currentTool}"]`);
  if (btn) btn.classList.add('active');

  if (currentTool === 'eraser') {
    wrapper.classList.add('eraser-mode');
    updateEraserCursorSize();
  } else {
    hideEraserCursor();
  }
  render();
}

// ==================== Mouse & Touch Event Listeners ====================
function setupEventListeners() {
  // Canvas pointer events (Suporte total a Mesa Digitalizadora / Stylus, Touch e Mouse)
  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);

  // Previne menu de contexto ao usar botão da caneta ou toque longo
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Wrapper cursor tracking
  wrapper.addEventListener('mouseleave', () => {
    hideEraserCursor();
  });
  wrapper.addEventListener('mouseenter', (e) => {
    if (currentTool === 'eraser' && !spacePressed && !isPanning) {
      const rect = canvas.getBoundingClientRect();
      updateEraserCursorPos(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  // Zoom with Wheel
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  // Tool buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveTool(btn.dataset.tool);
    });
  });

  // Color selection
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      currentColor = dot.dataset.color;
    });
  });

  // Size selection
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSize = parseInt(btn.dataset.size, 10);
      updateEraserCursorSize();
    });
  });

  // Clear button
  btnClearCanvas.addEventListener('click', () => {
    if (confirm('Tem certeza que deseja limpar todo o quadro?')) {
      recordState();
      elements = [];
      selectedElement = null;
      render();
      scheduleAutoSave();
      broadcastBoardClear();
    }
  });

  // File upload input
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) addImageFromFile(file);
    fileInput.value = '';
  });

  // Undo & Redo buttons
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  if (btnUndo) btnUndo.addEventListener('click', undo);
  if (btnRedo) btnRedo.addEventListener('click', redo);

  // Save for AI button
  btnSaveAI.addEventListener('click', () => {
    saveToAI(true);
  });

  // Export PNG locally
  btnExportPNG.addEventListener('click', exportLocalPNG);

  // Instant Template Dropdown Selection (Loads immediately on change!)
  templateSelect.addEventListener('change', () => {
    const val = templateSelect.value;
    if (val) {
      loadTemplateToCanvas(val);
      templateSelect.value = ''; // reset select so it can be re-triggered anytime
    }
  });

  // Gallery Modal Buttons
  btnOpenGallery.addEventListener('click', openGalleryModal);
  btnCloseGallery.addEventListener('click', closeGalleryModal);

  galleryModal.addEventListener('click', (e) => {
    if (e.target === galleryModal) closeGalleryModal();
  });

  // Filter Buttons in Modal
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterGallery(btn.dataset.category);
    });
  });

  // Toggle Palette Collapse
  btnTogglePalette.addEventListener('click', () => {
    toolPalette.classList.toggle('collapsed');
    btnTogglePalette.textContent = toolPalette.classList.contains('collapsed') ? '▶' : '◀';
    setTimeout(resizeCanvas, 220);
  });

  // Zoom HUD
  btnZoomIn.addEventListener('click', () => applyZoom(1.2));
  btnZoomOut.addEventListener('click', () => applyZoom(1 / 1.2));
  btnZoomReset.addEventListener('click', () => {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    render();
  });
  btnZoomFit.addEventListener('click', fitToScreen);

  // Sidebar Controls
  btnToggleSidebar.addEventListener('click', () => {
    const isClosed = studySidebar.classList.contains('closed');
    if (isClosed) {
      studySidebar.classList.remove('closed');
      sidebarBackdrop.classList.add('active');
    } else {
      studySidebar.classList.add('closed');
      sidebarBackdrop.classList.remove('active');
    }
  });

  btnCloseSidebar.addEventListener('click', () => {
    studySidebar.classList.add('closed');
    sidebarBackdrop.classList.remove('active');
  });

  sidebarBackdrop.addEventListener('click', () => {
    studySidebar.classList.add('closed');
    sidebarBackdrop.classList.remove('active');
  });

  // Sidebar Tabs
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  // Clipboard Paste (Ctrl+V) anywhere on the window!
  window.addEventListener('paste', handleClipboardPaste);

  // Drag and Drop files onto canvas
  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        const pt = screenToCanvas(e.clientX - wrapper.getBoundingClientRect().left, e.clientY - wrapper.getBoundingClientRect().top);
        addImageFromFile(file, pt.x, pt.y);
      }
    }
  });

  // Refresh AI Feedback
  const btnRefreshFeedback = document.getElementById('btnRefreshFeedback');
  if (btnRefreshFeedback) {
    btnRefreshFeedback.addEventListener('click', fetchAIFeedback);
  }
}

// Pointer event handlers
function handlePointerDown(e) {
  // Captura o ponteiro e previne comportamentos de arrasto/gestos nativos do Windows Ink / touch
  if (e.pointerId !== undefined && canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {}
  }
  if (e.cancelable) {
    e.preventDefault();
  }

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Spacebar pan or middle click or pan tool
  if (spacePressed || e.button === 1 || currentTool === 'pan') {
    isPanning = true;
    startPanX = e.clientX - panX;
    startPanY = e.clientY - panY;
    wrapper.classList.add('panning');
    hideEraserCursor();
    return;
  }

  const pt = screenToCanvas(mouseX, mouseY);
  startX = pt.x;
  startY = pt.y;

  if (currentTool === 'select') {
    selectedElement = null;
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      const bbox = getElementBoundingBox(el);
      if (bbox && pt.x >= bbox.x && pt.x <= bbox.x + bbox.width && pt.y >= bbox.y && pt.y <= bbox.y + bbox.height) {
        selectedElement = el;
        isDraggingElement = true;
        dragStartState = serializeBoardState();
        dragOriginalPos = {
          x: el.x !== undefined ? el.x : el.x1,
          y: el.y !== undefined ? el.y : el.y1
        };
        dragOffsetX = pt.x - (el.x !== undefined ? el.x : el.x1);
        dragOffsetY = pt.y - (el.y !== undefined ? el.y : el.y1);
        break;
      }
    }
    render();
    return;
  }

  if (currentTool === 'text') {
    promptAddText(mouseX, mouseY, pt.x, pt.y);
    return;
  }

  if (currentTool === 'eraser') {
    eraseStartState = serializeBoardState();
    eraseModified = false;
    lastErasePoint = { x: pt.x, y: pt.y };
    isDrawing = true;
    const radius = getEraserRadius();
    if (eraseCircleStep(pt.x, pt.y, radius)) {
      eraseModified = true;
      render();
    }
    return;
  }

  // Draw tools: pen, highlighter, line, arrow, rect, mux, alu
  isDrawing = true;
  drawStartState = serializeBoardState();

  if (currentTool === 'pen' || currentTool === 'highlighter') {
    currentPath = {
      type: 'path',
      tool: currentTool,
      color: currentColor,
      size: currentSize,
      points: [{ x: pt.x, y: pt.y }]
    };
  } else {
    currentPath = {
      type: currentTool,
      color: currentColor,
      size: currentSize,
      x1: pt.x,
      y1: pt.y,
      x2: pt.x,
      y2: pt.y
    };
  }

  render();
}

function handlePointerMove(e) {
  if (isDrawing || isPanning || isDraggingElement) {
    if (e.cancelable) e.preventDefault();
  }

  if (isPanning) {
    panX = e.clientX - startPanX;
    panY = e.clientY - startPanY;
    hideEraserCursor();
    render();
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const isInside = mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height;

  if (currentTool === 'eraser' && !spacePressed) {
    if (isInside) {
      updateEraserCursorPos(mouseX, mouseY);
    } else {
      hideEraserCursor();
    }
  } else {
    hideEraserCursor();
  }

  const pt = screenToCanvas(mouseX, mouseY);

  if (isInside || isDrawing || isDraggingElement) {
    broadcastCursor(pt.x, pt.y);
  }

  if (isDraggingElement && selectedElement) {
    if (selectedElement.x !== undefined) {
      selectedElement.x = pt.x - dragOffsetX;
      selectedElement.y = pt.y - dragOffsetY;
    } else if (selectedElement.x1 !== undefined) {
      const dx = (pt.x - dragOffsetX) - selectedElement.x1;
      const dy = (pt.y - dragOffsetY) - selectedElement.y1;
      selectedElement.x1 += dx;
      selectedElement.y1 += dy;
      selectedElement.x2 += dx;
      selectedElement.y2 += dy;
    }
    render();
    return;
  }

  if (!isDrawing) return;

  if (currentTool === 'eraser') {
    if (lastErasePoint) {
      eraseAlongSegment(lastErasePoint.x, lastErasePoint.y, pt.x, pt.y);
      lastErasePoint = { x: pt.x, y: pt.y };
    } else {
      lastErasePoint = { x: pt.x, y: pt.y };
      const radius = getEraserRadius();
      if (eraseCircleStep(pt.x, pt.y, radius)) {
        eraseModified = true;
        render();
      }
    }
    return;
  }

  if (currentPath) {
    if (currentPath.type === 'path') {
      const subEvents = (e.getCoalescedEvents && typeof e.getCoalescedEvents === 'function')
        ? e.getCoalescedEvents()
        : [e];
      for (const ev of subEvents) {
        const subMouseX = ev.clientX - rect.left;
        const subMouseY = ev.clientY - rect.top;
        const subPt = screenToCanvas(subMouseX, subMouseY);
        currentPath.points.push({ x: subPt.x, y: subPt.y });
      }
      broadcastLiveStroke(currentPath);
    } else {
      currentPath.x2 = pt.x;
      currentPath.y2 = pt.y;
    }
    render();
  }
}

function handlePointerUp(e) {
  if (e && e.pointerId !== undefined && canvas.releasePointerCapture) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {}
  }
  if (isPanning) {
    isPanning = false;
    wrapper.classList.remove('panning');
    if (currentTool === 'eraser') {
      wrapper.classList.add('eraser-mode');
    }
  }

  if (isDraggingElement) {
    isDraggingElement = false;
    if (selectedElement && dragOriginalPos && dragStartState) {
      const curX = selectedElement.x !== undefined ? selectedElement.x : selectedElement.x1;
      const curY = selectedElement.y !== undefined ? selectedElement.y : selectedElement.y1;
      if (Math.abs(curX - dragOriginalPos.x) > 1 || Math.abs(curY - dragOriginalPos.y) > 1) {
        pushUndoState(dragStartState);
        scheduleAutoSave();
        broadcastBoardSync();
      }
    }
    dragStartState = null;
    dragOriginalPos = null;
  }

  if (currentTool === 'eraser') {
    if (isDrawing) {
      isDrawing = false;
      lastErasePoint = null;
      if (eraseModified && eraseStartState) {
        pushUndoState(eraseStartState);
        eraseStartState = null;
        scheduleAutoSave();
        broadcastBoardSync();
      }
    }
    return;
  }

  if (isDrawing) {
    isDrawing = false;
    if (currentPath) {
      let isValid = false;
      if (currentPath.type === 'path') {
        if (currentPath.points.length === 1) {
          // Click dot: duplicate point with tiny offset so canvas renders round dot
          currentPath.points.push({
            x: currentPath.points[0].x + 0.1,
            y: currentPath.points[0].y + 0.1
          });
        }
        isValid = currentPath.points.length >= 2;
      } else {
        const dist = Math.hypot(currentPath.x2 - currentPath.x1, currentPath.y2 - currentPath.y1);
        isValid = dist >= 3;
      }

      if (isValid) {
        if (drawStartState) {
          pushUndoState(drawStartState);
          drawStartState = null;
        }
        const createdEl = currentPath;
        elements.push(createdEl);
        currentPath = null;
        render();
        scheduleAutoSave();
        broadcastElementAdd(createdEl);
      } else {
        // Discard zero-length element without affecting undo/redo stacks
        currentPath = null;
        drawStartState = null;
        render();
      }
    }
  }
}

// Wheel Zoom
function handleWheel(e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.min(Math.max(0.15, zoom * zoomFactor), 5.0);

  // Zoom toward cursor position
  panX = mouseX - (mouseX - panX) * (newZoom / zoom);
  panY = mouseY - (mouseY - panY) * (newZoom / zoom);
  zoom = newZoom;

  render();
  updateEraserCursorSize();
}

function applyZoom(factor) {
  const centerX = width / 2;
  const centerY = height / 2;
  const newZoom = Math.min(Math.max(0.15, zoom * factor), 5.0);

  panX = centerX - (centerX - panX) * (newZoom / zoom);
  panY = centerY - (centerY - panY) * (newZoom / zoom);
  zoom = newZoom;

  render();
  updateEraserCursorSize();
}

function updateZoomIndicator() {
  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
}

// ==================== Precise Circle Eraser System ====================
let lastErasePoint = null;
let eraseStartState = null;
let eraseModified = false;
const eraserCursor = document.getElementById('eraserCursor');

function getEraserRadius() {
  switch (currentSize) {
    case 2: return 12;
    case 4: return 22;
    case 8: return 38;
    case 16: return 65;
    default: return Math.max(8, currentSize * 4);
  }
}

function updateEraserCursorPos(screenX, screenY) {
  if (!eraserCursor) return;
  if (currentTool !== 'eraser' || spacePressed || isPanning) {
    eraserCursor.style.display = 'none';
    wrapper.classList.remove('eraser-mode');
    return;
  }
  const radius = getEraserRadius();
  const screenRadius = radius * zoom;
  const d = Math.round(screenRadius * 2);

  eraserCursor.style.width = `${d}px`;
  eraserCursor.style.height = `${d}px`;
  eraserCursor.style.left = `${screenX}px`;
  eraserCursor.style.top = `${screenY}px`;
  eraserCursor.style.display = 'block';
  wrapper.classList.add('eraser-mode');
}

function updateEraserCursorSize() {
  if (!eraserCursor) return;
  if (currentTool !== 'eraser' || spacePressed || isPanning) {
    eraserCursor.style.display = 'none';
    wrapper.classList.remove('eraser-mode');
    return;
  }
  const radius = getEraserRadius();
  const screenRadius = radius * zoom;
  const d = Math.round(screenRadius * 2);
  eraserCursor.style.width = `${d}px`;
  eraserCursor.style.height = `${d}px`;
}

function hideEraserCursor() {
  if (!eraserCursor) return;
  eraserCursor.style.display = 'none';
  wrapper.classList.remove('eraser-mode');
}

// Clip polyline path against circle (erases only what is strictly inside the circle)
function clipPathByCircle(pathEl, cx, cy, radius) {
  if (!pathEl.points || pathEl.points.length === 0) return [];

  if (pathEl.points.length === 1) {
    const d = Math.hypot(pathEl.points[0].x - cx, pathEl.points[0].y - cy);
    return d < radius ? [] : [pathEl];
  }

  // Fast bounding box rejection check
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pathEl.points.length; i++) {
    const p = pathEl.points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = (pathEl.size || 2);
  if (cx + radius < minX - pad || cx - radius > maxX + pad ||
      cy + radius < minY - pad || cy - radius > maxY + pad) {
    return [pathEl];
  }

  const resultPaths = [];
  let currentSub = [];

  function pushSub(pts) {
    if (!pts || pts.length === 0) return;
    const clean = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const prev = clean[clean.length - 1];
      const curr = pts[k];
      if (Math.hypot(curr.x - prev.x, curr.y - prev.y) > 0.05) {
        clean.push(curr);
      }
    }
    if (clean.length >= 2) {
      resultPaths.push(clean);
    } else if (clean.length === 1) {
      resultPaths.push([clean[0], { x: clean[0].x + 0.1, y: clean[0].y + 0.1 }]);
    }
  }

  const p0 = pathEl.points[0];
  if (Math.hypot(p0.x - cx, p0.y - cy) >= radius) {
    currentSub.push(p0);
  }

  for (let i = 0; i < pathEl.points.length - 1; i++) {
    const A = pathEl.points[i];
    const B = pathEl.points[i + 1];

    const Dx = B.x - A.x;
    const Dy = B.y - A.y;
    const a = Dx * Dx + Dy * Dy;

    if (a < 1e-9) continue;

    const Fx = A.x - cx;
    const Fy = A.y - cy;
    const b = 2 * (Dx * Fx + Dy * Fy);
    const c = Fx * Fx + Fy * Fy - radius * radius;
    const delta = b * b - 4 * a * c;

    if (delta <= 0) {
      if (currentSub.length === 0) currentSub.push(A);
      currentSub.push(B);
      continue;
    }

    const sqrtDelta = Math.sqrt(delta);
    const t1 = (-b - sqrtDelta) / (2 * a);
    const t2 = (-b + sqrtDelta) / (2 * a);

    const tInStart = Math.max(0, t1);
    const tInEnd = Math.min(1, t2);

    if (tInStart >= tInEnd) {
      if (currentSub.length === 0) currentSub.push(A);
      currentSub.push(B);
      continue;
    }

    // Entering or cutting circle
    if (t1 > 1e-6) {
      if (currentSub.length === 0) currentSub.push(A);
      const I1 = { x: A.x + t1 * Dx, y: A.y + t1 * Dy };
      currentSub.push(I1);
      pushSub(currentSub);
      currentSub = [];
    } else {
      if (currentSub.length > 0) {
        pushSub(currentSub);
        currentSub = [];
      }
    }

    // Exiting circle
    if (t2 < 1 - 1e-6) {
      const I2 = { x: A.x + t2 * Dx, y: A.y + t2 * Dy };
      currentSub = [I2, B];
    } else {
      currentSub = [];
    }
  }

  if (currentSub.length > 0) {
    pushSub(currentSub);
  }

  return resultPaths.map(pts => ({ ...pathEl, points: pts }));
}

// Clip straight line or arrow against circle
function clipLineOrArrow(el, cx, cy, radius) {
  const A = { x: el.x1, y: el.y1 };
  const B = { x: el.x2, y: el.y2 };
  const Dx = B.x - A.x;
  const Dy = B.y - A.y;
  const a = Dx * Dx + Dy * Dy;

  if (a < 1e-9) {
    const d = Math.hypot(A.x - cx, A.y - cy);
    return d < radius ? [] : [el];
  }

  const Fx = A.x - cx;
  const Fy = A.y - cy;
  const b = 2 * (Dx * Fx + Dy * Fy);
  const c = Fx * Fx + Fy * Fy - radius * radius;
  const delta = b * b - 4 * a * c;

  if (delta <= 0) return [el];

  const sqrtDelta = Math.sqrt(delta);
  const t1 = (-b - sqrtDelta) / (2 * a);
  const t2 = (-b + sqrtDelta) / (2 * a);

  const tInStart = Math.max(0, t1);
  const tInEnd = Math.min(1, t2);

  if (tInStart >= tInEnd) return [el];

  const hasStart = t1 > 1e-6;
  const hasEnd = t2 < 1 - 1e-6;
  const I1 = { x: A.x + t1 * Dx, y: A.y + t1 * Dy };
  const I2 = { x: A.x + t2 * Dx, y: A.y + t2 * Dy };

  if (hasStart && hasEnd) {
    // Cut in middle: split into two pieces
    if (el.type === 'arrow') {
      return [
        { type: 'line', color: el.color, size: el.size, x1: el.x1, y1: el.y1, x2: I1.x, y2: I1.y },
        { ...el, x1: I2.x, y1: I2.y, x2: el.x2, y2: el.y2 }
      ];
    }
    return [
      { ...el, x1: el.x1, y1: el.y1, x2: I1.x, y2: I1.y },
      { ...el, x1: I2.x, y1: I2.y, x2: el.x2, y2: el.y2 }
    ];
  } else if (hasStart) {
    // End trimmed
    if (el.type === 'arrow') {
      return [{ type: 'line', color: el.color, size: el.size, x1: el.x1, y1: el.y1, x2: I1.x, y2: I1.y }];
    }
    return [{ ...el, x1: el.x1, y1: el.y1, x2: I1.x, y2: I1.y }];
  } else if (hasEnd) {
    // Start trimmed
    return [{ ...el, x1: I2.x, y1: I2.y, x2: el.x2, y2: el.y2 }];
  } else {
    // Entire line inside circle
    return [];
  }
}

// Single step of circle erasing
function eraseCircleStep(cx, cy, radius) {
  let changed = false;
  const newElements = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    // IMPORTANT: Ready images added to the board are NEVER erased by the eraser!
    if (el.type === 'image') {
      newElements.push(el);
      continue;
    }

    if (el.type === 'path') {
      const clipped = clipPathByCircle(el, cx, cy, radius);
      if (clipped.length !== 1 || clipped[0] !== el) {
        changed = true;
      }
      for (let k = 0; k < clipped.length; k++) {
        newElements.push(clipped[k]);
      }
    } else if (el.type === 'line' || el.type === 'arrow') {
      const clipped = clipLineOrArrow(el, cx, cy, radius);
      if (clipped.length !== 1 || clipped[0] !== el) {
        changed = true;
      }
      for (let k = 0; k < clipped.length; k++) {
        newElements.push(clipped[k]);
      }
    } else if (el.type === 'rect' || el.type === 'mux' || el.type === 'alu' || el.type === 'text') {
      const bbox = getElementBoundingBox(el);
      if (bbox && cx >= bbox.x && cx <= bbox.x + bbox.width && cy >= bbox.y && cy <= bbox.y + bbox.height) {
        changed = true;
        // removed
      } else {
        newElements.push(el);
      }
    } else {
      newElements.push(el);
    }
  }

  if (changed) {
    elements = newElements;
    if (selectedElement && !elements.includes(selectedElement)) {
      selectedElement = null;
    }
  }
  return changed;
}

// Erase along drag segment with interpolation so fast mouse movement leaves no gaps
function eraseAlongSegment(x1, y1, x2, y2) {
  const radius = getEraserRadius();
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const step = Math.max(4, radius * 0.4);
  const steps = Math.max(1, Math.ceil(dist / step));
  let anyChange = false;

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = x1 + (x2 - x1) * t;
    const cy = y1 + (y2 - y1) * t;
    if (eraseCircleStep(cx, cy, radius)) {
      anyChange = true;
    }
  }

  if (anyChange) {
    eraseModified = true;
    render();
  }
}

// Text Input on Canvas
function promptAddText(screenX, screenY, canvasX, canvasY) {
  const existingInput = document.getElementById('canvasTextInput');
  if (existingInput) existingInput.remove();

  const rect = wrapper.getBoundingClientRect();
  const input = document.createElement('textarea');
  input.id = 'canvasTextInput';
  input.style.position = 'absolute';
  input.style.left = `${screenX + rect.left}px`;
  input.style.top = `${screenY + rect.top}px`;
  input.style.fontSize = `${currentSize * 4 + 14}px`;
  input.style.color = currentColor;
  input.style.background = 'rgba(255, 255, 255, 0.96)';
  input.style.border = '2px solid #3b82f6';
  input.style.borderRadius = '4px';
  input.style.padding = '4px 8px';
  input.style.fontFamily = "'Fira Code', monospace";
  input.style.zIndex = '35';
  input.style.minWidth = '180px';
  input.style.minHeight = '36px';
  input.placeholder = 'Digite seu cálculo ou sinal...';

  document.body.appendChild(input);
  input.focus();

  let committed = false;

  function commitText() {
    if (committed) return;
    committed = true;
    const text = input.value.trim();
    if (text) {
      recordState();
      const textEl = {
        type: 'text',
        text: text,
        x: canvasX,
        y: canvasY,
        color: currentColor,
        size: currentSize
      };
      elements.push(textEl);
      render();
      scheduleAutoSave();
      broadcastElementAdd(textEl);
    }
    if (input.parentNode) {
      input.remove();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    } else if (e.key === 'Escape') {
      committed = true;
      if (input.parentNode) input.remove();
    }
  });

  input.addEventListener('blur', commitText);
}

// Paste Image from Clipboard (Ctrl+V)
function handleClipboardPaste(e) {
  if (e.clipboardData && e.clipboardData.items) {
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i];
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        const center = screenToCanvas(width / 2, height / 2);
        addImageFromFile(file, center.x, center.y);
        showSyncBadge('Imagem colada com sucesso!', 'synced');
        break;
      }
    }
  }
}

function addImageFromFile(file, posX, posY) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      let maxDim = Math.min(850, width * 0.8);
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w *= scale;
        h *= scale;
      }

      const x = posX !== undefined ? posX - w / 2 : (width / 2 - panX) / zoom - w / 2;
      const y = posY !== undefined ? posY - h / 2 : (height / 2 - panY) / zoom - h / 2;

      recordState();
      const el = {
        type: 'image',
        src: event.target.result,
        x: x,
        y: y,
        width: w,
        height: h,
        imgObj: img
      };
      elements.push(el);
      selectedElement = el;
      render();
      scheduleAutoSave();
      broadcastElementAdd({
        type: 'image',
        src: event.target.result,
        x: x,
        y: y,
        width: w,
        height: h
      });
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

// Local Auto-Save (Saves vector state locally in browser; does NOT generate image prints to disk!)
function scheduleAutoSave() {
  showSyncBadge('● Salvo no navegador', 'synced');
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      const serializableElements = elements.map(el => {
        const copy = { ...el };
        delete copy.imgObj;
        return copy;
      });
      const stateObj = { elements: serializableElements, zoom, panX, panY };
      localStorage.setItem('whiteboard_state', JSON.stringify(stateObj));

      // Quietly sync JSON elements state to server without any image/print generation
      fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: stateObj })
      }).catch(() => {});
    } catch (e) {}
  }, 600);
}

async function saveToAI(manual = false) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  showSyncBadge('Sincronizando com a IA...', 'saving');

  try {
    const exportCanvas = document.createElement('canvas');
    const expCtx = exportCanvas.getContext('2d');

    const bounds = getElementsBounds() || { minX: 0, minY: 0, maxX: width, maxY: height, width, height };
    const padding = 50;
    const expW = Math.max(1200, bounds.width + padding * 2);
    const expH = Math.max(800, bounds.height + padding * 2);

    exportCanvas.width = expW;
    exportCanvas.height = expH;

    // Fill clean white background
    expCtx.fillStyle = '#ffffff';
    expCtx.fillRect(0, 0, expW, expH);

    // Subtle grid pattern
    expCtx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
    expCtx.lineWidth = 1;
    for (let x = 0; x < expW; x += 30) {
      expCtx.beginPath();
      expCtx.moveTo(x, 0);
      expCtx.lineTo(x, expH);
      expCtx.stroke();
    }
    for (let y = 0; y < expH; y += 30) {
      expCtx.beginPath();
      expCtx.moveTo(0, y);
      expCtx.lineTo(expW, y);
      expCtx.stroke();
    }

    // Translate to align content
    expCtx.translate(-bounds.minX + padding, -bounds.minY + padding);

    // Draw all elements
    elements.forEach(el => drawElement(expCtx, el));

    const dataUrl = exportCanvas.toDataURL('image/png');

    // Clean elements for JSON serialization
    const serializableElements = elements.map(el => {
      const copy = { ...el };
      delete copy.imgObj;
      return copy;
    });

    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: dataUrl,
        state: { elements: serializableElements, zoom, panX, panY }
      })
    });

    if (res.ok) {
      showSyncBadge('● Sincronizado com IA', 'synced');
      if (manual) {
        showToast('✅ Quadro salvo e visível para a IA! Pode me chamar no chat.');
      }
    } else {
      showSyncBadge('Erro ao salvar', 'idle');
    }
  } catch (err) {
    showSyncBadge('Servidor offline', 'idle');
  }
}

function showSyncBadge(text, className) {
  syncText.textContent = text;
  syncBadge.className = `sync-badge ${className}`;
}

function showToast(msg) {
  const existing = document.getElementById('toastNotification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toastNotification';
  toast.style.position = 'fixed';
  toast.style.bottom = '24px';
  toast.style.left = '50%';
  toast.style.transform = 'translateX(-50%)';
  toast.style.backgroundColor = '#1e293b';
  toast.style.color = '#f8fafc';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '8px';
  toast.style.border = '1px solid #3b82f6';
  toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.4)';
  toast.style.fontSize = '12px';
  toast.style.fontWeight = '500';
  toast.style.zIndex = '200';
  toast.textContent = msg;

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

async function loadSavedBoard() {
  // 1. First restore from localStorage (instant and offline)
  try {
    const local = localStorage.getItem('whiteboard_state');
    if (local) {
      const data = JSON.parse(local);
      if (data && data.elements && data.elements.length > 0) {
        elements = data.elements;
        if (data.zoom) zoom = data.zoom;
        if (data.panX !== undefined) panX = data.panX;
        if (data.panY !== undefined) panY = data.panY;
        rehydrateImages();
        setTimeout(() => {
          render();
          showSyncBadge('● Salvo no navegador', 'synced');
        }, 100);
        return;
      }
    }
  } catch (e) {}

  // 2. Fallback to /current_board.json from server
  try {
    const res = await fetch('/current_board.json');
    if (res.ok) {
      const data = await res.json();
      if (data && data.elements) {
        elements = data.elements;
        rehydrateImages();
        setTimeout(() => {
          fitToScreen();
          showSyncBadge('● Sincronizado', 'synced');
        }, 150);
      }
    }
  } catch (e) {
    // board file doesn't exist yet
  }
}

function exportLocalPNG() {
  const link = document.createElement('a');
  link.download = `whiteboard_mips_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function fetchAIFeedback() {
  try {
    const res = await fetch('/api/ai-feedback');
    const data = await res.json();
    const box = document.getElementById('aiFeedbackContainer');
    if (data.notes && data.notes.length > 0) {
      box.innerHTML = data.notes.map(n => `
        <div style="margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #334155;">
          <b style="color:#60a5fa;">[${n.author || 'Assistente IA'}]:</b>
          <p style="color:#f1f5f9; margin-top:2px;">${n.text}</p>
        </div>
      `).join('');
    } else {
      box.innerHTML = '<i>Nenhuma anotação nova da IA no momento.</i>';
    }
  } catch (e) {
    console.warn('Feedback indisponível:', e);
  }
}

// Hotkeys & Shortcuts
function setupHotkeys() {
  window.addEventListener('keydown', (e) => {
    // Ignore hotkeys when typing in textarea or inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      closeGalleryModal();
      studySidebar.classList.add('closed');
      sidebarBackdrop.classList.remove('active');
    }

    if (e.code === 'Space') {
      spacePressed = true;
      wrapper.classList.add('pan-mode');
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        saveToAI(true);
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedElement) {
        recordState();
        elements = elements.filter(el => el !== selectedElement);
        selectedElement = null;
        render();
        scheduleAutoSave();
        broadcastBoardSync();
        return;
      }
    }

    const key = e.key.toLowerCase();
    if (key === 'f') {
      fitToScreen();
      return;
    }
    if (key === 'g') {
      openGalleryModal();
      return;
    }

    const toolMap = {
      'p': 'pen',
      'h': 'highlighter',
      'a': 'arrow',
      'l': 'line',
      'r': 'rect',
      'm': 'mux',
      'u': 'alu',
      't': 'text',
      'e': 'eraser',
      's': 'select'
    };

    if (toolMap[key]) {
      setActiveTool(toolMap[key]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spacePressed = false;
      wrapper.classList.remove('pan-mode');
      wrapper.classList.remove('panning');
      if (currentTool === 'eraser') {
        wrapper.classList.add('eraser-mode');
        updateEraserCursorSize();
      }
    }
  });
}

// ==================== WebSocket Collaboration System ====================

function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.warn('Erro ao inicializar WebSocket:', err);
    updateCollabUI(1, false);
    scheduleWsReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    updateCollabUI(1, true);
    // Send user profile on connect
    sendWsMessage({
      type: 'join',
      name: myUserName,
      color: myUserColor
    });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (err) {
      console.error('Erro ao processar mensagem colaborativa:', err);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateCollabUI(1, false);
    peerCursors.clear();
    peerLiveStrokes.clear();
    render();
    scheduleWsReconnect();
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    initWebSocket();
  }, 3000);
}

function sendWsMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      console.warn('Falha ao enviar mensagem WS:', e);
    }
  }
}

function handleWsMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'init': {
      wsClientId = msg.clientId;
      undoStack = [];
      redoStack = [];
      pendingUndoState = null;
      updateUndoRedoUI();
      const count = msg.userCount || 1;
      updateCollabUI(count, true);

      // If server already has elements, adopt them!
      if (msg.elements && msg.elements.length > 0) {
        elements = msg.elements;
        rehydrateImages();
        render();
      } else if (!hasSentInitialSync && elements.length > 0) {
        // If server is blank but we have existing elements from localStorage, share with server!
        hasSentInitialSync = true;
        broadcastBoardSync();
      }
      break;
    }

    case 'presence': {
      const count = msg.userCount || 1;
      updateCollabUI(count, true);
      if (msg.user && msg.user.name && msg.user.clientId !== wsClientId) {
        showToast(`👋 ${msg.user.name} entrou no quadro!`);
      }
      if (msg.left) {
        peerCursors.delete(msg.left);
        peerLiveStrokes.delete(msg.left);
        render();
      }
      break;
    }

    case 'cursor': {
      if (msg.clientId === wsClientId) return;
      peerCursors.set(msg.clientId, {
        x: msg.x,
        y: msg.y,
        name: msg.name || 'Amigo',
        color: msg.color || '#2563eb',
        tool: msg.tool || 'pen',
        lastSeen: Date.now()
      });
      render();
      break;
    }

    case 'cursor_remove': {
      peerCursors.delete(msg.clientId);
      peerLiveStrokes.delete(msg.clientId);
      render();
      break;
    }

    case 'stroke_live': {
      if (msg.clientId === wsClientId) return;
      peerLiveStrokes.set(msg.clientId, {
        type: 'path',
        tool: msg.tool || 'pen',
        color: msg.color || '#2563eb',
        size: msg.size || 2,
        points: msg.points || []
      });
      render();
      break;
    }

    case 'board_patch': {
      peerLiveStrokes.delete(msg.clientId);
      receiveBoardChanges(msg.changes || []);
      break;
    }

    case 'element_add': {
      if (msg.clientId === wsClientId) return;
      peerLiveStrokes.delete(msg.clientId);
      if (msg.element) {
        receiveBoardChanges([{ id: msg.element.id, after: msg.element }]);
        if (msg.element.type === 'image') {
          rehydrateImages();
        }
        render();
      }
      break;
    }

    case 'board_sync': {
      if (msg.clientId === wsClientId) return;
      peerLiveStrokes.delete(msg.clientId);
      if (Array.isArray(msg.elements)) {
        receiveBoardChanges(boardChanges(JSON.parse(serializeBoardState()), msg.elements));
        selectedElement = null;
        rehydrateImages();
        render();
      }
      break;
    }

    case 'board_clear': {
      if (msg.clientId === wsClientId) return;
      peerLiveStrokes.clear();
      receiveBoardChanges(boardChanges(JSON.parse(serializeBoardState()), []));
      selectedElement = null;
      render();
      showToast('🧹 O quadro foi limpo por outro participante.');
      break;
    }
  }
}

// Broadcast throttle helpers
function broadcastCursor(x, y) {
  const now = Date.now();
  if (now - lastCursorBroadcastTime > 35) {
    lastCursorBroadcastTime = now;
    sendWsMessage({
      type: 'cursor',
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      name: myUserName,
      color: myUserColor,
      tool: currentTool
    });
  }
}

function broadcastLiveStroke(pathEl) {
  const now = Date.now();
  if (now - lastStrokeBroadcastTime > 45) {
    lastStrokeBroadcastTime = now;
    sendWsMessage({
      type: 'stroke_live',
      tool: pathEl.tool || 'pen',
      color: pathEl.color,
      size: pathEl.size,
      points: pathEl.points
    });
  }
}

function broadcastElementAdd(el) {
  if (commitLocalAction()) return;
  if (!el) return;
  const clean = { ...el };
  delete clean.imgObj;
  sendWsMessage({
    type: 'element_add',
    element: clean
  });
}

function broadcastBoardSync() {
  if (commitLocalAction()) return;
  ensureElementIds();
  const cleanElements = elements.map(el => {
    const copy = { ...el };
    delete copy.imgObj;
    return copy;
  });
  sendWsMessage({
    type: 'board_sync',
    elements: cleanElements
  });
}

function broadcastBoardClear() {
  if (commitLocalAction()) return;
  sendWsMessage({
    type: 'board_clear'
  });
}

// Draw peer cursor on canvas
function drawPeerCursor(context, peer) {
  context.save();
  context.translate(peer.x, peer.y);

  // Scale inversely by zoom so cursor and label size stay constant in screen pixels
  const invZoom = 1 / zoom;
  context.scale(invZoom, invZoom);

  const color = peer.color || '#2563eb';

  // 1. Draw pointer arrow
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, 16);
  context.lineTo(4, 12);
  context.lineTo(8, 20);
  context.lineTo(11, 18.5);
  context.lineTo(7, 10.5);
  context.lineTo(12, 10.5);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = '#ffffff';
  context.lineWidth = 1.5;
  context.stroke();

  // 2. Draw name badge
  const name = peer.name || 'Amigo';
  context.font = '600 11px Inter, sans-serif';
  const textWidth = context.measureText(name).width;
  const tagX = 14;
  const tagY = 12;
  const tagW = Math.max(28, textWidth + 12);
  const tagH = 20;

  context.fillStyle = color;
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(tagX, tagY, tagW, tagH, 5);
  } else {
    context.rect(tagX, tagY, tagW, tagH);
  }
  context.fill();
  context.strokeStyle = '#ffffff';
  context.lineWidth = 1;
  context.stroke();

  // 3. Draw text label
  context.fillStyle = '#ffffff';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(name, tagX + 6, tagY + tagH / 2);

  context.restore();
}

function updateCollabUI(count, isConnected) {
  if (collabBadge) {
    collabBadge.textContent = count;
    if (isConnected) {
      collabBadge.className = 'collab-badge connected';
      collabBadge.title = `${count} pessoa${count > 1 ? 's' : ''} na sessão colaborativa`;
    } else {
      collabBadge.className = 'collab-badge offline';
      collabBadge.title = 'Desconectado do servidor colaborativo';
    }
  }

  if (collabStatusText && collabStatusIndicator) {
    if (isConnected) {
      collabStatusIndicator.textContent = '🟢';
      collabStatusText.textContent = `Conectado em tempo real · ${count} participante${count > 1 ? 's' : ''} no quadro`;
    } else {
      collabStatusIndicator.textContent = '🔴';
      collabStatusText.textContent = 'Servidor desconectado (tentando reconectar...)';
    }
  }
}

// Setup Collaboration Modal Events & Info
function setupCollabUI() {
  if (!btnCollaborate || !collabModal) return;

  btnCollaborate.addEventListener('click', openCollabModal);
  if (btnCloseCollab) btnCloseCollab.addEventListener('click', closeCollabModal);

  collabModal.addEventListener('click', (e) => {
    if (e.target === collabModal) closeCollabModal();
  });

  // Profile: username input
  if (collabUsernameInput) {
    collabUsernameInput.value = myUserName;
    collabUsernameInput.addEventListener('input', () => {
      const val = collabUsernameInput.value.trim();
      if (val) {
        myUserName = val;
        localStorage.setItem('whiteboard_username', myUserName);
        sendWsMessage({
          type: 'join',
          name: myUserName,
          color: myUserColor
        });
      }
    });
  }

  // Profile: color picker
  if (collabColorPicker) {
    const dots = collabColorPicker.querySelectorAll('.collab-color-dot');
    dots.forEach(d => {
      if (d.dataset.cursorColor === myUserColor) {
        d.classList.add('active');
      } else {
        d.classList.remove('active');
      }

      d.addEventListener('click', () => {
        dots.forEach(dot => dot.classList.remove('active'));
        d.classList.add('active');
        myUserColor = d.dataset.cursorColor;
        localStorage.setItem('whiteboard_usercolor', myUserColor);
        sendWsMessage({
          type: 'join',
          name: myUserName,
          color: myUserColor
        });
      });
    });
  }

  // Copy Buttons
  if (btnCopyLocalUrl && collabLocalUrl) {
    btnCopyLocalUrl.addEventListener('click', () => {
      navigator.clipboard.writeText(collabLocalUrl.value).then(() => {
        const origText = btnCopyLocalUrl.innerHTML;
        btnCopyLocalUrl.innerHTML = '✅ Copiado!';
        setTimeout(() => { btnCopyLocalUrl.innerHTML = origText; }, 2500);
      }).catch(() => {
        collabLocalUrl.select();
        document.execCommand('copy');
        btnCopyLocalUrl.innerHTML = '✅ Copiado!';
      });
    });
  }

  if (btnCopyTunnelCmd) {
    btnCopyTunnelCmd.addEventListener('click', () => {
      navigator.clipboard.writeText('npx localtunnel --port 8080').then(() => {
        btnCopyTunnelCmd.textContent = 'Copiado!';
        setTimeout(() => { btnCopyTunnelCmd.textContent = 'Copiar'; }, 2500);
      });
    });
  }

  if (btnCopyCloudflareCmd) {
    btnCopyCloudflareCmd.addEventListener('click', () => {
      navigator.clipboard.writeText('.\\cloudflared.exe tunnel --edge-ip-version 4 --protocol http2 --url http://localhost:8080').then(() => {
        btnCopyCloudflareCmd.textContent = 'Copiado!';
        setTimeout(() => { btnCopyCloudflareCmd.textContent = 'Copiar'; }, 2500);
      });
    });
  }
}

async function openCollabModal() {
  if (!collabModal) return;
  collabModal.classList.add('open');

  // Fetch local LAN network info from server
  try {
    const res = await fetch('/api/network-info');
    if (res.ok) {
      const info = await res.json();
      if (collabLocalUrl && info.local_url) {
        collabLocalUrl.value = info.local_url;
      }
      if (info.clients_count !== undefined) {
        updateCollabUI(info.clients_count, wsConnected);
      }
    }
  } catch (err) {
    // Fallback to location.host
    if (collabLocalUrl) {
      collabLocalUrl.value = `http://${location.hostname}:${location.port || 8080}`;
    }
  }
}

function closeCollabModal() {
  if (collabModal) collabModal.classList.remove('open');
}

