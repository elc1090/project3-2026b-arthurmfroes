# Binding entre Canvas e modelo Yjs

`src/public/board-canvas.js` conecta um `HTMLCanvasElement` a um `Y.Doc` de um
quadro. O módulo aceita `getTool`, `getStyle`, `idFactory` e `drawElement` como
adapters; ferramentas adicionais podem reutilizar o listener e a leitura de
`readBoardElements` sem criar um segundo caminho de sincronização.

No binding atual, arrastar com **Retângulo** cria um elemento com ID estável e
geometria `{ x, y, width, height }`. Com **Selecionar / mover**, pointer down
escolhe o retângulo de maior ordem visual sob o cursor; pointer up grava uma
geometria completa com o deslocamento final. Cada gesto concluído usa uma
transação Yjs com origem `CANVAS_ORIGIN`. Movimentos intermediários não são
persistidos.

O listener de `afterTransaction` redesenha uma vez por transação, lendo o estado
visível do modelo. O desenho não escreve no documento. Portanto, um update
remoto também causa um redraw, mas não vira uma edição local nem ganha a origem
`CANVAS_ORIGIN`. `destroy()` remove listener e eventos do Canvas. O desenho
atual reconhece retângulos; outros tipos continuam no modelo para renderização
por adapters futuros.

## Bundle local

Yjs é empacotado para o navegador com a versão direta e fixada de esbuild. O
bundle é gerado localmente e ignorado pelo Git:

```sh
npm ci
npm run build:client
npm start
```

`npm start` executa `prestart`, que roda `build:client` automaticamente. O
comando explícito permite validar ou regenerar o bundle sem iniciar o servidor.
