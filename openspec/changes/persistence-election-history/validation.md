# Validação

Data: 22/10/2026. Ambiente local, Node 24.21.0, Chromium/Google Chrome headless e SQLite temporário. Change `persistence-election-history`.

## Comandos e resultados finais

Testes sem navegador, incluindo room-persistence, board-sync-status, inspection-history, sync-experiment e as novas suites de trace:

```bash
mapfile -t trace_tests < <(rg --files test -g '*.test.js' -g '!*.browser.test.js')
node --test "${trace_tests[@]}"
```

Resultado: **83 testes, 83 passaram, 0 falhas, 0 ignorados**. Duração da última rodada: 3.077 ms.

Antes do commit, o conteúdo do índice foi extraído isoladamente com `git write-tree` e `git archive`, usando apenas as dependências instaladas do projeto. A mesma seleção de testes passou com **82 testes, 0 falhas**, em 2.865 ms. A diferença de um teste corresponde à alteração local de checkpoint que já existia e ficou fora deste commit.

Regressões de browser e cenário integrado:

```bash
node --test --test-concurrency=2 \
  test/persistence-trace.browser.test.js \
  test/elected-room-persistence.browser.test.js \
  test/multiclient-recovery.browser.test.js \
  test/revocation.browser.test.js \
  test/sync-experiment.browser.test.js
```

Resultado: **8 testes, 8 passaram, 0 falhas, 0 ignorados**. Duração: 41.571 ms. Os testes constroem o bundle para as fixtures; não foi reiniciado o servidor de desenvolvimento do usuário.

```bash
OPENSPEC_TELEMETRY=0 openspec validate persistence-election-history --strict
```

Resultado: `Change 'persistence-election-history' is valid`.

`git diff --check` nos arquivos rastreados desta implementação passou. O comando global também aponta espaços finais no README que já estava modificado antes desta change; esse arquivo foi preservado.

## Evidências

- Três contextos isolados de browser, autenticados como contas diferentes, estabelecem WebRTC e observam o mesmo representante. Uma edição de outro autor é persistida pelo representante. Os três relatores registram o mesmo recibo, com um ACK direto da VPS e dois recebidos pelo P2P, mesmo sem abrir o Experimento.
- Pausa da VPS em uma aba permite que outro membro persista. Pausa do P2P conserva uma visão eleitoral separada e produz envio marcado como recuperação direta. Um envio retido além do prazo produz timeout e outro participante conclui a persistência.
- A última execução conservou **93 eventos** ao parar e reiniciar a instância HTTP da fixture no mesmo endereço. O painel reaberto mostrou os lotes persistidos. Isso testa restart da aplicação com o mesmo banco; a suite de store também abre outra conexão SQLite no arquivo para conferir durabilidade dos registros.
- Retry usa o mesmo batchId e outro attemptId. A API registra commit deduplicado. Resposta interrompida conserva o commit sem criar evidência de ACK emitido; falha na tabela de diagnóstico não impede a gravação e o recibo do quadro. Requisições antigas sem metadados continuam funcionando.
- Recibo forjado é rejeitado. Um recibo anterior confirma apenas a edição coberta e registra a edição posterior como pendente. ACK tardio permanece associado à tentativa que expirou.
- Fila IndexedDB sobrevive à reabertura, separa contas e quadros, limita quantidade e bytes e remove somente IDs cuja coleta foi confirmada. Falha de storage é visível. Submissões são agrupadas em 32, 32 e 6 eventos na fixture de 70 eventos; respeitam 64 KiB, intervalo normal de 10 segundos e retry de 1, 2, 5, 10 e 30 segundos. Revogação e destroy interrompem novas requisições.
- A fixture de 20 candidaturas preserva números e desempate. Trinta heartbeats não criam novos registros de eleição. A renovação produz outro sorteio mesmo sem mudar o vencedor. Contadores e exportações mantêm diagnóstico separado dos updates HTTP do documento.
- O painel diferencia relatos e fatos da VPS, exibe números completos, abas, timeout/retry, ACK tardio/rejeitado, recuperação direta, edição ainda pendente, eleição antiga não registrada e retenção expirada. Filtros, paginação, duas visões lado a lado, abertura por Enter e conservação do foco após atualização foram exercitados.
- Consultas param com a seção fechada, com a página oculta e após destroy. Resposta atrasada é descartada; erro HTTP 503 preserva o histórico carregado. O Canvas conserva a mesma instância. Logout remove o painel e abrir outro quadro no mesmo perfil não exibe os lotes anteriores.
- Inspeção adicional pela sessão CLI `codex-election-history` na aplicação completa. Em viewport de 390 × 844, a largura total da página foi 390 px e a do painel 358 px; captura conferida visualmente, sem rolagem horizontal da página. Sessão de inspeção encerrada ao terminar.

## Ajustes nos testes durante a validação

O teste de upload aguardava apenas a pendência zerar, o que ocorre antes de terminar o registro assíncrono do ACK. Agora espera também o evento `ack-verified`. A contagem antes do restart é capturada depois de encerrar as requisições em trânsito. Esses ajustes evitam confundir trabalho assíncrono em conclusão com perda de histórico.

A regressão de sync-experiment exigia bytes HTTP especificamente de Alice em todos os modos. No modo híbrido, Alice pode ser seguidora e receber somente o recibo P2P após zerar os contadores. O teste agora exige intercâmbio HTTP de pelo menos um representante e, no modo sem P2P, intercâmbio de ambas as réplicas. Continua verificando conteúdo, convergência e persistência.

## Limites da verificação

Não houve deploy nem teste na VPS externa. A partição foi exercitada suspendendo o P2P de um perfil, mantendo HTTP disponível. O teste de página oculta controla visibilityState e dispara visibilitychange. A fixture de 20 candidaturas é determinística, não um benchmark com 20 usuários reais. ACK tardio/rejeitado e retenção expirada usam casos controlados; a integração real cobre recibos válidos diretos/encaminhados, timeout, troca de representante, pausa e recuperação. Não se infere ganho de capacidade ou latência de rede entre relógios diferentes a partir desses resultados.
