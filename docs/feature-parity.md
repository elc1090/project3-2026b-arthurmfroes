# Checklist de paridade do quadro branco copiado

Este documento registra o comportamento de referência presente em `whiteboard/`, antes das mudanças da T3. Os itens foram conferidos na marcação da interface, nos handlers do Canvas e nas rotas que os handlers chamam. A conferência foi estática: não iniciei o servidor nem fiz uma sessão interativa no navegador.

## Ferramentas e edição

- [x] A paleta oferece caneta, marca-texto, seta, linha, retângulo/bloco, MUX, ULA/ALU, texto, seleção/movimento, borracha e pan; os botões ativam `data-tool` e a tecla indicada aparece no título. Fonte: [`index.html`](../whiteboard/index.html#L77), [`setActiveTool` e `setupEventListeners`](../whiteboard/app.js#L1070).
- [x] Cores predefinidas e quatro espessuras (2, 4, 8 e 16) alteram os próximos elementos; o Canvas renderiza marca-texto com opacidade 0,35 e largura 2,8 vezes maior. Fonte: [`index.html`](../whiteboard/index.html#L126), [`setupEventListeners`](../whiteboard/app.js#L1120), [`drawElement`](../whiteboard/app.js#L670).
- [x] Caneta/marca-texto criam traços livres; linha, seta, retângulo, MUX e ALU criam formas por arrasto; texto abre uma área de edição no ponto do clique e confirma com Enter ou ao perder foco. Fonte: [`handlePointerDown`/`handlePointerMove`/`handlePointerUp`](../whiteboard/app.js#L1275), [`promptAddText`](../whiteboard/app.js#L1883).
- [x] A entrada usa Pointer Events e captura o ponteiro, cobrindo mouse, touch e stylus no mesmo fluxo de desenho. Isso é suporte indicado pelo código, não um teste com cada dispositivo. Fonte: [`setupEventListeners`](../whiteboard/app.js#L1087), [`handlePointerDown`](../whiteboard/app.js#L1275).
- [x] Seleção procura o elemento de cima para baixo e permite arrastar imagens, blocos, MUX, ALU e texto; Delete/Backspace remove o elemento selecionado. Fonte: [`handlePointerDown` e `handlePointerUp`](../whiteboard/app.js#L1304), [`getElementBoundingBox`](../whiteboard/app.js#L830), [`setupHotkeys`](../whiteboard/app.js#L2234).
- [x] A borracha apaga segmentos de traços e linhas/setas; remove forma/texto quando o círculo passa dentro da caixa delimitadora, mas preserva imagens. Fonte: [`clipPathByCircle`](../whiteboard/app.js#L1632), [`eraseCircleStep`](../whiteboard/app.js#L1808).
- [x] “Limpar” pede confirmação, zera o quadro e envia `board_clear` para os participantes conectados. Fonte: [`index.html`](../whiteboard/index.html#L154), [`setupEventListeners`/`broadcastBoardClear`](../whiteboard/app.js#L1139).
- [x] Pan funciona pela ferramenta, barra de espaço ou botão do meio; zoom funciona pela roda e pelos botões, com reset 1:1 e enquadramento automático. Fonte: [`index.html`](../whiteboard/index.html#L168), [`handlePointerDown`](../whiteboard/app.js#L1290), [`handleWheel`/`fitToScreen`](../whiteboard/app.js#L877).

## Imagens e galeria de estudo

- [x] Imagem pode entrar por seletor de arquivo, colagem de imagem da área de transferência e arrastar/soltar arquivo no quadro. A colagem posiciona no centro da viewport; o arquivo é centralizado no ponto de drop ou no centro da viewport. Fonte: [`index.html`](../whiteboard/index.html#L147), [`setupEventListeners`](../whiteboard/app.js#L1151), [`handleClipboardPaste`/`addImageFromFile`](../whiteboard/app.js#L1948).
- [x] Imagens são lidas como Data URL, limitadas a no máximo 850 px ou 80% da largura do Canvas e adicionadas como elementos selecionáveis/movíveis. Fonte: [`addImageFromFile`](../whiteboard/app.js#L1963), [`getElementBoundingBox`](../whiteboard/app.js#L830).
- [x] A galeria tem filtros para todos, prova UFSM, incompletos, completos, passos multiciclo e exercícios; o seletor rápido agrupa os mesmos tipos de catálogo. O catálogo vem de `/api/templates` e inclui apenas arquivos existentes em `whiteboard/templates/`. Fonte: [`index.html`](../whiteboard/index.html#L24), [`index.html`](../whiteboard/index.html#L341), [`loadTemplateOptions`/`filterGallery`](../whiteboard/app.js#L974), [`api_templates`](../whiteboard/server.py#L458).
- [x] Escolher um template adiciona a imagem ao quadro: em Canvas vazio, centraliza; com conteúdo, coloca 80 px à direita e alinha pelo topo. Depois ajusta a viewport para enquadrar os elementos. Fonte: [`loadTemplateToCanvas`](../whiteboard/app.js#L1004).

## Sidebar de estudo

- [x] O painel lateral abre/fecha pelo botão, botão de fechar, backdrop e tecla Escape. Tem abas “Sinais & FSM”, “Fórmulas”, “Questões” e “IA Feedback”. Fonte: [`index.html`](../whiteboard/index.html#L182), [`setupEventListeners`/`setupHotkeys`](../whiteboard/app.js#L1214).
- [x] As abas de sinais e fórmulas contêm referências de controle MIPS, etapas multiciclo e fórmulas de desempenho; a aba Questões carrega templates do catálogo no Canvas sem substituir conteúdo existente. Fonte: [`index.html`](../whiteboard/index.html#L197), [`index.html`](../whiteboard/index.html#L236), [`index.html`](../whiteboard/index.html#L266), [`loadTemplateByName`](../whiteboard/app.js#L1064).
- [x] A aba IA Feedback apresenta notas retornadas por `/api/ai-feedback`; o botão “Atualizar Feedback” busca os dados sob demanda. Fonte: [`index.html`](../whiteboard/index.html#L327), [`fetchAIFeedback`](../whiteboard/app.js#L2182), [`api_get_ai_feedback`](../whiteboard/server.py#L492).

## Exportação e salvamento para IA

- [x] “Baixar PNG” exporta localmente o bitmap atual do Canvas com nome `whiteboard_mips_<timestamp>.png`. Fonte: [`index.html`](../whiteboard/index.html#L59), [`exportLocalPNG`](../whiteboard/app.js#L2175).
- [x] “Salvar para IA” (também Ctrl/Cmd+S) desenha todos os elementos em um Canvas de alta resolução com fundo branco e grade, converte para PNG e envia a imagem junto do estado vetorial a `/api/save`. O botão exibe confirmação de salvamento em caso de resposta bem-sucedida. Fonte: [`index.html`](../whiteboard/index.html#L56), [`saveToAI`](../whiteboard/app.js#L2032), [`setupHotkeys`](../whiteboard/app.js#L2219).
- [x] O servidor grava o PNG como `whiteboard/current_board.png` e o estado como `current_board.json`; o salvamento automático envia apenas estado vetorial, sem gerar uma imagem para análise. Fonte: [`scheduleAutoSave`](../whiteboard/app.js#L2008), [`api_save_board`](../whiteboard/server.py#L514).

## Presença e colaboração

- [x] A janela “Colaborar” mostra URL local, instruções/comandos de túnel, apelido, cor do cursor e estado/contagem de participantes da sessão; o apelido e a cor ficam em `localStorage`. Fonte: [`index.html`](../whiteboard/index.html#L373), [`setupCollabUI`/`openCollabModal`](../whiteboard/app.js#L2617).
- [x] O cliente abre `/ws`, envia apelido/cor no evento `join` e recebe estado inicial e contagem de participantes; desconexões tentam reconectar após 3 segundos. Fonte: [`initWebSocket`/`handleWsMessage`](../whiteboard/app.js#L2289), [`websocket_endpoint`](../whiteboard/server.py#L565).
- [x] Cursores identificados por nome/cor e prévias de traço aparecem no Canvas; o cliente limita o envio de cursor a intervalos acima de 35 ms e prévia a intervalos acima de 45 ms. Elementos concluídos são enviados separadamente como alterações do quadro. Fonte: [`render`](../whiteboard/app.js#L631), [`broadcastCursor`/`broadcastLiveStroke`](../whiteboard/app.js#L2475), [`websocket_endpoint`](../whiteboard/server.py#L614).
- [x] Presença, cursores e prévias passam por um WebSocket central FastAPI e por uma única lista global de elementos em memória; não há no baseline código de Yjs, múltiplos quadros, WebRTC, controle de acesso ou presença persistente. Fonte: [`connected_clients`/`current_board_elements`](../whiteboard/server.py#L336), [`websocket_endpoint`](../whiteboard/server.py#L565), [`initWebSocket`](../whiteboard/app.js#L2289).

## Undo e redo

- [x] Botões Desfazer/Refazer e atalhos Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z e Ctrl/Cmd+Y percorrem histórico de mudanças locais; novos edits limpam a pilha de redo e o histórico é limitado por `MAX_UNDO_STACK`. Fonte: [`index.html`](../whiteboard/index.html#L50), [`commitLocalAction`/`undo`/`redo`](../whiteboard/app.js#L541), [`setupHotkeys`](../whiteboard/app.js#L2219).
- [x] O undo só aplica a mudança se o elemento ainda corresponde ao valor anterior registrado; assim, uma edição remota posterior no mesmo elemento faz aquela reversão ser ignorada, e mudanças independentes ficam fora da entrada local. Fonte: [`boardChanges`/`travelHistory`](../whiteboard/app.js#L505).
- [x] Limpar, apagar com borracha, adicionar elementos/templates e mover elemento geram estado para undo; uma nova conexão WebSocket reinicializa as pilhas. Fonte: [`recordState`/`handlePointerUp`](../whiteboard/app.js#L536), [`loadTemplateToCanvas`](../whiteboard/app.js#L1005), [`handleWsMessage`](../whiteboard/app.js#L2361).

## Limites observados do baseline

- O estado compartilhado e persistido é um único quadro (`current_board_elements`/`current_board.json`); o fluxo não representa boards independentes nem associa elementos a um membro ou a permissões.
- A confirmação “Sincronizado com IA” indica que `/api/save` respondeu com sucesso. O endpoint salva imagem e JSON; a implementação observada não chama um modelo de IA.
- A presença de cursores/traços é transitória, e o estado de conectividade se refere ao WebSocket com o servidor. O código não demonstra caminho P2P nem separa recebimento por peer de persistência durável.
- Estes limites descrevem o produto copiado e servem como referência para a T3; não são testes de execução da nova aplicação.
