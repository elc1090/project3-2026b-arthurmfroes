# Proposal

## Why

O primeiro deploy no Render falhou porque a faixa Node sem limite superior selecionou Node 26, incompatível com better-sqlite3 12.2.0. O processo também escuta apenas em loopback, impedindo o acesso pelo proxy da plataforma.

## What Changes

- Fixar o runtime do Render em Node 24.21.0 e limitar a faixa suportada no manifesto e lockfile.
- Aceitar HOST e PORT no processo de entrada, com bind público por padrão e opção de loopback local.
- Fornecer Blueprint gratuito com npm, build do cliente, health check e cookies HTTPS atrás do proxy.
- Documentar a configuração do serviço já criado e a branch que contém o histórico de eleições.

## Capabilities

### New Capabilities

Nenhuma. Preparação de runtime e deploy, com skip_specs: true.

### Modified Capabilities

Nenhuma regra funcional do produto será alterada.

## Impact

package.json, package-lock.json, .node-version, render.yaml, entrada de src/server/main.js e docs de deploy. Mantém SQLite e imagens locais; a persistência externa continua sendo uma decisão separada, ainda não respondida. O serviço gratuito tem armazenamento efêmero e não será apresentado como armazenamento durável. Não altera contas existentes, algoritmo eleitoral, Yjs, slides ou palco. Commit e push autorizados; a mudança não inclui publicação pelo painel do Render.
