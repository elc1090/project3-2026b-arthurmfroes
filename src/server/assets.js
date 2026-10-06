import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getAuthenticatedSession } from './auth.js';
import { authorizeBoardMembership } from './boards.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_SIGNATURES = new Map([
  ['image/png', (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/gif', (bytes) => bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))],
  ['image/webp', (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'],
]);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendBoardError(response, authorization) {
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

async function readImageBytes(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw requestError(413, 'A imagem excede o limite de 10 MiB.');

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_IMAGE_BYTES) throw requestError(413, 'A imagem excede o limite de 10 MiB.');
    chunks.push(chunk);
  }
  if (length === 0) throw requestError(400, 'Envie os bytes de uma imagem.');
  return Buffer.concat(chunks, length);
}

function imageMimeType(request, bytes) {
  const declared = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  const hasSignature = IMAGE_SIGNATURES.get(declared);
  if (!hasSignature || !hasSignature(bytes)) {
    throw requestError(415, 'Envie PNG, JPEG, GIF ou WebP com assinatura válida.');
  }
  return declared;
}

function assetPath(storageDirectory, storageKey) {
  const root = resolve(storageDirectory);
  const path = resolve(root, ...storageKey.split('/'));
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid asset storage key');
  return path;
}

async function persistAsset(db, storageDirectory, boardId, bytes, mimeType) {
  const assetId = randomUUID();
  const storageKey = `${boardId}/${assetId}`;
  const path = assetPath(storageDirectory, storageKey);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(resolve(path, '..'), { recursive: true });
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, path);
    try {
      db.prepare(`
        INSERT INTO assets (id, board_id, storage_key, mime_type, byte_length)
        VALUES (?, ?, ?, ?, ?)
      `).run(assetId, boardId, storageKey, mimeType, bytes.length);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { assetId, boardId, mimeType, byteLength: bytes.length };
}

async function uploadAsset(request, response, db, storageDirectory, boardId, accountId) {
  const beforeRead = authorizeBoardMembership(db, boardId, accountId);
  if (sendBoardError(response, beforeRead)) return;
  try {
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      throw requestError(415, 'Codificação de conteúdo não suportada.');
    }
    const bytes = await readImageBytes(request);
    const mimeType = imageMimeType(request, bytes);
    const beforePersist = authorizeBoardMembership(db, boardId, accountId);
    if (sendBoardError(response, beforePersist)) return;
    const asset = await persistAsset(db, storageDirectory, boardId, bytes, mimeType);
    sendJson(response, 201, {
      asset: {
        ...asset,
        href: `/api/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(asset.assetId)}`,
      },
    });
  } catch (error) {
    sendJson(response, error.status ?? 500, {
      error: error.status ? error.message : 'Não foi possível salvar a imagem.',
    });
  }
}

async function downloadAsset(response, db, storageDirectory, boardId, assetId, accountId) {
  const authorization = authorizeBoardMembership(db, boardId, accountId);
  if (sendBoardError(response, authorization)) return;
  const asset = db.prepare(`
    SELECT id AS assetId, board_id AS boardId, storage_key AS storageKey,
      mime_type AS mimeType, byte_length AS byteLength
    FROM assets WHERE board_id = ? AND id = ?
  `).get(boardId, assetId);
  if (!asset) {
    sendJson(response, 404, { error: 'Imagem não encontrada.' });
    return;
  }

  try {
    const bytes = await readFile(assetPath(storageDirectory, asset.storageKey));
    const stillAuthorized = authorizeBoardMembership(db, boardId, accountId);
    if (sendBoardError(response, stillAuthorized)) return;
    response.writeHead(200, {
      'content-type': asset.mimeType,
      'content-length': bytes.length,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
  } catch {
    sendJson(response, 404, { error: 'Imagem não encontrada.' });
  }
}

export async function handleAssetRequest(request, response, db, storageDirectory) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/boards/')) return false;
  const match = url.pathname.match(/^\/api\/boards\/([^/]+)\/assets(?:\/([^/]+))?$/);
  if (!match) return false;

  let boardId;
  let assetId;
  try {
    boardId = decodeURIComponent(match[1]);
    assetId = match[2] === undefined ? null : decodeURIComponent(match[2]);
  } catch {
    sendJson(response, 400, { error: 'ID inválido.' });
    return true;
  }

  const session = getAuthenticatedSession(request, db);
  if (!session) {
    sendJson(response, 401, { error: 'Entre na sua conta para acessar imagens.' });
    return true;
  }

  if (!assetId && request.method === 'POST') {
    await uploadAsset(request, response, db, storageDirectory, boardId, session.accountId);
    return true;
  }
  if (assetId && request.method === 'GET') {
    await downloadAsset(response, db, storageDirectory, boardId, assetId, session.accountId);
    return true;
  }
  response.writeHead(405, { allow: assetId ? 'GET' : 'POST' }).end();
  return true;
}
