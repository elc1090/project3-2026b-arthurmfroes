const demo = {"password":"estudo123","plainHash":"7e54791f48323a28a9c3a05ece5bb9054487c0b0b3a377b5869753b9e55f9b13","hashes":["$argon2id$v=19$m=19456,t=2,p=1$MfgU3m0ZDY0l2Y1sJvYNAw$VYfYs/sn1fWr9c9pMfueF+XnRS6Bk5yk3PiQ/t+kbbA","$argon2id$v=19$m=19456,t=2,p=1$R+lxu3XxAdImY9xWqVWDJQ$T5GhoFnADZ343el2oiPaXf5zOh2E7H6MjLSYdYF2n44"],"token":"k8rhx1dXKYPgZhuOBhd7VGfz0N6QEB1W7zgOeY-03Gk","tokenBytes":"93cae1c757572983e0661b8e06177b5467f3d0de90101d56ef380e798fb4dc69","tokenHash":"b39d63bb23733ecf803e77915ebb0f38c6bc914b0208af6d3805afcacb703ea4","frameHex":"00 02 ad 01 01 08 a1 c8 02 00 27 01 08 65 6c 65 6d 65 6e 74 73 07 72 65 63 74 2d 31 37 01 28 00 a1 c8 02 00 04 74 79 70 65 01 77 04 72 65 63 74 28 00 a1 c8 02 00 08 67 65 6f 6d 65 74 72 79 01 76 04 01 78 7d b8 01 01 79 7d 90 01 05 77 69 64 74 68 7d a0 02 06 68 65 69 67 68 74 7d 9a 01 28 00 a1 c8 02 00 07 64 65 6c 65 74 65 64 01 79 27 00 a1 c8 02 00 05 73 74 79 6c 65 01 28 00 a1 c8 02 04 05 63 6f 6c 6f 72 01 77 07 23 36 39 36 35 64 62 27 00 a1 c8 02 00 04 64 61 74 61 01 08 01 05 6f 72 64 65 72 01 77 07 72 65 63 74 2d 31 37 00","updateBytes":173,"frameBytes":177,"element":{"id":"rect-17","type":"rect","geometry":{"x":120,"y":80,"width":160,"height":90},"style":{"color":"#6965db"},"data":{}}};
const $ = (selector) => document.querySelector(selector);
const paths = {
  server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  browser: '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="M2 8h20M6 5.5h.01M9 5.5h.01M7 13h10M7 17h6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  file: '<path d="M13 2H5v20h14V8zM13 2v6h6M8 13h8M8 17h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="M3 17l6-6 5 5 3-3 4 4"/>',
  cookie: '<path d="M20.5 12.5a7 7 0 0 1-9-9A9 9 0 1 0 20.5 12.5zM8 9h.01M7 15h.01M13 16h.01M11 12h.01"/>',
};
const icon = (name) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const avatar = (name, color = '') => `<span class="avatar ${color}">${name[0]}</span>`;
const badge = (text, color = '') => `<span class="badge ${color}">${text}</span>`;
const arrow = (text, reverse = false) => `<div class="flow-arrow ${reverse ? 'reverse' : ''}"><svg viewBox="0 0 80 25" aria-hidden="true"><path d="M4 12h66m-8-7 9 7-9 7"/></svg><span>${text}</span></div>`;
const field = (label, value, color = '') => `<div class="field ${color}">${label ? `<small>${label}</small>` : ''}${value}</div>`;
const node = (name, content, { symbol = 'server', tone = '', description = '' } = {}) => `<div class="node ${tone}"><div class="node-label">${icon(symbol)}<h3>${name}</h3></div>${content}${description ? `<p class="description">${description}</p>` : ''}</div>`;
const windowCard = (name, { color = '', shape = '', empty = false, caption = '', large = false } = {}) => `<div class="browser"><div class="browser-top"><i></i><i></i><i></i><span>${avatar(name, color)}${name}</span></div><div class="mini-board ${large ? 'large' : ''}">${empty ? '' : `<div class="rectangle ${shape}"></div>`}<span class="board-tag">Y.Doc</span></div>${caption ? `<div class="board-caption">${caption}</div>` : ''}</div>`;
const takeaway = () => '';
const heading = (topic, title, subtitle) => `<div class="slide-heading"><p class="eyebrow">${topic}</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>`;

const slides = [
  {
    id: 'autenticacao', name: 'Senha e salt', seconds: 50, steps: 3,
    notes: '50 segundos. Comece comparando duas pessoas com a mesma senha. Um hash sem salt fica igual e permite reaproveitar tabelas de tentativas. No app, cada hash Argon2id recebe um salt aleatório novo. Ele não precisa ser secreto e fica junto do hash. Senhas iguais então têm resultados diferentes. No login, argon2.verify recupera esse mesmo salt do registro e não gera outro. Salt não é criptografia nem substitui um algoritmo de senha custoso: o Argon2id também exige memória e tempo. O exemplo usa hashes realmente calculados com uma senha fictícia; não são credenciais do sistema.',
    render(step) {
      const parts = demo.hashes[0].split('$');
      const rows = ['Ana', 'Bia'].map((name, i) => {
        const encoded = demo.hashes[i].split('$');
        return `<div class="salt-row"><div class="person-name">${avatar(name, i ? 'blue' : '')}<strong>${name}</strong></div><code class="password-sample">${demo.password}</code><div>${step ? `<code class="salt-value">${encoded[4].slice(0,12)}…</code>` : badge('sem salt', 'red')}</div><code class="hash-sample ${step ? i ? 'hash-blue' : 'hash-purple' : 'hash-equal'}">${(step ? encoded[5] : demo.plainHash).slice(0,18)}…</code></div>`;
      }).join('');
      const breakdown = step === 2 ? `<div class="hash-envelope"><div class="protocol-caption">O que fica salvo em <code>accounts.password_hash</code> · exemplo fictício</div><div class="encoded-hash"><span class="part-alg">$argon2id</span><span class="part-config">$v=19$m=19456,t=2,p=1</span><span class="part-salt">$${parts[4]}</span><span class="part-result">$${parts[5]}</span></div><div class="hash-parts"><div><i class="swatch-dot part-alg"></i><strong>Algoritmo</strong><span>Argon2id</span></div><div><i class="swatch-dot part-config"></i><strong>Custo</strong><span>memória e repetições</span></div><div><i class="swatch-dot part-salt"></i><strong>Salt</strong><span>aleatório, armazenado aqui</span></div><div><i class="swatch-dot part-result"></i><strong>Hash</strong><span>resultado da transformação</span></div></div><div class="salt-return"><span>${icon('database')}Registro salvo no cadastro</span><b>→</b><span>${icon('server')}Login lê o mesmo salt</span><b>→</b><span>${icon('check')}Argon2id verifica a senha</span></div><p class="salt-return-note">Não sorteia outro salt no login. O salt salvo permite verificar a senha novamente.</p></div>` : `<div class="salt-table"><div class="salt-row salt-head"><span>Pessoa</span><span>Mesma senha fictícia</span><span>${step ? 'Salt diferente' : 'Sem aleatoriedade'}</span><span>${step ? 'Hashes diferentes' : 'Mesmo hash'}</span></div>${rows}</div><div class="salt-explainer"><div class="salt-formula">${step ? '<span>senha</span><b>+</b><span class="salt-piece">salt aleatório</span><b>→</b><span>Argon2id</span><b>→</b><span class="hash-piece">hash diferente</span>' : '<span>senha</span><b>→</b><span>hash simples</span><b>→</b><span class="equal-piece">resultado igual</span>'}</div><p>${step ? 'Um novo valor aleatório para cada senha salva. O salt pode ser público.' : 'Hashes iguais denunciam senhas iguais e permitem reaproveitar tabelas de tentativas.'}</p></div>`;
      return heading('01 · Autenticação', ['Hash de senha <em>sem salt</em>', 'Hash de senha <em>com salt</em>', 'Armazenamento <em>do salt e do hash</em>'][step], ['Sem salt, duas pessoas com a mesma senha produzem o mesmo resultado.', 'Salt é um valor aleatório usado junto da senha antes de gerar o hash.', 'É possível ler os campos do registro. Isso não recupera a senha.'][step]) + `<div class="scene detail-scene">${breakdown}<div class="info-strip">${icon(step ? 'lock' : 'file')}<span>${step === 2 ? 'No login, argon2.verify recupera o salt e os parâmetros do registro salvo e verifica a senha digitada.' : step ? 'É assim que o app armazena senhas: Argon2id com salt, não um hash simples.' : 'Comparação didática. No app usamos Argon2id com salt desde o cadastro.'}</span></div></div>` + takeaway(step === 2 ? '<strong>Salt dificulta reaproveitar tentativas.</strong> Argon2id torna cada tentativa mais custosa.' : step ? '<strong>Mesma senha + salts diferentes → hashes diferentes.</strong>' : 'Guardar só um hash simples <strong>não é suficiente para proteger senhas.</strong>');
    },
  },
  {
    id: 'sessao', name: 'Cookie e sessão', seconds: 50, steps: 2,
    notes: '50 segundos. Após verificar a senha, o servidor cria 32 bytes aleatórios e os representa em base64url. O cookie é uma embalagem com nome, valor e regras. Não é JWT: o token não contém usuário ou permissões. Mesmo decodificando base64url, só aparecem bytes aleatórios. O navegador conserva o cookie e o envia automaticamente. O backend aplica SHA-256 ao texto do token e consulta sessions; account_id e validade ficam no banco. HttpOnly bloqueia leitura por JS, Secure exige HTTPS, SameSite Lax restringe uso entre sites e Max-Age é de sete dias.',
    render(step) {
      const raw = `<div class="protocol-caption">Resposta do login por HTTPS · valores fictícios</div><div class="cookie-envelope"><div class="envelope-label">Set-Cookie</div><code><span class="cookie-name">whiteboard_session</span>=<span class="cookie-token">${demo.token}</span></code></div>`;
      let body;
      if (step === 0) {
        body = `${raw}<div class="cookie-trip"><div>${icon('server')}<strong>Servidor</strong><span>senha verificada → cria o token</span></div><div class="cookie-travel"><span class="travelling-cookie">${icon('cookie')} cookie</span><div class="transport-track"></div></div><div>${icon('browser')}<strong>Navegador</strong><span>guarda no gerenciador de cookies</span></div></div><div class="info-strip">${icon('cookie')}<span>O navegador guarda o token no cookie e o envia automaticamente nas próximas requisições.</span></div>`;
      } else {
        body = `<div class="session-journey"><div class="journey-card"><span class="journey-number">1</span><div class="record-heading">${icon('cookie')}<strong>Cookie recebido</strong></div><span class="journey-label">Token original</span><code class="journey-key key-token">${demo.token.slice(0,19)}…</code><p>Um identificador aleatório.<br>Não contém o nome da Ana.</p></div><div class="journey-card"><span class="journey-number">2</span><div class="record-heading">${icon('server')}<strong>Servidor calcula</strong></div><span class="journey-label">SHA-256 do token</span><code class="journey-key key-hash">${demo.tokenHash.slice(0,18)}…</code><p>O mesmo token sempre<br>produz este mesmo hash.</p></div><div class="journey-card session-db-highlight" tabindex="0" aria-describedby="session-hash-tip"><span class="session-hash-tooltip" id="session-hash-tip" role="tooltip">Só o hash fica guardado no banco.</span><span class="journey-number">3</span><div class="record-heading">${icon('database')}<strong>sessions</strong></div><span class="journey-label">id = SHA-256 do token</span><code class="journey-key key-hash">${demo.tokenHash.slice(0,18)}…</code><div class="join-field"><code>account_id</code><strong>7d28…40d6</strong></div><small>Também verifica a validade.</small></div><div class="journey-card"><span class="journey-number">4</span><div class="record-heading">${icon('database')}<strong>accounts</strong></div><span class="journey-label">Liga pelo id da conta</span><code class="journey-key key-account">7d28…40d6</code><div class="join-field"><code>username</code><strong class="journey-user">Ana</strong></div><small>Usuária identificada.</small></div></div>`;
      }
      return heading('02 · Cookie e sessão', ['Armazenamento <em>do token no cookie</em>', 'Consulta <em>da sessão no banco</em>'][step], ['Após o login, o servidor cria um token aleatório e o envia em um cookie.', 'O servidor calcula o hash do token e consulta a sessão para identificar o usuário.'][step]) + `<div class="scene detail-scene ${step === 0 ? 'cookie-storage-scene' : ''}">${body}</div>` + takeaway(step === 1 ? 'O banco armazena <strong>o hash do token, a conta e a validade da sessão.</strong>' : 'O navegador envia o cookie nas requisições seguintes, <strong>sem reenviar a senha.</strong>');
    },
  },
  {
    id: 'mensagens', name: 'Mensagem P2P', seconds: 50, steps: 2,
    notes: '50 segundos. A mensagem ilustrada foi gerada com Yjs de verdade para um retângulo fictício. O frame é binário, apresentado em hexadecimal. No y-webrtc, 0 identifica sincronização, 2 identifica update e o comprimento delimita os bytes do update. O corpo tem estruturas internas do CRDT, incluindo IDs e clocks lógicos. Os campos legíveis são uma projeção do documento após aplicar o update, não JSON trafegando pelo WebRTC. A sinalização ajuda a estabelecer a conexão; o frame percorre o canal de dados. Ao receber, Bia aplica o update no Y.Doc e redesenha.',
    render(stage) {
      const step = stage === 0 ? 0 : 2;
      const readable = `<div class="frame-segments"><div class="frame-tag part-alg"><b>0</b><span>sincronização</span></div><div class="frame-tag part-salt"><b>2</b><span>update</span></div><div class="frame-tag part-config"><b>${demo.updateBytes} B</b><span>corpo da mensagem</span></div><div class="frame-tag part-result"><b>Yjs</b><span>estruturas, IDs e clocks</span></div></div><div class="decoded-update"><h3>O que esse update representa</h3><div class="decoded-fields"><div><span>Elemento <code>id</code></span><strong>rect-17</strong></div><div><span>Tipo <code>type</code></span><strong>Retângulo</strong></div><div><span>Posição e tamanho</span><strong>x 120 · y 80</strong><small>160 × 90</small></div><div><span>Cor <code>style.color</code></span><strong><i class="decoded-color"></i>#6965db</strong></div></div></div>`;
      return heading('03 · Troca de mensagens', ['Codificação binária <em>do update Yjs</em>', 'Estrutura <em>da mensagem Yjs</em>', 'Envio e aplicação <em>do update</em>'][step], ['Exemplo real de codificação, gerado com dados fictícios. Aqui os bytes estão em hexadecimal.', 'O envelope identifica o protocolo. O corpo descreve as mudanças do documento.', 'O peer recebe o frame, aplica o update ao Y.Doc e renderiza o elemento.'][step]) + `<div class="scene detail-scene message-scene"><div class="signaling-caption">${icon('server')}Sinalização aproxima os peers. O canal de dados abaixo é WebRTC.</div><div class="wire-flow"><div class="wire-peer">${windowCard('Ana', {shape: 'violet', caption: badge('criou rect-17', 'blue')})}</div><div class="wire-route"><div class="wire-route-name">P2P · canal de dados</div><div class="transport-track"><span class="packet-capsule ${step === 2 ? 'in-flight' : ''}">${icon('file')}update · ${demo.frameBytes} B</span><span class="track-arrow">›</span></div><p>${step === 2 ? 'receber → aplicar → desenhar' : 'uma mensagem com a alteração'}</p>${step === 2 ? '<button class="replay" data-replay type="button">Repetir envio</button>' : ''}</div><div class="wire-peer ${step === 2 ? 'received-peer' : ''}">${windowCard('Bia', {color: 'blue', shape: 'violet', empty: step !== 2, caption: badge(step === 2 ? 'update recebido' : 'ainda sem rect-17', step === 2 ? 'green' : 'neutral')})}</div></div><div class="payload-box"><div class="payload-heading"><strong>${step ? 'Frame separado em partes' : 'Frame completo · representação hexadecimal'}</strong><span>${demo.frameBytes} bytes neste exemplo</span></div>${step ? readable : `<code class="frame-bytes">${demo.frameHex}</code>`}</div></div>` + takeaway(step === 2 ? '<strong>Aplicar o update concilia o documento.</strong> A confirmação de persistência vem depois.' : step ? '<strong>O corpo é binário.</strong> Os campos acima mostram como o documento é interpretado.' : '<strong>A imagem do Canvas não vai na mensagem.</strong> Viaja o update do documento.');
    },
  },
  {
    id: 'imagens', name: 'Imagens', seconds: 30, steps: 2,
    notes: '30 segundos. Quem insere a imagem faz o upload por HTTP. O servidor grava o arquivo e os metadados. Os participantes recebem a referência pelo documento e solicitam o arquivo diretamente ao servidor, com verificação de acesso, para renderizar no Canvas. Os bytes da imagem não vêm de outro peer.',
    render(step) {
      const thumb = `<svg class="image-thumb" viewBox="0 0 210 95" aria-label="Diagrama de exemplo"><rect x="12" y="21" width="60" height="48" rx="4" fill="#f0edff"/><path d="M72 45h53m-9-6 10 6-10 6"/><rect x="127" y="21" width="70" height="48" rx="4" fill="#e7f5ff"/><text x="42" y="51" text-anchor="middle">REG</text><text x="162" y="51" text-anchor="middle">ULA</text></svg>`;
      const flow = step === 0
        ? `${node('Ana envia a imagem',thumb+field('Arquivo','circuito.png','purple'),{symbol:'browser'})}${arrow('upload · HTTP')}${node('Servidor recebe',field('Upload autenticado','verifica o acesso ao quadro','green'),{symbol:'server',tone:'active'})}${arrow('grava')}${node('Imagem armazenada',field('Disco','arquivo da imagem','blue')+field('SQLite','registro do arquivo','purple'),{symbol:'database'})}`
        : `${node('Participante solicita',field('Imagem do quadro','referência recebida no documento','purple'),{symbol:'browser'})}${arrow('solicita ao servidor')}${node('Servidor entrega',thumb+badge('acesso verificado','green'),{symbol:'server'})}${arrow('download · HTTP')}${node('Navegador renderiza',thumb+badge('imagem no Canvas','green'),{symbol:'browser',tone:'green'})}`;
      return heading('04 · Imagens',step === 0 ? 'Upload e armazenamento <em>da imagem</em>' : 'Download e renderização <em>da imagem</em>',step === 0 ? 'Quem insere a imagem envia o arquivo diretamente ao servidor.' : 'Cada participante baixa a imagem do servidor e desenha no Canvas.') + `<div class="scene detail-scene image-scene"><div class="flow image-flow">${flow}</div></div>` + takeaway(step === 0 ? '<strong>O servidor guarda o arquivo da imagem.</strong>' : '<strong>A imagem vem do servidor.</strong> O P2P compartilha a referência no quadro.');
    },
  },
  {
    id: 'persistencia', name: 'Armazenamento', seconds: 50, steps: 3,
    notes: '50 segundos. Para reduzir envios repetidos, os peers anunciam uma prioridade aleatória. Neste exemplo Bia tem o menor número e envia o lote. São números ilustrativos; o sorteio real usa 32 bits e renova o mandato a cada 30 segundos. O estado do board fica em updates Yjs binários no SQLite, com checkpoints para reconstrução. Imagens ficam como arquivos separados; o documento guarda assetId, posição e tamanho. Só depois do COMMIT o servidor emite o recibo assinado. Os outros peers verificam assinatura e cobertura. Falha permite outro remetente; isolamento permite recuperação direta. O disco do Render Free é temporário, então esse COMMIT não garante sobreviver a um reset da plataforma.',
    render(step) {
      const candidate = (name, number, color, winner) => `<div class="candidate ${winner ? 'winner' : ''}">${avatar(name, color)}<div class="name">${name}</div><div class="number">${number}</div>${badge(step === 2 ? 'verifica o ACK' : winner ? 'representante' : 'peer', step === 2 ? 'green' : winner ? '' : 'neutral')}</div>`;
      return heading('05 · Armazenamento', step === 2 ? 'Confirmação <em>de persistência</em>' : 'Eleição e envio <em>do lote</em>', step === 0 ? 'Exemplo de sorteio: o menor número escolhe quem envia o lote.' : step === 1 ? 'O lote carrega updates Yjs. O SQLite registra esses bytes em uma transação.' : 'O recibo assinado volta ao remetente e é compartilhado com os peers.') + `<div class="scene"><div class="persist-layout"><div><div class="candidates">${candidate('Ana', '42', '', false)}${candidate('Bia', '7', 'blue', true)}${candidate('Caio', '93', 'green', false)}</div><div class="persist-path"><svg viewBox="0 0 28 35" aria-hidden="true"><path d="M14 2v27m-7-7 7 8 7-8"/></svg><p>${step ? 'Bia reúne as alterações que chegaram pelo P2P' : 'mesma regra de escolha em cada peer'}</p></div><div class="batch ${step ? 'arrive' : 'faded'}">Um lote de alterações<small>id do lote + update binário</small></div></div><div><div class="database ${step ? '' : 'faded'}"><h3>${icon('database')}SQLite ${badge(step === 2 ? 'COMMIT concluído' : step === 1 ? 'gravando' : 'aguardando', step === 2 ? 'green' : step === 1 ? 'amber' : 'neutral')}</h3><div class="db-row"><code>board_updates</code><span>log de updates binários do quadro</span></div><div class="db-row"><code>board_checkpoints</code><span>estado compactado para reconstruir o quadro</span></div><div class="binary">01 7f 03 a2 00 8b …</div></div>${step === 2 ? `<div class="receipt-line arrive">${icon('check')}<span><strong>Confirmação de escrita</strong><br>distribuída aos peers: lote salvo no servidor</span></div>` : `<div class="receipt-line faded">${icon('check')}<span>ACK de persistência<br>liberado depois do COMMIT</span></div>`}</div></div></div>` + takeaway(step === 2 ? 'O ACK é evidência de persistência. <strong>Não basta ver o desenho na outra tela.</strong>' : step === 1 ? '<strong>Servidor guarda bytes Yjs.</strong> O quadro é reconstruído aplicando esses updates.' : '<strong>O sorteio organiza o envio.</strong> A conciliação do conteúdo continua no Yjs.');
    },
  },
  {
    id: 'conexoes', name: 'Conexões e conciliação', seconds: 55, steps: 4,
    notes: '55 segundos. Com tudo ativo, os peers trocam updates e o representante persiste lotes. Sem P2P, cada navegador usa envio e recuperação periódica por HTTP; a VPS permite que alcancem o estado comum, mas não é fanout instantâneo. Sem VPS, os peers já conectados continuam compartilhando e cada perfil conserva sua cópia no IndexedDB; faltam ACKs e novos participantes dependem da sinalização. Com ambos fora, cada usuário edita sua cópia e elas podem divergir. Clique Reconectar para ilustrar: na comunicação restabelecida o Yjs incorpora os updates que faltam, réplicas que recebem o mesmo conjunto convergem, e depois o servidor persiste. Se as cópias locais forem apagadas antes da recuperação, não há garantia de recuperar essas edições.',
    render(step) {
      const scenarios = [
        {title:'Sincronização <em>com P2P e VPS</em>',subtitle:'O P2P leva as mudanças. Um representante envia lotes e compartilha os recibos.',p2p:true,vps:true,exchange:'P2P entre os peers',durable:'ACK após COMMIT',local:'IndexedDB em cada perfil'},
        {title:'Sincronização <em>sem P2P</em>',subtitle:'Os navegadores enviam e recuperam diferenças por HTTP, em consultas periódicas.',p2p:false,vps:true,exchange:'HTTP · envio e recuperação',durable:'ACK após COMMIT',local:'IndexedDB em cada perfil'},
        {title:'Edição <em>sem VPS</em>',subtitle:'A edição chega ao outro navegador, mas ainda não existe confirmação do servidor.',p2p:true,vps:false,exchange:'P2P continua ativo',durable:'Pendente no servidor',local:'Cópias locais preservadas'},
        {title:'Edição <em>sem P2P e sem VPS</em>',subtitle:'As alterações ficam no navegador. Ainda não chegaram ao outro peer nem ao servidor.',p2p:false,vps:false,exchange:'Sem troca de mensagens',durable:'Pendente no servidor',local:'Mudanças no IndexedDB'},
      ];
      const recovered = step === 3 && networkRecovered;
      const state = recovered ? {...scenarios[0], title:'Conciliação <em>após reconectar</em>',subtitle:'Os peers recebem os updates que faltavam. Depois o servidor confirma a persistência.',exchange:'Yjs incorpora os updates',durable:'Lote persistido + ACK',local:'Mesmo conjunto de alterações'} : scenarios[step];
      const canvas = (rect,circle) => `<div class="scenario-canvas">${rect ? '<i class="scenario-rect"></i>' : ''}${circle ? '<i class="scenario-circle"></i>' : ''}</div>`;
      const peer = (name,color,isAna) => `<div class="topology-peer ${isAna ? 'topology-ana' : 'topology-bia'}"><div class="topology-name">${avatar(name,color)}<strong>${name}</strong><span>Y.Doc</span></div>${canvas(step !== 3 || recovered || isAna,step !== 3 || recovered || !isAna)}<div class="local-storage">${icon('database')} IndexedDB · cópia local</div></div>`;
      const marker = '<defs><marker id="topo-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1l7 4-7 4" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>';
      const line = (active,d,channel) => `<path d="${d}" class="topology-link ${active ? channel : 'link-off'}" marker-end="url(#topo-arrow)" marker-start="url(#topo-arrow)"/>`;
      return heading('06 · Falhas e conciliação',state.title,state.subtitle) + `<div class="scene detail-scene topology-scene"><div class="scenario-tabs" role="group" aria-label="Cenário de conexão">${['Tudo ativo','Sem P2P','Sem VPS','Ambos fora'].map((name,i)=>`<button type="button" data-scenario="${i}" aria-pressed="${step===i}">${name}</button>`).join('')}</div><div class="topology"><svg class="topology-lines" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">${marker}${line(state.p2p,'M265 55H735','p2p-link')}${line(state.vps,'M145 135L380 205','http-link')}${line(state.vps,'M855 135L620 205','http-link')}</svg>${peer('Ana','',true)}${peer('Bia','blue',false)}<div class="topology-p2p ${state.p2p?'':'channel-off'}">${badge(state.p2p?'P2P ativo':'P2P fora',state.p2p?'':'red')}${state.p2p ? '<span class="moving-dot"></span>' : ''}</div><div class="topology-http left">${badge(state.vps?'HTTP':'sem HTTP',state.vps?'blue':'neutral')}</div><div class="topology-http right">${badge(state.vps?'HTTP':'sem HTTP',state.vps?'blue':'neutral')}</div><div class="topology-server ${state.vps?'':'server-off'}"><div class="record-heading">${icon('server')}<strong>VPS + SQLite</strong>${badge(state.vps?'ativa':'fora',state.vps?'green':'red')}</div><div class="server-document">${state.vps ? `${icon('file')} quadro persistido` : `${icon('lock')} estado anterior`}</div></div></div><div class="scenario-status"><div><span>Troca entre cópias</span><strong>${state.exchange}</strong></div><div><span>Persistência na VPS</span><strong class="${state.vps?'state-green':'state-amber'}">${state.durable}</strong></div><div><span>No navegador</span><strong>${state.local}</strong></div></div>${step === 3 ? `<div class="reconnect-row"><span>${recovered?'Retângulo e círculo passam a aparecer nas duas cópias.':'Ana criou o retângulo; Bia criou o círculo. As cópias divergem.'}</span><button type="button" data-reconnect>${recovered?'Repetir a falha':'Reconectar e conciliar'} ${icon(recovered?'file':'check')}</button></div>` : `<p class="scenario-footnote">${step===2?'Vale para peers já conectados. Novas entradas ainda dependem de autenticação e sinalização.':step===1?'A recuperação por HTTP é periódica; a atualização pode levar alguns segundos.':'O recibo de um lote confirma apenas as alterações cobertas por ele.'}</p>`}</div>` + takeaway(recovered ? '<strong>Yjs concilia as alterações recebidas.</strong> O ACK confirma a gravação posterior.' : step===3 ? '<strong>Reconectar é o que permite conciliar.</strong> Sem comunicação, as cópias continuam separadas.' : step===2 ? '<strong>Compartilhado entre peers não significa persistido na VPS.</strong>' : step===1 ? '<strong>O P2P pode falhar sem impedir a recuperação via servidor.</strong>' : '<strong>Distribuição, conciliação e persistência são etapas distintas.</strong>');
    },
  },
];

let slideIndex = 0;
let step = 0;
let networkRecovered = false;
let notesOpen = false;
let timerRunning = false;
let remaining = 300000;
let timerStartedAt = 0;
let timerInterval = null;
const getHash = () => {
  const match = location.hash.match(/^#(\d+)(?:\/(\d+))?$/);
  const index = match ? Math.max(0, Math.min(slides.length - 1, Number(match[1]) - 1)) : 0;
  return [index, Math.max(0, Math.min(slides[index].steps - 1, Number(match?.[2] ?? 0)))];
};
function render({ writeHash = true } = {}) {
  const current = slides[slideIndex];
  $('#slide').innerHTML = current.render(step);
  $('#counter').textContent = `${String(slideIndex + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
  $('#section').textContent = current.name;
  $('#step-counter').textContent = `${step + 1}/${current.steps}`;
  $('#next').disabled = slideIndex === slides.length - 1 && step === current.steps - 1;
  $('#next').innerHTML = `${step < current.steps - 1 ? 'Próxima etapa' : slideIndex === slides.length - 1 ? 'Fim' : 'Próximo slide'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`;
  $('#previous').disabled = slideIndex === 0 && step === 0;
  const noteTitle = document.createElement('strong'); noteTitle.textContent = `${current.name} · ${current.seconds} s sugeridos`;
  const noteText = document.createElement('p'); noteText.textContent = current.notes;
  $('#notes').replaceChildren(noteTitle, noteText);
  $('#notes').hidden = !notesOpen;
  $('#slide-dots').replaceChildren(...slides.map((slide, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('aria-label', `${index + 1}. ${slide.name}`);
    button.title = `${slide.name} · ${slide.seconds} s`;
    if (index === slideIndex) button.setAttribute('aria-current', 'step');
    button.addEventListener('click', () => go(index, 0)); return button;
  }));
  $('#progress span').style.width = `${100 * (slides.slice(0, slideIndex).reduce((total, slide) => total + slide.steps, 0) + step + 1) / slides.reduce((total, slide) => total + slide.steps, 0)}%`;
  $('#announcement').textContent = `${current.name}, slide ${slideIndex + 1} de ${slides.length}, etapa ${step + 1} de ${current.steps}`;
  document.title = `${current.name} · Whiteboard T3`;
  if (writeHash) history.replaceState(null, '', `#${slideIndex + 1}/${step}`);
  for (const button of $('#slide').querySelectorAll('[data-scenario]')) button.addEventListener('click', () => {
    networkRecovered = false; go(slideIndex, Number(button.dataset.scenario));
    $('#slide').querySelector(`[data-scenario="${step}"]`).focus({preventScroll:true});
  });
  $('#slide').querySelector('[data-reconnect]')?.addEventListener('click', () => {
    networkRecovered = !networkRecovered; render();
    $('#slide').querySelector('[data-reconnect]')?.focus({preventScroll:true});
  });
  $('#slide').querySelector('[data-replay]')?.addEventListener('click', () => { render(); $('#slide').querySelector('[data-replay]')?.focus({preventScroll:true}); });
}
function go(index, stage) {
  networkRecovered = false;
  slideIndex = Math.max(0, Math.min(slides.length - 1, index));
  step = Math.max(0, Math.min(slides[slideIndex].steps - 1, stage));
  render(); window.scrollTo({top: 0, behavior: 'instant'});
}
function next() {
  if (step < slides[slideIndex].steps - 1) go(slideIndex, step + 1);
  else if (slideIndex < slides.length - 1) go(slideIndex + 1, 0);
}
function previous() {
  if (step > 0) go(slideIndex, step - 1);
  else if (slideIndex > 0) go(slideIndex - 1, slides[slideIndex - 1].steps - 1);
}
function toggleNotes() {
  notesOpen = !notesOpen; $('#notes').hidden = !notesOpen; $('#notes-toggle').setAttribute('aria-expanded', String(notesOpen));
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { $('#announcement').textContent = 'Use F11 no navegador para abrir a apresentação em tela cheia.'; }
}
function updateTimer() {
  const left = remaining - (timerRunning ? performance.now() - timerStartedAt : 0);
  const seconds = Math.ceil(Math.abs(left) / 1000);
  $('#timer span').textContent = `${left < 0 ? '+' : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('#timer').classList.toggle('running', timerRunning);
  $('#timer').classList.toggle('over', left < 0);
  $('#timer').setAttribute('aria-label', `${timerRunning ? 'Pausar' : 'Iniciar'} cronômetro de apresentação`);
}
function toggleTimer() {
  if (timerRunning) { remaining -= performance.now() - timerStartedAt; timerRunning = false; clearInterval(timerInterval); }
  else { timerRunning = true; timerStartedAt = performance.now(); timerInterval = setInterval(updateTimer, 250); }
  updateTimer();
}
$('#next').addEventListener('click', next);
$('#previous').addEventListener('click', previous);
$('#notes-toggle').addEventListener('click', toggleNotes);
$('#fullscreen').addEventListener('click', toggleFullscreen);
$('#timer').addEventListener('click', toggleTimer);
window.addEventListener('hashchange', () => { [slideIndex, step] = getHash(); render({writeHash: false}); });
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && event.target.closest('button, a')) return;
  if (['arrowright', 'arrowdown', 'pagedown', ' '].includes(key)) { event.preventDefault(); next(); }
  else if (['arrowleft', 'arrowup', 'pageup'].includes(key)) { event.preventDefault(); previous(); }
  else if (key === 'home') { event.preventDefault(); go(0, 0); }
  else if (key === 'end') { event.preventDefault(); go(slides.length - 1, slides.at(-1).steps - 1); }
  else if (key === 'n') { event.preventDefault(); toggleNotes(); }
  else if (key === 'f') { event.preventDefault(); void toggleFullscreen(); }
});
[slideIndex, step] = getHash();
render(); updateTimer();
