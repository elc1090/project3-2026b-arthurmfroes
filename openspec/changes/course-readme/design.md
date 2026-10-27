# Design

## Context

O projeto 1 usa relato pessoal e comentários diretos sobre decisões técnicas. O projeto 2 separa processo e trechos, com exemplos do código e explicações do mecanismo. Usar essa estrutura e preservar o texto da proposta já escrito pelo usuário.

## Decisions

Os trechos virão de board-session.js, room-persistence.js e do protocolo Yjs quando necessário. Explicar que conciliação é feita em cada réplica e que o representante reduz envios normais ao servidor, sem prometer consenso global nem ganho linear. A URL Render será usada somente após /health confirmado. A demonstração usa uma fixture com banco temporário e perfis isolados; arquivos e quadros reais não serão alterados.

## Risks / Trade-offs

O plano Render gratuito não conserva SQLite e imagens após reinício; manter esse limite no README. Relatos de processo devem se limitar à conversa e ao histórico do projeto. A autoria do código por agentes será declarada, seguindo a forma dos READMEs anteriores.
