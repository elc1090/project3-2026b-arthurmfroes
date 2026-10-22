# Proposal

## Why

O banco identifica quem enviou um lote e quando ele foi persistido, mas não registra os números sorteados, a visão dos candidatos ou a entrega do ACK a cada peer. O painel Experimento precisa permitir reconstruir uma tentativa de sincronização e explicar a escolha do representante.

## What Changes

- Registrar candidaturas, números sorteados, gerações, decisões observadas e motivos de substituição do representante.
- Relacionar cada tentativa ao lote, à eleição observada pelo remetente, ao recebimento e à gravação na VPS e aos ACKs recebidos e verificados pelos peers.
- Conservar eventos recentes no SQLite e manter uma fila local de metadados durante desconexões, mesmo com o painel fechado.
- Mostrar nomes dos participantes, candidatos ordenados, justificativa da escolha e uma sequência visual por lote no Experimento, com detalhes técnicos expansíveis.
- Distinguir fatos observados pela VPS, relatos dos clientes, duração medida localmente, lacunas de coleta e histórico expirado.
- Limitar o volume de diagnóstico e contabilizá-lo separadamente da sincronização do documento.

## Capabilities

### New Capabilities

Nenhuma.

### Modified Capabilities

- `sync-observability`: histórico correlacionado de eleição, tentativas de persistência e ACKs; apresentação compreensível no painel Experimento.

## Impact

Instrumentação em `room-persistence.js` e `board-session.js`, eventos de `room-persistence.js` do servidor, armazenamento e consulta de diagnóstico, painel Experimento, testes e documentação. A change complementa `elected-room-persistence`, já implementada, sem mudar a regra eleitoral, os intervalos, a validação dos recibos ou a reconciliação Yjs. O registro não será um log de consenso global nem uma prova de que um cliente relatou honestamente seu sorteio. O palco e os slides ficam fora do escopo.
