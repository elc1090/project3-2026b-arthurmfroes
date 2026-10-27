# Deploy no Render

O app é um **Web Service Node**, com API, arquivos estáticos e WebSockets no mesmo processo. A versão está em `.node-version`: **24.21.0**. O Render respeita esse arquivo; uma variável `NODE_VERSION` configurada no painel tem precedência e deve ser removida ou ter o mesmo valor.

## Serviço criado manualmente

Em Settings, use os seguintes valores:

| Campo | Valor |
| --- | --- |
| Branch | `main` |
| Root Directory | vazio, raiz do repositório |
| Build Command | `npm ci --include=dev && npm run build:client` |
| Start Command | `node src/server/main.js` |
| Health Check Path | `/health` |
| Instance Type | Free |

Em Environment, configure:

| Variável | Valor |
| --- | --- |
| `NODE_VERSION` | `24.21.0`, se existir; pode ser removida para usar `.node-version` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `TRUST_PROXY` | `true` |
| `SIGNALING_SECRET` | segredo aleatório estável, mantido entre deploys |

O Render fornece `PORT` automaticamente. O servidor usa essa porta e aceita conexões em `0.0.0.0`. Para desenvolvimento restrito ao próprio computador, use `HOST=127.0.0.1`.

O build inclui esbuild, que está nas devDependencies. O comando de início executa o servidor diretamente; `npm start` possui um prestart que recompila o cliente e não é necessário no Render. Use npm com `package-lock.json`, evitando o Yarn escolhido automaticamente no primeiro deploy.

Após salvar os campos, use **Manual Deploy → Deploy latest commit** na branch correta. O deploy observado inicialmente usava `4f53f9b`, anterior ao histórico de eleições. Trocar os comandos sem trocar a branch não publica as correções deste documento.

## Blueprint

Para criar outro serviço pelo fluxo **New → Blueprint**, o repositório contém `render.yaml` com os mesmos comandos, plano Free, health check, proxy HTTPS e geração de `SIGNALING_SECRET`. O arquivo não reconfigura um serviço que foi criado manualmente como Web Service.

## Dados no plano gratuito

Esta configuração mantém o banco SQLite em `data/whiteboard.sqlite` e as imagens em `data/assets`. **Esses dados são locais e podem desaparecer em reinício, novo deploy ou suspensão do serviço gratuito.** Isso inclui contas, sessões, memberships, quadros, recibos e histórico de eleições. O IndexedDB do navegador não substitui o banco de contas nem os arquivos de imagem do servidor.

A instância Free também pode dormir após 15 minutos sem tráfego e demorar para atender a primeira conexão. Esta correção resolve o runtime e o acesso ao servidor; ela não migra os dados para armazenamento externo nem oferece persistência durável no Render Free. O banco local do computador não é enviado no deploy.

## Verificação após publicar

- `/health` deve responder `200` com `{"status":"ok"}`.
- Cadastro e login devem funcionar pela URL HTTPS; o cookie `whiteboard_session` deve ter `Secure` e `HttpOnly`.
- Abrir o mesmo quadro em dois perfis deve estabelecer a conexão P2P pela sinalização autenticada. Os WebSockets usam `wss` quando a página está em HTTPS.
- Em Experimento, o histórico deve carregar sem 404 na rota `persistence-trace`.

Referências: [Web Services](https://render.com/docs/web-services), [versão do Node](https://render.com/docs/node-version), [Blueprint](https://render.com/docs/blueprint-spec), [limites do Free](https://render.com/docs/free) e [WebSockets](https://render.com/docs/websocket).
