# Design

## Context

Ver proposal.md. O app usa o mesmo servidor HTTP para estáticos, API e upgrades WebSocket. Já lê PORT e TRUST_PROXY, já possui /health e usa better-sqlite3 com módulos nativos. npm start executa um prestart que recompila o cliente.

## Goals / Non-Goals

**Goals:** instalar e compilar em Node suportado, iniciar sem depender de devDependencies em runtime e aceitar o proxy público do Render.

**Non-Goals:** migração de banco, troca de armazenamento de imagens, provisionamento de recursos pagos, alteração do serviço remoto, apresentação e palco.

## Decisions

- .node-version fixa 24.21.0, já usado na validação local. package.json e lockfile limitam Node a >=22.13.0 <25 para impedir nova seleção de Node 26 por engines sem teto.
- HOST é configurável e tem padrão 0.0.0.0. PORT continua vindo do ambiente. O log informa o endereço de bind real. Quem desejar apenas loopback pode definir HOST=127.0.0.1.
- render.yaml declara um web service Node free. Build usa npm ci --include=dev && npm run build:client; runtime usa node src/server/main.js diretamente, evitando recompilar no prestart. TRUST_PROXY=true reconhece HTTPS terminado pelo Render e mantém cookies Secure. O Blueprint declara /health e gera SIGNALING_SECRET estável no ambiente.
- O serviço já criado manualmente requer configurar os mesmos campos no painel. O Blueprint não altera automaticamente um serviço manual. Após a aprovação da integração, a documentação e o Blueprint apontam para main, que passa a conter o histórico de eleições e a correção do Render.

## Risks / Trade-offs

- Render Free elimina SQLite e imagens locais em restart, redeploy e suspensão. Documentar explicitamente; esta correção não resolve durabilidade externa nem autoriza perda dos dados locais existentes.
- Variável NODE_VERSION no painel tem precedência sobre .node-version. Documentar sua remoção ou ajuste para 24.21.0 se ela existir.
- O bind padrão passa a aceitar interfaces externas. Preservar HOST como opção local e manter autenticação e autorização existentes.

## Migration Plan

Executar build limpo com lockfile em cópia isolada, verificar processo com HOST=0.0.0.0 e PORT livre, /health, cadastro e cookie Secure pelo proxy, e WebSocket autenticado. Rodar regressões de autenticação, signaling e foundation. Depois commitar apenas estes arquivos e enviar para main após a integração aprovada. O usuário seleciona a branch e os campos documentados no serviço Render. Reverter o commit reverte runtime e configuração, sem migrar ou apagar dados.
