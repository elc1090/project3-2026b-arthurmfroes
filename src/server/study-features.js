import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getAuthenticatedSession, readJsonBody } from './auth.js';
import { authorizeBoardMembership } from './boards.js';

export const MAX_STUDY_PNG_BYTES = 10 * 1024 * 1024;
const MAX_PNG_DIMENSION = 16_384;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CATEGORIES = [
  { prefix: 'prova', category: '🏆 Prova Real (UFSM)', files: [
    'prova_q1_add3.jpg', 'prova_q2_subabs.jpg', 'prova_q3_relu.jpg',
    'prova1_pag_1.jpg', 'prova1_pag_2.jpg', 'prova1_pag_3.jpg',
    'prova2024_pag_1_desempenho_sinais.jpg', 'prova2024_pag_2_jal_datapath.jpg',
    'prova2024_pag_3_jal_fsm.jpg',
  ] },
  { prefix: 'incompleto', category: 'Incompletos (Para Praticar)', files: [
    'incompleto_mono_sem_controle.jpg', 'incompleto_multi_sem_controle.jpg',
    'incompleto_mono_add_sub_lw_sw.jpg', 'incompleto_mono_apenas_regs_alu.jpg',
    'incompleto_multi_apenas_registradores.jpg',
  ] },
  { prefix: 'completo', category: 'Completos (Referência)', files: [
    'completo_mono_datapath_controle.jpg', 'completo_mono_com_jump.jpg',
    'completo_mono_tabela_sinais.jpg', 'completo_multi_datapath.jpg',
    'completo_multi_fsm_10_estados.png', 'completo_multi_excecoes.jpg',
    'completo_multi_fsm_excecoes.jpg',
  ] },
  { prefix: 'passo', category: 'Passos Multiciclo', files: [
    'passo_1_busca_fetch.jpg', 'passo_2_decodificacao_branch.jpg',
    'passo_3_tipo_r_execucao.jpg', 'passo_4_tipo_r_writeback.jpg',
    'passo_3_memoria_endereco.jpg', 'passo_4_load_leitura.jpg',
    'passo_5_load_writeback.jpg', 'passo_4_store_memoria.jpg',
    'passo_3_branch_desvio.jpg', 'passo_3_jump_salto.jpg',
  ] },
  { prefix: 'exercicio', category: 'Exercícios dos Slides', files: [
    'exercicio_4_1_and.jpg', 'exercicio_4_2_lwi.jpg', 'exercicio_4_3_speedup.jpg',
    'exercicio_4_4_caminho_critico.jpg', 'exercicio_5_8_jr.jpg',
    'exercicio_5_11_lwpi.jpg', 'exercicio_5_29_stuck_at.jpg', 'exercicio_5_49_eret.jpg',
  ] },
];

const TEMPLATE_BY_FILENAME = new Map(CATEGORIES.flatMap(({ category, files }) => files.map((filename) => [
  filename,
  { filename, title: templateTitle(filename), category, badge: templateBadge(category), desc: '' },
])));

function templateTitle(filename) {
  return filename.replace(/\.(png|jpe?g)$/i, '').replaceAll('_', ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function templateBadge(category) {
  if (category.startsWith('🏆')) return 'Prova';
  if (category.startsWith('Incompletos')) return 'Treino';
  if (category.startsWith('Completos')) return 'Completo';
  if (category.startsWith('Passos')) return 'Passo';
  return 'Exercício';
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendAuthorizationError(response, authorization) {
  if (authorization.status === 'not_found') {
    sendJson(response, 404, { error: 'Quadro não encontrado.' });
    return true;
  }
  if (authorization.status === 'forbidden') {
    sendJson(response, 403, { error: 'Você ainda não é membro deste quadro.' });
    return true;
  }
  return false;
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readPng(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > MAX_STUDY_PNG_BYTES) throw requestError(413, 'A imagem excede o limite de 10 MiB.');
  if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'image/png') {
    throw requestError(415, 'Envie uma imagem PNG.');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_STUDY_PNG_BYTES) throw requestError(413, 'A imagem excede o limite de 10 MiB.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw requestError(415, 'O conteúdo enviado não é um PNG válido.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    throw requestError(400, 'As dimensões da imagem PNG são inválidas ou excedem 16.384 px.');
  }
  return bytes;
}

async function listTemplates(response, templateDirectory) {
  let existing;
  try {
    existing = new Set(await readdir(templateDirectory));
  } catch {
    existing = new Set();
  }
  const catalog = [...TEMPLATE_BY_FILENAME.values()]
    .filter((template) => existing.has(template.filename))
    .map((template) => ({
      ...template,
      url: `/api/templates/files/${encodeURIComponent(template.filename)}`,
    }));
  sendJson(response, 200, catalog);
}

async function sendTemplate(response, templateDirectory, rawFilename) {
  let filename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!TEMPLATE_BY_FILENAME.has(filename)) {
    response.writeHead(404).end();
    return;
  }
  const root = resolve(templateDirectory);
  const path = resolve(root, filename);
  if (!path.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const image = await readFile(path);
    response.writeHead(200, {
      'content-type': filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      'content-length': image.length,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    response.end(image);
  } catch {
    response.writeHead(404).end();
  }
}

async function saveBoardImage(request, response, db, boardId, accountId) {
  const initialAuthorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendAuthorizationError(response, initialAuthorization)) return;
  try {
    const bytes = await readPng(request);
    const authorization = authorizeBoardMembership(db, boardId, accountId);
    if (sendAuthorizationError(response, authorization)) return;
    const row = db.prepare(`
      INSERT INTO study_board_images (board_id, png_bytes, byte_length)
      VALUES (?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        png_bytes = excluded.png_bytes,
        byte_length = excluded.byte_length,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING byte_length AS byteLength, updated_at AS updatedAt
    `).get(boardId, bytes, bytes.length);
    sendJson(response, 200, { saved: true, boardId, ...row });
  } catch (error) {
    sendJson(response, error.status ?? 500, {
      error: error.status ? error.message : 'Não foi possível salvar a imagem do quadro.',
    });
  }
}

function boardImageStatus(response, db, boardId, accountId) {
  const authorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendAuthorizationError(response, authorization)) return;
  const image = db.prepare(`
    SELECT byte_length AS byteLength, updated_at AS updatedAt
    FROM study_board_images WHERE board_id = ?
  `).get(boardId);
  sendJson(response, 200, { boardId, hasImage: Boolean(image), ...(image ?? {}) });
}

function downloadBoardImage(response, db, boardId, accountId) {
  const authorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendAuthorizationError(response, authorization)) return;
  const image = db.prepare('SELECT png_bytes AS bytes FROM study_board_images WHERE board_id = ?').get(boardId);
  if (!image) {
    sendJson(response, 404, { error: 'Este quadro ainda não tem imagem salva para análise.' });
    return;
  }
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': image.bytes.length,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(image.bytes);
}

function validateFeedback(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.notes) || body.notes.length > 100) {
    throw requestError(400, 'Envie uma lista de até 100 notas.');
  }
  const notes = body.notes.map((note) => {
    if (!note || typeof note !== 'object' || typeof note.text !== 'string'
      || !note.text.trim() || note.text.length > 4_000
      || (note.author !== undefined && (typeof note.author !== 'string' || note.author.length > 80))) {
      throw requestError(400, 'Cada nota precisa de texto de até 4.000 caracteres e autor opcional de até 80.');
    }
    return { author: note.author?.trim() || 'Anotação', text: note.text.trim() };
  });
  if (Buffer.byteLength(JSON.stringify(notes)) > 8_192) {
    throw requestError(413, 'As notas excedem o limite de 8 KiB.');
  }
  return notes;
}

async function saveFeedback(request, response, db, boardId, accountId) {
  const authorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendAuthorizationError(response, authorization)) return;
  try {
    const notes = validateFeedback(await readJsonBody(request));
    const authorizationAfterRead = authorizeBoardMembership(db, boardId, accountId);
    if (sendAuthorizationError(response, authorizationAfterRead)) return;
    const row = db.prepare(`
      INSERT INTO study_board_feedback (board_id, notes_json)
      VALUES (?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        notes_json = excluded.notes_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      RETURNING updated_at AS timestamp
    `).get(boardId, JSON.stringify(notes));
    sendJson(response, 200, { boardId, source: 'provided-notes', notes, timestamp: row.timestamp });
  } catch (error) {
    sendJson(response, error.status ?? 500, {
      error: error.status ? error.message : 'Não foi possível salvar as notas do quadro.',
    });
  }
}

function getFeedback(response, db, boardId, accountId) {
  const authorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendAuthorizationError(response, authorization)) return;
  const row = db.prepare(`
    SELECT notes_json AS notesJson, updated_at AS timestamp
    FROM study_board_feedback WHERE board_id = ?
  `).get(boardId);
  sendJson(response, 200, {
    boardId,
    source: 'provided-notes',
    notes: row ? JSON.parse(row.notesJson) : [],
    timestamp: row?.timestamp ?? null,
  });
}

export async function handleStudyFeatureRequest(request, response, db, {
  templateDirectory,
} = {}) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/templates') {
    await listTemplates(response, templateDirectory);
    return true;
  }
  const templateMatch = url.pathname.match(/^\/api\/templates\/files\/([^/]+)$/);
  if (request.method === 'GET' && templateMatch) {
    await sendTemplate(response, templateDirectory, templateMatch[1]);
    return true;
  }

  const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/study\/(image|feedback)$/);
  if (!match) return false;
  let boardId;
  try {
    boardId = decodeURIComponent(match[1]);
  } catch {
    sendJson(response, 400, { error: 'ID de quadro inválido.' });
    return true;
  }
  const session = getAuthenticatedSession(request, db);
  if (!session) {
    sendJson(response, 401, { error: 'Entre na sua conta para acessar os recursos de estudo.' });
    return true;
  }

  const resource = match[2];
  if (resource === 'image' && request.method === 'POST') {
    await saveBoardImage(request, response, db, boardId, session.accountId);
    return true;
  }
  if (resource === 'image' && request.method === 'GET') {
    if (url.searchParams.get('download') === '1') downloadBoardImage(response, db, boardId, session.accountId);
    else boardImageStatus(response, db, boardId, session.accountId);
    return true;
  }
  if (resource === 'feedback' && request.method === 'GET') {
    getFeedback(response, db, boardId, session.accountId);
    return true;
  }
  if (resource === 'feedback' && request.method === 'POST') {
    await saveFeedback(request, response, db, boardId, session.accountId);
    return true;
  }
  response.writeHead(405, { allow: 'GET, POST' }).end();
  return true;
}
