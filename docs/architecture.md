# Limites da aplicação T3

O processo Node é a única aplicação de servidor. `src/server/main.js` inicia o HTTP,
aplica migrações e serve `src/public/`; `whiteboard/` continua sendo a referência do
produto original e não é servido nem modificado por esta base.

| Módulo | Responsabilidade | Contrato compartilhado |
| --- | --- | --- |
| Contas e acesso | contas, sessões, pedidos e verificação de membership | `AccountId`, `SessionContext`, `BoardMembership`, `AuthorizedBoardSession` |
| Boards | IDs estáveis, metadados e associação de um board a um documento | `BoardId`, `BoardDocument` |
| Sync | transporte e persistência de updates Yjs opacos; ACK só após commit | `BoardUpdate`, `DurableUpdateAck` |
| Assets | bytes fora do documento; board guarda referência e dimensões | `AssetId`, `BoardAssetRef` |
| Diagnóstico | eventos observados por réplica, sem alegar ordem global | `DiagnosticEvent` |

Os contratos TypeScript em `src/shared/contracts.d.ts` fixam somente os campos de
fronteira necessários às próximas tarefas. Eles não definem rotas, protocolo de rede
nem formato interno do conteúdo Yjs. A migração `001-foundation.sql` cria o esquema
estrutural correspondente; cada alteração posterior deve entrar como arquivo
`NNN-nome.sql` em `src/server/migrations/`. O bootstrap ordena pelo prefixo numérico
e registra cada migração somente depois de executá-la com sucesso em sua transação.

Requisitos locais: Node.js 22.13 ou superior e npm. As versões diretas estão exatas
em `package.json` e todas as versões transitivas são travadas em `package-lock.json`.
`npm ci` instala a árvore travada; `npm run smoke` valida entrada estática, health
check e migração em um banco temporário.

O cookie de sessão recebe `Secure` em uma conexão HTTPS direta. Para HTTPS terminado
em proxy reverso local, configure `TRUST_PROXY=true` somente se o proxy confiável
substituir `X-Forwarded-Proto`; por padrão, esse cabeçalho enviado pelo cliente é
ignorado. O servidor Node escuta em `127.0.0.1` para esse arranjo.
