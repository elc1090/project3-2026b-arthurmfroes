# Design

## Context

`room-persistence.js` do cliente guarda candidaturas e prioridades em Awareness, mas emite `persistence-election` apenas quando muda o ID vencedor. Os envios HTTP têm `batchId`, sem identidade própria para cada tentativa. O recibo identifica lote, persistência e cobertura; o evento de ACK local tem relógio da réplica, mas não conserva toda a entrega do recibo.

No servidor, `persistence_batches` conserva identidade, digest e horário de commit para deduplicação. O autor está na linha operacional de `board_updates`, que pode ser removida por checkpoint. O diagnóstico usa `inspection_events`, limitado a 256 eventos de até 8 KiB; a renderização atual exibe nomes de eventos e relógios em uma lista genérica. Esse limite e a mistura com eventos de desenho não são suficientes para consultar uma sequência de eleições e tentativas.

A base de comportamento é a change `elected-room-persistence`, implementada e ainda não arquivada. Este trabalho acrescenta observabilidade na capability existente `sync-observability`; não depende de arquivar ou sincronizar a change anterior.

## Goals / Non-Goals

**Goals:** responder quem sorteou qual número, quem escolheu qual representante e por quê, quem enviou cada tentativa e quando a VPS e os clientes observaram cada etapa. Manter esse relato após recarregar a página, respeitando retenção explícita e sem tornar diagnóstico pré-condição da persistência.

**Non-Goals:** alterar eleição, tempos, acesso ao quadro, Yjs ou recibos; provar que os peers fizeram sorteios honestos; estabelecer uma rodada ou relógio global; garantir captura de eventos que nunca foram produzidos ou se perderam antes da gravação local; criar painel de métricas genérico, exportação nova ou material de slides.

## Decisions

### Identificar a observação e cada tentativa

Criar um contrato versionado de eventos de persistência. Cada evento tem `eventId`, `boardId`, `traceSessionId`, `docClientId`, sequência local, tipo, horário local e, quando aplicável, `electionViewId`, `candidateToken`, `batchId`, `attemptId` e `receiptId`. Uma sessão de trace é uma abertura do quadro; não confundir a sessão HTTP de autenticação, a aba, o usuário e o clientID Yjs.

O servidor acrescenta usuário e conta autenticados, origem da evidência, cursor de ingestão e horário de recebimento. Identidade e origem declaradas pelo cliente não podem sobrescrever esses campos. Nomes servem para leitura; IDs distinguem duas abas da mesma conta.

`electionViewId` identifica a escolha observada por um peer, não uma eleição global. Registrar o conjunto ordenado de candidatos com clientID, geração, prioridade, elegibilidade e motivo de exclusão, além do vencedor e da regra de desempate. Instrumentar criação/renovação de candidatura mesmo quando o vencedor não muda. Emitir nova visão apenas quando candidaturas, elegibilidade ou escolha mudarem; heartbeat e idade crescente, isoladamente, não geram eventos.

As razões incluem entrada/saída de peer, mandato renovado, pausa/retomada local, presença expirada, falha/timeout e recuperação direta. A regra atual é a menor prioridade de 32 bits, com desempate pelo ID. A decisão usa a visão efetiva do coordenador, sem recalculá-la a partir de um catálogo global do servidor.

Cada requisição que carrega conteúdo ganha um `attemptId` novo. O `batchId` permanece no retry. Capturar a visão da eleição e o motivo na hora do envio, inclusive quando um lote anteriormente preparado é reenviado. Consultas de bootstrap/polling não viram lotes de conteúdo na interface. Recibos recebem um identificador derivado dos bytes do recibo assinado para ligar observações diretas e encaminhadas sem guardar o documento ou a cobertura inteira no trace.

### Coletar os eventos na sessão

Acrescentar um coletor local de metadados, criado com `openBoardSession`, independente da montagem do painel. Registrar candidatura, visão eleitoral, início/falha/cancelamento da tentativa, recepção do ACK, resultado da verificação, primeira publicação do recibo aos peers e confirmação ou pendência por cobertura. Deduplicar observações do mesmo recibo e resultado antes de registrar, evitando um evento por heartbeat.

Usar IndexedDB para uma fila por conta e quadro, com identidade de sessão de trace dentro dos eventos. Padrões: até 1.000 eventos ou 4 MiB por fila, evento de até 32 KiB. O append é assíncrono e não bloqueia eleição, edição ou envio de conteúdo. Registrar e exibir indisponibilidade da gravação local, descarte por limite e intervalos de sequência perdidos. Não apresentar um encerramento abrupto anterior ao append como captura garantida.

Entregar os relatos diretamente, autenticados por participante, em `POST /api/boards/:id/persistence-trace`. Agrupar até 32 eventos ou 64 KiB por requisição, com no máximo um envio a cada 10 segundos por cliente; enviar imediatamente ao restabelecer a conexão, respeitando os mesmos limites. Sem heartbeats de diagnóstico quando a fila estiver vazia. Uma resposta devolve IDs aceitos ou já recebidos; removê-los da fila só após essa confirmação de coleta, distinta do ACK de persistência do quadro. Retentativas usam espera crescente de 1, 2, 5, 10 e 30 segundos, sem laço contínuo.

Revalidar sessão e membership após ler o corpo. Parar novas submissões ao sair do quadro, sair da conta ou receber revogação; eventos retidos só podem ser retomados pela mesma conta com acesso vigente. Limpar listeners e timers ao destruir a sessão. A pausa da VPS no experimento continua afetando apenas o documento; diagnóstico pode funcionar e deve ser identificado como tal.

### Persistir sem misturar diagnóstico com estado do quadro

Uma migração aditiva cria `persistence_trace_events`, com cursor, quadro, ID do evento, conta/usuário do relator, sessão de trace, origem, tipo, IDs de correlação, horário local, sequência, ingestão e JSON validado. Índices por quadro/cursor, quadro/lote e quadro/visão eleitoral; unicidade por quadro, relator e evento para deduplicar. Uma pequena tabela de estado por quadro conserva contagem de descartes e cursor de retenção para sinalizar histórico incompleto.

Padrões de retenção: 2.048 eventos ou 8 MiB por quadro, eliminando os mais antigos em transação. Consultas filtram lote, participante ou visão e paginam por cursor com até 50 itens. `GET /api/boards/:id/persistence-trace` fornece lista e detalhes correlacionados, limites ativos, disponibilidade e lacunas conhecidas. Links para eventos removidos mostram "Expirou pela retenção". Esse armazenamento é separado do histórico de snapshots, das linhas operacionais e de `persistence_batches`.

Instrumentar a API de persistência para registrar recepção da tentativa, commit/deduplicação e emissão da resposta ACK, com relógios do próprio servidor. Acrescentar metadados opcionais e limitados à requisição de conteúdo, incluindo tentativa e visão observada, mantendo compatibilidade com clientes anteriores. A emissão da resposta significa que o servidor escreveu a resposta, não que o navegador a recebeu. Falhas da coleta são independentes do COMMIT e do envio do ACK; uma lacuna permanece desconhecida. Não reexecutar uma persistência para reparar o diagnóstico.

Recusar tipos de evento de servidor enviados por clientes, limitar campos e não aceitar credenciais, bytes Yjs, arquivos de imagem ou chaves privadas. Os relatos comprovam qual conta os submeteu, não que os sorteios ou horários relatados são verdadeiros. Apenas eventos gerados na VPS são classificados como fatos observados pela VPS; recibos continuam a ser validados pelo mecanismo existente.

### Mostrar a sequência no Experimento

Acrescentar uma seção "Eleição e persistência" junto ao estado das ações. No topo, mostrar o representante visto por esta aba, o motivo da escolha e o estado da coleta. Explicar "Pausar VPS afeta esta aba; outro participante pode continuar gravando" junto aos controles existentes.

A lista recente agrupa por lote e apresenta nome do remetente, horário de commit conhecido, bytes e situação. Ao abrir um lote, mostrar etapas com texto e ícone, sem depender apenas de cor: escolha observada, tentativas, chegada à VPS, gravação/deduplicação, resposta emitida e ACKs observados por participante. Separar uma tentativa expirada de um lote já persistido; um ACK tardio pode aparecer depois do timeout sem apagar a tentativa anterior. Recuperação direta deve explicar por que aquele peer enviou mesmo sem ser representante da sala.

Os detalhes da eleição mostram tabela de participante/aba, número sorteado em decimal completo, elegibilidade, vencedor e desempate, com a legenda "Visão de [participante]". Mostrar duas visões divergentes lado a lado quando selecionadas, sem fabricar consenso. O primeiro nível usa nomes; IDs, assinaturas resumidas e metadados ficam em detalhes expansíveis. Relatos e fatos do servidor recebem rótulos distintos.

Usar paginação e filtros por lote ou participante. Atualizar a seção a cada 2 segundos enquanto Experimento estiver ativo e a página visível. O estado local pode atualizar imediatamente; o histórico compartilhado mostra o horário da última coleta. Suspender consultas ao ocultar a seção, trocar de quadro ou destruir a sessão, sem remontar o Canvas. Consultas com falha preservam os dados já carregados e mostram o erro.

Horários são apresentados com sua origem. Medir envio até recepção/verificação do ACK com relógio monotônico da mesma sessão de trace; apresentação em milissegundos, sem subtrair relógio do cliente do relógio da VPS. ACK recebido de um peer sem observação do envio local não tem RTT inventado. ACK ausente aparece como "Sem registro de recebimento"; uma resposta com assinatura inválida aparece como rejeitada. Lotes anteriores à instrumentação mostram apenas fatos disponíveis e "Eleição não registrada nesta versão".

### Conservar a leitura dos custos

Registrar requisições e bytes do novo endpoint em um contador de diagnóstico separado dos canais de sincronização de conteúdo, no painel e nas exportações existentes. O intervalo de 10 segundos agrupa metadados e não altera os lotes de conteúdo de 1 segundo. Nenhum número de desempenho será deduzido da redução do número de remetentes.

## Risks / Trade-offs

- Relatos chegam fora de ordem ou não chegam. Correlacionar por IDs, preservar sequência local e mostrar lacunas conhecidas; ausência de relato não prova ausência de ACK.
- A sala pode observar representantes diferentes. Conservar a perspectiva de cada observador; não introduzir consenso para tornar o desenho mais simples.
- Telemetria acrescenta custo ao servidor fraco. Agrupar submissões, eliminar heartbeats, limitar histórico e medir esse custo separadamente.
- O histórico pode expirar no meio de uma sequência. Preservar os registros restantes, indicar referências indisponíveis e nunca podar dados de recuperação do quadro.
- Usuários podem relatar números e horários falsos. Vincular a conta autenticada, rotular como relato e manter a decisão de persistência fora do diagnóstico.

## Migration Plan

Aplicar migração aditiva e distribuir o cliente instrumentado. Não reconstruir eleições antigas a partir do usuário que enviou um lote. Clientes antigos permanecem compatíveis com persistência e aparecem com detalhes indisponíveis. Reverter o cliente deixa as tabelas novas inativas; não remover as tabelas duráveis do quadro nem reverter a eleição existente.
