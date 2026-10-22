# Persistência por representante

A sessão do quadro elege um representante entre as candidaturas disponíveis no P2P. Cada candidatura tem uma prioridade aleatória, uma geração e um heartbeat. A menor prioridade vence; o ID desempata. O mandato renova a prioridade após 30 segundos. Falha de envio retira temporariamente o candidato e permite outro representante.

O representante envia diferenças Yjs em lotes a cada 1 segundo. A VPS responde somente após COMMIT no SQLite. O recibo Ed25519 inclui quadro, lote, instante e cobertura de estruturas e exclusões. Os peers recebem esse recibo via Awareness e verificam a assinatura com a chave obtida diretamente da VPS. Cada edição fica pendente até sua cobertura estar confirmada. O quadro e as edições offline permanecem no IndexedDB.

O bootstrap e a recuperação usam `POST /api/boards/:id/persistence` com `stateVector` em base64. Um envio acrescenta `batchId` e `update` em base64. A resposta traz `update`, `key` pública e `receipt`. `GET` faz bootstrap sem vetor. A API exige sessão e membership. Limites: corpo de 4 MiB, update de 3 MiB e vetor de 64 KiB. Mesma identidade e bytes são deduplicados em `persistence_batches`, inclusive após checkpoint ou retry por outro membro. Identidade reutilizada com outros bytes devolve 409.

Os padrões estão em `PERSISTENCE_DEFAULTS`, configuráveis por `openBoardSession(..., { persistenceTiming })`: lote de 1000 ms, ACK de 4000 ms, mandato de 30000 ms, expiração de candidato de 6000 ms, recuperação de 8000 ms e heartbeat de 250 ms. Os intervalos devem ser positivos. Uma edição sem confirmação por 8 segundos pode subir diretamente. Sem peers, o cliente também consulta a VPS periodicamente para receber alterações de outros clientes isolados.

`session.persistenceStatus` e o evento `persistence-status` expõem representante, papel, pendências, recuperação e pausa. O painel Estado das ações mostra o representante e a quantidade de pendências, além da evidência por update. Pausar VPS impede envio, recuperação e confirmação local via peers. Pausar P2P retira a candidatura compartilhada e mantém recuperação direta.

O endpoint WebSocket anterior continua disponível para clientes antigos. Escritas HTTP atualizam as réplicas WebSocket abertas. Na transição, clientes antigos continuam gerando fanout e cópias. Não há fanout de conteúdo da VPS entre clientes novos durante colaboração P2P normal.

Partições podem ter representantes distintos. O servidor continua recebendo toda a informação nova produzida pela sala, além de autenticação, sinalização e imagens. Não há promessa de ganho linear por número de participantes. Fechar todos os clientes antes do ACK pode deixar a VPS atrasada. A recuperação depende da reabertura de um perfil que tenha o estado local. A tabela de identidades de lotes é retida enquanto o quadro existir; seu crescimento deve entrar na medição de armazenamento.

Os contadores e as exportações JSON/CSV incluem o canal `http`, separado de `websocket` e `webrtc`. O servidor publica os eventos de recebimento e persistência do lote no diagnóstico; a confirmação por cobertura associa esse resultado aos updates originais em cada cliente.

As imagens mantêm o fluxo anterior. O cliente de origem envia o arquivo por HTTP e só publica o `assetId` no documento após o upload. O representante persiste essa referência no lote; os outros peers baixam o arquivo pela API autenticada. Imagens criadas offline ficam na fila local até o upload terminar. Os contadores HTTP novos medem o endpoint de persistência do documento, sem incluir os arquivos de imagem.
