# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Alunos de Arquitetura de Computadores (UFSM) estudando em grupo: desenham datapath, FSM de controle multiciclo, MUX e ULA sobre diagramas de prova e conferem fórmulas e sinais de controle MIPS. Cada pessoa entra com a própria conta, num navegador próprio.

## Product Purpose

Um quadro de estudo MIPS colaborativo. O valor para quem usa é resolver exercícios de processador juntos no mesmo quadro, com a referência (sinais, fórmulas, diagramas da prova) a um clique. O projeto é o trabalho T3 da disciplina de Web e será demonstrado ao vivo.

## Positioning

O conteúdo de estudo vem do quadro original do Arthur (`whiteboard/`): ferramentas de MUX/ULA, galeria de diagramas de prova UFSM, tabelas de sinais de controle e fórmulas de desempenho. A versão T3 acrescenta contas, quadros separados por membros e sincronização local-first (Yjs, P2P via WebRTC, servidor como cópia durável). A sincronização é infraestrutura: a identidade do produto é o estudo de processador, não a engenharia de réplicas.

## Operating Context

- Demonstração ao vivo num projetor, com vários perfis de navegador lado a lado na mesma tela, para professor e turma. Texto, estado e contraste precisam se ler de longe e em janelas estreitas.
- Modos da barra lateral: Quadro (desenho), Estudo (galeria, sinais, fórmulas, questões, feedback) e Experimento (painel de réplicas, timeline, medições de sync, usado para mostrar a T3 à banca).
- Interface inteira em português.

## Capabilities and Constraints

- HTML/CSS/JS estático servido pelo Node em `src/public/`; estilos inline em `src/public/index.html`. Sem framework de UI.
- Canvas 2D com ferramentas: caneta, marca-texto, seta, linha, retângulo, MUX, ULA, texto, seleção, borracha, pan, zoom, cores e espessuras.
- Fluxos: entrar/criar conta, catálogo de quadros, pedido e aprovação de acesso, revogação, imagens (upload, colar, galeria), exportar PNG, salvar imagem para análise.
- Testes de browser em `test/*.browser.test.js` dependem de ids, textos e papéis acessíveis da página; redesign não pode quebrar esses contratos.
- Redesign feito direto no `main`, sem change OpenSpec (decisão do Arthur, 21/10/2026).

## Brand Commitments

- O nome "Whiteboard T3" não é obrigatório; pode ser trocado.
- Direção visual: o padrão da categoria, executado a sério. Referência de acabamento: Excalidraw (escolha do Arthur, 21/10/2026).

## Evidence on Hand

- Diagramas reais de prova e exercícios em `whiteboard/templates/`.
- Roteiro de demonstração em `docs/demo-t3.md`; amostras do experimento em `docs/evidence/`.
- Não há depoimentos, usuários externos nem métricas de uso; não inventar.

## Product Principles

1. O quadro e o material de estudo vêm primeiro; diagnóstico de sync fica no modo Experimento.
2. Tudo precisa ser legível num projetor, a alguns metros, com duas ou três janelas lado a lado.
3. O app fala a língua da disciplina: datapath, sinais, estados, ciclos.
4. Nenhuma função existente some no redesign.
