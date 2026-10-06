# Demonstração local do T3

Este roteiro abre o quadro em perfis de navegador separados e mostra quando uma edição está local, chegou por P2P e foi gravada pelo servidor. Ele também registra casos que ainda dependem da integração das tarefas 7.3 e 7.4. Não há números de desempenho neste documento: eles precisam vir de uma execução medida.

## Preparar e iniciar

Use Node.js 22.13 ou posterior. `package.json` define essa versão mínima. Na raiz do repositório:

```sh
npm ci
npm run build:client
```

`npm start` executa `prestart`, que chama `npm run build:client` novamente, e inicia o serviço. Configure um banco e uma chave de sinalização estável para a demonstração:

```sh
mkdir -p data
export DATABASE_PATH="$PWD/data/t3-demo.sqlite"
export PORT=3000
export SIGNALING_SECRET='troque-por-uma-chave-aleatoria-longa-e-reutilize-a-mesma'
npm start
```

O processo escuta em `127.0.0.1:3000`. Abra <http://127.0.0.1:3000> no navegador. Deixe esse terminal aberto; `Ctrl+C` encerra o processo. O SQLite fica em `data/t3-demo.sqlite` e os arquivos de imagem ficam em `data/assets/`. Use o mesmo `DATABASE_PATH` e `SIGNALING_SECRET` se reiniciar o processo durante a demonstração.

O serviço está vinculado ao loopback. Para este roteiro, abra os perfis de navegador na mesma máquina. O controle chamado "Pausar VPS" pausa a sincronização daquela sessão do navegador; não derruba o processo nem bloqueia as rotas HTTP de upload.

## Abrir perfis e conceder acesso

Crie dois perfis independentes no Chrome/Chromium ou use navegadores diferentes. Não use duas abas do mesmo perfil: elas compartilham cookies e IndexedDB, então não representam membros com armazenamento isolado. Para late join, abra um terceiro perfil.

1. No perfil A, escolha "Criar uma conta", registre um usuário e entre. Em "Novo quadro", crie um quadro com um título que identifique a execução. Copie o link direto do quadro.
2. No perfil B, registre outro usuário, abra o link copiado e clique em "Solicitar acesso". A página mostra o pedido pendente sem carregar o Canvas.
3. Volte ao perfil A e recarregue o link. Em "Pedidos de acesso", clique em "Aceitar pedido de ...".
4. Para provar que o criador não tem privilégio especial, abra o link no perfil C, registre outra conta e solicite acesso. Recarregue o quadro no perfil B e aceite o pedido como membro atual.
5. Abra ou recarregue o mesmo link nos perfis B e C. Espere o painel mostrar uma conexão P2P e o "Canal de diagnóstico ativo" antes de começar a comparação.

O catálogo mantém o título e o link visíveis para usuários conectados. Só membros recebem o conteúdo do Canvas e podem entrar nos canais do quadro.

## Mostrar P2P antes da persistência

Os botões do painel atuam na sessão do navegador onde foram clicados. Para deixar a VPS atrás, clique em "Pausar VPS" em cada perfil participante. Não pause P2P. Espere cada painel informar "Conexão VPS: pausada neste navegador" e confirme que os perfis ainda mostram pares P2P conectados.

No perfil A, crie um retângulo ou texto no Canvas. O perfil B deve receber a edição pelo P2P enquanto a prévia "VPS persistida" continua no estado anterior. No perfil B, encontre a linha do update em "Estado das ações": "Recebido P2P" deve dizer "Sim", "VPS durável" deve continuar como "—" e o estado deve dizer "Pendente na VPS". A timeline registra a edição e a chegada P2P, com ID, tamanho, sequência e horário observados nesta réplica.

Clique em "Retomar VPS" no perfil A. A edição deve chegar ao servidor e a prévia da VPS deve avançar. A linha correspondente passa a mostrar recebimento do servidor e persistência durável. A timeline recebe "VPS recebeu update" e "VPS confirmou persistência". O diagnóstico atualiza a prévia da VPS em intervalos aproximados de um segundo.

"Pausar P2P" é outro controle. Ele desconecta somente o canal direto daquele perfil. Com VPS ativa, edições ainda podem seguir pelo servidor. Para uma partição total, pause VPS e P2P nos perfis A e B antes de editar.

## Mostrar uma chegada atrasada

Use um quadro de teste separado ou crie um novo quadro para não confundir o estado durável anterior com a edição desta etapa.

1. Conecte A e B por P2P e pause a sincronização VPS em ambos.
2. Edite em A e espere B receber pelo P2P. Confirme que a prévia VPS não contém a edição.
3. Feche os dois quadros ou encerre os dois navegadores. Não limpe os dados dos perfis: o estado local usa IndexedDB.
4. Abra o link no perfil C enquanto A e B continuam fechados. C deve reconstruir o estado durável anterior, sem a edição que ainda não chegou à VPS.
5. Reabra A com o mesmo perfil. A nova sessão conecta à VPS automaticamente e reconcilia o documento local do IndexedDB. C deve receber a edição depois que o servidor a persistir. A timeline de cada perfil registra sua própria ordem de chegada.

Não compare relógios de máquinas diferentes como se fossem uma ordem global. A sequência e o horário da timeline pertencem à réplica indicada em cada linha.

## Testar imagens

Com o quadro aberto e conectado, use "Adicionar imagem" para escolher PNG, JPEG, GIF ou WebP. O navegador envia os bytes ao servidor e publica no documento compartilhado uma referência com posição e tamanho. Os outros membros devem ver a imagem sem receber base64 dentro do Y.Doc.

Para colar uma imagem, copie uma imagem para a área de transferência do sistema e use Ctrl+V enquanto o quadro estiver aberto. O botão "Inserir modelo FSM" carrega a imagem de referência incluída no projeto. A galeria "Galeria de diagramas" e o seletor "Modelo rápido" permitem acrescentar outros arquivos existentes de `whiteboard/templates/` sem substituir o conteúdo atual.

Para verificar a fila offline, use as ferramentas de rede do navegador para ficar realmente sem rede, então escolha um arquivo de imagem. A imagem pendente aparece localmente e permanece no perfil após fechar e reabrir o quadro. Ao voltar a rede, o cliente envia o arquivo antes de publicar a referência que os outros membros podem buscar. O botão "Pausar VPS" não testa essa fila: ele pausa o WebSocket de sincronização, mas o upload HTTP continua disponível.

No quadro, "Baixar PNG" exporta uma imagem para este dispositivo. "Salvar imagem para análise" envia um PNG renderizado do conteúdo compartilhado e grava uma imagem manual para aquele quadro. Esse botão não chama um modelo de IA. Para consultar anotações existentes, abra "Fórmulas & FSM", selecione a aba "Feedback" e clique em "Atualizar feedback"; sem notas fornecidas, a aba informa que não há anotações.

## Revogar acesso

Com três membros no quadro, abra "Membros" em um perfil e clique em "Revogar acesso" ao lado de outra pessoa. Qualquer membro pode revogar outro, inclusive quem criou o quadro. Quem foi removido perde acesso futuro ao conteúdo e não pode abrir novas conexões de colaboração. A cópia que já está carregada no Canvas ou em IndexedDB não é apagada pela revogação; recarregue o link direto no perfil removido para confirmar que a página oferece um pedido de acesso e não carrega o Canvas. O link e o título ainda podem aparecer no catálogo.

Revogação impede acesso futuro e fecha conexões honestas quando elas recebem a mudança de epoch. Ela não apaga conteúdo já copiado para fora do serviço nem a cópia local que permanece até o usuário recarregar ou limpar os dados do perfil.

## Ver a timeline e o canal diagnóstico

O painel tem quatro sinais distintos: estado local, conexão VPS, número de pares P2P e estado do canal diagnóstico. A tabela "Estado das ações" mostra evidência por update. A timeline mostra eventos observados nesta réplica, não um relógio global.

O WebSocket diagnóstico é separado da sincronização do quadro. Se ele cair, o painel informa "Canal de diagnóstico desconectado" ou "indisponível". Prévias de outras réplicas e eventos recebidos pelo diagnóstico deixam de atualizar até a reconexão. O status da conexão de sincronização pode continuar ativo; use a linha "VPS durável" para confirmar persistência. Uma prévia ou conexão ativa, isoladamente, não é confirmação durável.

## Reproduzir conflitos concorrentes

O Canvas atual permite criar e mover formas pela interface. Para reproduzir alterações concorrentes à mesma propriedade, duas movimentações do mesmo objeto e remoção contra edição com IDs e estado final verificados, rode o teste browser focado:

```sh
timeout 120s node --test test/multiclient-recovery.browser.test.js
```

O teste abre perfis Chromium separados, pausa os caminhos P2P e servidor nos dois clientes, aplica operações controladas ao modelo e compara as duas réplicas e a reconstrução durável. Ele cobre mover versus alterar cor, duas movimentações do mesmo objeto e exclusão versus alteração. É um teste automatizado com fixture, não uma gravação manual feita pelos controles do Canvas.

## Resultados e itens que faltam

Preencha esta seção depois da integração das tarefas 7.3 e 7.4 e de executar as comparações. Não estime os valores. Registre a versão do código, browser/perfis usados, sequência de ações, estado de cada réplica antes e depois da reconexão, contagem de updates, bytes por caminho e tempo de convergência. Anexe a saída exportada pela ferramenta de comparação quando a tarefa 7.4 entregar o comando.

| Execução | Caminho | Updates | Bytes | Convergência | Observação |
| --- | --- | ---: | ---: | ---: | --- |
| A completar | Híbrido, P2P e VPS | A medir | A medir | A medir | A completar |
| A completar | Somente servidor | A medir | A medir | A medir | A completar |

A seção de histórico também depende da 7.3. Depois da integração, acrescente o limite de retenção usado, os checkpoints comparados, o diff visível e o resultado de late join após expiração de entradas antigas. A poda não pode impedir a reconstrução do estado durável mais recente.

Limitações conhecidas para interpretar o resultado:

- A timeline local preserva a sequência e o relógio de cada réplica. Ela não estabelece uma ordem total entre relógios diferentes.
- O preview de peers é uma projeção diagnóstica efêmera. O preview VPS vem do documento reconstruído no servidor e atualiza por polling.
- Se P2P falhar por causa da rede, a sincronização pelo servidor ainda pode continuar; cursores e previews em tempo real não passam pela VPS.
- Dados offline de quadro e imagens pendentes permanecem no perfil do navegador que os criou até reconexão e upload.
- Notas exibidas na aba "Feedback" são notas fornecidas para o quadro. O fluxo não executa inferência de IA.
