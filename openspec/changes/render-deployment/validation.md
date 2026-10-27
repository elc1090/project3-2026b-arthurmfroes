# Validação

Data: 26/10/2026. Node local v24.21.0.

## Conteúdo isolado do commit

O índice do Git foi extraído com `git write-tree` e `git archive` para `/tmp/render-build-brt_cjql`, sem node_modules, bundles ignorados ou alterações locais anteriores. Foram executados:

- `npm ci --include=dev`: exit 0; 70 pacotes instalados; auditoria com 0 vulnerabilidades.
- `npm run build:client`: exit 0; bundle gerado de 610,2 KiB.
- `node --test test/render-startup.test.js test/foundation.smoke.test.js test/auth.smoke.test.js test/signaling.test.js`: 6 testes, 6 passaram, 0 falhas e 0 ignorados, em 589 ms.

A mesma seleção havia passado no working tree, com 6 testes em 637 ms. Os testes foram repetidos no checkout isolado para excluir dependência das alterações de checkpoint que já estavam no diretório de trabalho e não fazem parte deste commit.

## Processo real

O teste de entrada iniciou `node src/server/main.js` na cópia isolada, com bancos temporários e porta escolhida livre. Instâncias verificadas:

| Worktree | PID | URL | Bind |
| --- | --- | --- | --- |
| `/tmp/render-build-brt_cjql` | 147768 | `http://127.0.0.1:35475` | padrão `0.0.0.0` |
| `/tmp/render-build-brt_cjql` | 147799 | `http://127.0.0.1:41423` | HOST explícito `127.0.0.1` |

A saída de inicialização confirmou HOST e PORT. `/health` respondeu 200; cadastro, login com `X-Forwarded-Proto: https` e cookie Secure/HttpOnly passaram. Um WebSocket autenticado assinou o tópico do quadro e a API persistence-trace respondeu 200. Os processos foram encerrados pelo próprio teste e a cópia temporária foi removida. Não foi reiniciado nenhum servidor existente do usuário.

## Configuração e documentação

- `render.yaml` lido pelo parser YAML; campos de runtime/plano e tipos das variáveis verificados localmente. Isso não equivale à validação remota de um Blueprint na conta Render.
- `openspec validate render-deployment --strict`: change válida; sem deltas funcionais, conforme skip_specs.
- `git diff --cached --check`: sem erros.
- Serviço criado manualmente precisa dos campos documentados em docs/render-deployment.md. O Blueprint não substitui automaticamente os comandos ou a branch já configurados no painel.

## Limites

Não houve execução na infraestrutura Render nem alteração do serviço remoto. A compatibilidade do ambiente nativo foi verificada com instalação limpa em Linux e Node 24.21.0. A perda de dados locais no Render Free continua uma limitação conhecida e documentada; não houve migração de contas, SQLite ou imagens para serviço externo.
