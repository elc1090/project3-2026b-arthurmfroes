# Tasks

## 1. Contrato dos eventos

- [x] 1.1 Definir contrato versionado de candidatura, visão eleitoral, tentativa, eventos da VPS e observações de recibo, com IDs de correlação, fonte da evidência e relógios. Documentar em docs/elected-persistence.md; verificar com testes de validação, números de 32 bits, tamanho, identidade e separação entre relógios locais.

## 2. Armazenamento e consulta na VPS

- [x] 2.1 Criar migração e store de persistence_trace_events com deduplicação por relator/evento, índices de correlação, retenção de 2.048 eventos ou 8 MiB por quadro e metadados de lacunas. Documentar retenção; testar restart, paginação, referências expiradas e poda sem alteração em updates, checkpoints, assets ou recuperação do quadro.
- [x] 2.2 Implementar POST e GET autenticados em /api/boards/:id/persistence-trace, com identidade atribuída pela sessão, revalidação após leitura, 32 eventos/64 KiB por submissão, 32 KiB por evento e páginas de até 50 itens. Documentar API; testar acesso de outro quadro, revogação durante upload, identidade forjada, origem VPS proibida ao cliente, payload inválido e entrega duplicada.

## 3. Instrumentação e coleta local

- [x] 3.1 Instrumentar room-persistence.js do cliente para registrar números/gerações, mudanças materiais da visão, regra de escolha, desempate, motivos, attempts e recepção/verificação/encaminhamento de recibos. Preservar batchId no retry e gerar attemptId novo por envio. Testar rotação sem troca de vencedor, empate, timeout, recuperação direta, recibo inválido, edição fora da cobertura e visões diferentes em partição; não criar eventos por heartbeat ou polling sem conteúdo.
- [x] 3.2 Integrar fila IndexedDB por conta/quadro à board-session, independente da abertura do Experimento, com 1.000 eventos/4 MiB, envio agrupado a cada 10 segundos, retry limitado, confirmação de coleta, lacunas e cleanup. Passar a identidade autenticada a partir da abertura do quadro. Documentar pausa e coleta; testar desconexão, reabertura, falha de storage, limite, saída da conta, troca de quadro e revogação sem bloquear desenho ou persistência.
- [x] 3.3 Instrumentar a API de persistência e o diagnóstico do servidor para relacionar recebimento, commit/deduplicação e resposta ACK emitida à tentativa, sem depender do log para concluir persistência. Testar ACK perdido com retry, resposta interrompida, falha do store diagnóstico, cliente antigo sem metadados e histórico de lote anterior à coleta.
- [x] 3.4 Acrescentar contadores de requisições/bytes de diagnóstico separados dos envios de conteúdo no painel e nas exportações existentes. Documentar o escopo da medição; testar fixture de 20 candidaturas, ausência de submissões por heartbeat, agrupamento/limites e exportação sem somar telemetria como lote do documento.

## 4. Painel compreensível

- [x] 4.1 Criar a seção Eleição e persistência no Experimento, com representante observado, estado da coleta, lista por lote, filtros, paginação e detalhes expansíveis. Mostrar nomes e abas, tabela de sorteios/elegibilidade, motivo e etapas de cada tentativa/ACK; rotular relatos, fatos da VPS, relógios e lacunas, e explicar que Pausar VPS vale para esta aba. Verificar em browser os estados completo, timeout seguido de retry, ACK tardio, recibo rejeitado, recuperação direta, dado antigo e histórico expirado, incluindo teclado, tela estreita e ausência de JSON no primeiro nível.
- [x] 4.2 Integrar o painel ao ciclo do quadro com atualização de 2 segundos somente quando a seção estiver ativa e visível, preservando dados em falhas e mantendo o Canvas montado. Testar atualização sem F5, fechamento da seção, página oculta, troca de quadro, resposta atrasada e destruição sem listeners, timers ou dados de outro quadro.

## 5. Verificação integrada

- [x] 5.1 Executar cenário de três perfis reais com eleição, lote de outro autor, ACK direto/encaminhado, pausa local, timeout/troca e partição; recarregar o painel e reiniciar a VPS para conferir os registros retidos e a distinção entre persistência e ACK por participante. Executar regressões de room-persistence, board-sync-status, inspection-history, sync-experiment, elected-room-persistence.browser, multiclient-recovery.browser e revocation.browser; registrar comandos, resultados e limitações em validation.md da change.
