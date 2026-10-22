# Proposal

## Why

Cada cliente encaminha à VPS inclusive updates recebidos dos peers, e a VPS retransmite esses dados para a sala. Uma sala P2P pode reduzir cópias e transações delegando a persistência periódica a um representante.

## What Changes

- Eleger entre peers um representante temporário com prioridade aleatória compartilhada, rotação e substituição após falha.
- Agrupar updates incrementais e confirmar sua cobertura com recibos assinados pela VPS após COMMIT.
- Propagar recibos por P2P, mantendo pendentes as edições não cobertas.
- Recuperar por acesso direto à VPS quando P2P ou representante falharem.
- Preservar IndexedDB, autorização e compatibilidade do endpoint WebSocket existente.

## Capabilities

### New Capabilities

### Modified Capabilities

- `board-sync`: persistência delegada, confirmação por lote e recuperação sem dependência de um único peer.

## Impact

Sessão do cliente, novo coordenador P2P e transporte HTTP de persistência, API autenticada, migração SQLite para deduplicação de lotes e testes. Sem nova dependência. A mudança não inclui o ajuste de localhost do palco nem promete redução linear do volume de informação nova.
