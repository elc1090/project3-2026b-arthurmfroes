# Design

## Context

`server-sync-provider.js` enfileira qualquer update que não venha da VPS, inclusive os de peers. `board-sync.js` persiste e retransmite a todas as conexões. O modelo usa Yjs e IndexedDB por quadro; o ACK atual identifica bytes, não uma ação semântica.

## Goals / Non-Goals

**Goals:** um remetente por componente P2P estável, lotes incrementais e confirmação verificável de cobertura, sem bloquear edição nem recuperação.

**Non-Goals:** consenso global sob partição, garantia de 20 vezes mais usuários, mudanças no palco, compactação automática ou substituição do endpoint WebSocket legado.

## Decisions

- Novo transporte HTTP autenticado de bootstrap e persistência por lote. Os clientes novos não abrem WebSocket de conteúdo continuamente; mantém-se o WebSocket de sinalização. Isso evita o fanout de conteúdo da VPS durante colaboração normal. Acesso direto periódico recupera clientes sem P2P e membros atrasados.
- Awareness transporta apenas candidatura, prioridade aleatória, geração, heartbeat e último recibo. O conteúdo continua no documento Yjs. Não gravar eleição no documento durável.
- Padrões configuráveis: lote a cada 1 segundo, prazo HTTP de 4 segundos, mandato de 30 segundos, presença expira em 6 segundos e recuperação direta após 8 segundos sem cobertura. Prioridades e gerações renovam após mandato ou falha; candidatos falhos ficam temporariamente inelegíveis. Empate usa ID de cliente. Partições podem eleger representantes distintos.
- A VPS devolve um recibo Ed25519 após COMMIT com quadro, lote, instante e cobertura do documento persistido. A chave pública vem exclusivamente do bootstrap autenticado da VPS, nunca do peer. Cobertura inclui intervalos de estruturas e exclusões Yjs. Vetor de estado sozinho não cobre exclusões.
- Cada cliente conserva updates pendentes e só os confirma se todos os intervalos e exclusões constarem do recibo verificado. A edição feita durante o envio permanece pendente se estiver fora dessa cobertura. O status usa o digest do update original, não o digest do lote.
- Lotes possuem ID e digest. Uma tabela SQLite mantém recibos de deduplicação mesmo após checkpoint; mesma identidade com conteúdo diferente é rejeitada. Repetição por outro membro é permitida após autenticação. Conteúdo repetido com IDs diferentes permanece tolerável pelo Yjs.
- O cliente calcula diferenças contra o vetor de estruturas confirmado pelos recibos assinados. Exclusões continuam no update incremental e exigem cobertura explícita no ACK. Reenvio após falha mantém o lote; o vetor confirmado evita retransmitir estruturas já persistidas quando o representante muda.
- Os contadores e exportações incluem HTTP; os eventos de servidor identificam o lote, enquanto o recibo confirma a cobertura de cada update original.
- `pauseServerSync` suspende envio e recuperação locais e impede que recibos de peers produzam confirmação local enquanto pausado, preservando o controle de demonstração. `pausePeerSync` remove candidatura e força recuperação pela VPS. Revogação destrói a coordenação e impede novos envios.

## Risks / Trade-offs

- Persistência ganha atraso até a próxima rodada; IndexedDB conserva estado local até reconexão.
- ACK e assinatura podem crescer com o histórico de exclusões; respeitar limites de payload e falhar explicitamente, mantendo pendências.
- Abas suspensas podem perder o mandato; a expiração e recuperação direta favorecem continuidade, aceitando dois remetentes em transições.
- Não depender do fechamento da aba para salvar. Fechar antes da confirmação pode deixar a VPS atrasada.
- Chave de recibos muda a cada processo da VPS; bootstrap renova a chave após falha de verificação ou reconexão.

## Migration Plan

Aplicar migração aditiva para deduplicação e distribuir o novo bundle. Clientes antigos continuam no WebSocket e podem gerar cópias durante a transição. Reverter o cliente restaura o caminho anterior; a tabela adicional pode permanecer.
