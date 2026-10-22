# Tasks

## 1. Recibos e persistência

- [x] 1.1 Implementar cobertura Yjs e recibos autenticados de bootstrap/lote, autorização e deduplicação SQLite após checkpoint; verificar testes de API, cobertura, falsificação e repetição por outro membro. Documentar API e limites em docs/elected-persistence.md.

## 2. Coordenação e sessão

- [x] 2.1 Implementar coordenador com eleição aleatória compartilhada, rotação, lotes, timeout, ACK via peers e recuperação direta; integrar sessão, pausas, revogação e status. Verificar testes controlados de eleição, falha, edição durante envio e cleanup, e documentar tempos padrão.

## 3. Integração

- [x] 3.1 Verificar em Chromium real a colaboração com um remetente, ACK nos demais, saída do representante, ausência de P2P e reabertura offline; executar testes de regressão de autenticação, persistência e sincronização e registrar resultados.
