# Validação

## Referências de escrita

Lidos integralmente os READMEs locais de project1-2026b-arthurmfroes e project2-2026b-arthurmfroes. O texto preserva a proposta já escrita para este projeto e usa relato pessoal, descrição das escolhas e comentários sobre os trechos, como nos trabalhos anteriores. Não foram copiados fatos de infraestrutura dos projetos 1 e 2 como se pertencessem ao projeto 3.

## Conferências

- Seis recortes JavaScript dos três destaques comparados com os arquivos locais: conexão em src/client/board-session.js, conciliação no y-protocols/sync.js instalado e src/client/room-persistence.js, sorteio e eleição em src/client/room-persistence.js. Nenhum algoritmo de merge foi atribuído ao código autoral quando pertence ao Yjs.
- Acesso público confirmado por GET https://project3-2026b-arthurmfroes.onrender.com/health, HTTP 200 e corpo {"status":"ok"}, em 26/10/2026. Isso confirma o serviço ativo, não todos os fluxos em produção.
- Removidas as instruções do modelo e a imagem externa de exemplo. Links relativos conferidos com os arquivos existentes; fences Markdown fechadas.
- Revisão com unslop, sem prometer eleição global, capacidade linear ou persistência durável no disco do Render gratuito. Liderança do envio foi separada da conciliação do documento.

## Demonstração

Captura da aplicação real em dois contextos isolados de Chromium, com fixture de contas e banco temporário. O processo de captura usou a worktree do projeto, comando de fixture Node, PID 152028, URL http://127.0.0.1:46339 e banco em /tmp/room-persistence-2GWgFa. O bundle foi gerado em /tmp, sem alterar os arquivos de produto. Somente o intervalo da coleta de diagnóstico foi reduzido para um segundo na fixture.

A sessão Playwright CLI codex-readme-demo abriu dois perfis com usuários de demonstração. Foram feitos quatro elementos por gestos de mouse, com uma conexão WebRTC confirmada e quatro elementos no documento observado. Não houve pageerror. Sete capturas mostram o desenho e a consulta de eleições e persistência.

FFmpeg converteu as capturas em docs/demo-quadro.gif. FFprobe confirmou 1100 × 700 pixels, sete frames e 14 segundos; arquivo de aproximadamente 95 KiB. Frames do desenho e dos candidatos foram conferidos visualmente. A animação é uma sequência de capturas, não uma medição de desempenho nem uma gravação de conflitos concorrentes.

A sessão de captura foi fechada e o processo da fixture encerrado. O dashboard compartilhado foi iniciado nesta worktree com `npx --no-install playwright cli show --port 9323 --host 127.0.0.1`, PID 154044, em http://localhost:9323; inicialização confirmada pelo log, porta e resposta HTTP 302. Ele foi deixado rodando. Nenhum quadro real ou conta pública foi alterado. Não foram executados testes de regressão porque esta mudança altera somente documentação e mídia. Sem commit ou push, conforme solicitado.
