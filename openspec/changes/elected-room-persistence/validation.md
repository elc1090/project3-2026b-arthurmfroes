# Verificação

Executada em 22/10/2026, com Node.js 24.21.0 e Chromium local. Um worktree isolado recebeu somente o patch desta mudança, sem as alterações locais anteriores de checkpoint, README ou palco.

- Todos os testes sem navegador, selecionados com `rg --files test -g '*.test.js' -g '!*.browser.test.js'` e executados por `node --test`: 69 passaram, 0 falharam, 0 pulados.
- `node --test --test-concurrency=1 test/elected-room-persistence.browser.test.js test/board-session.browser.test.js test/multiclient-recovery.browser.test.js test/revocation.browser.test.js test/sync-experiment.browser.test.js test/board-image-ui.browser.test.js test/replica-panel.browser.test.js`: 10 passaram, 0 falharam, 0 pulados.
- Na execução isolada do cenário novo, os dois perfis reais produziram seis edições; os contadores de upload foram `[1, 0]` e o servidor gravou uma linha. Ambos receberam confirmação. Esse resultado verifica a delegação, sem constituir benchmark com 20 usuários.
- Depois dos testes de navegador, acrescentou-se a revalidação de acesso após a leitura do corpo HTTP. O teste de revogação durante upload passou e a suíte sem navegador foi executada novamente no worktree isolado, com os 69 resultados acima.
- `openspec validate elected-room-persistence --strict`: mudança válida.
- `git diff --cached --check`: sem erros.

A regressão de conflitos foi adaptada para aguardar o recibo do lote antes de comparar a VPS; visibilidade entre peers agora antecede a persistência periódica. O teste de migração verifica as cinco versões e a nova tabela. Os contadores e o teste de comparação registram HTTP, preservando os contadores WebSocket para clientes legados.

A suíte completa de navegador do projeto não foi executada. Os sete arquivos selecionados cobrem o transporte alterado, conflito, retomada, imagens, diagnóstico e revogação. Não foi feito teste de carga com 20 usuários nem deploy. O ajuste de localhost do palco permanece fora desta mudança.
