import * as Y from 'yjs';

export function encodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Invalid base64 update');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** A vector alone cannot prove persistence of a deletion. */
export function documentCoverage(doc) {
  const { ds } = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
  return {
    vector: Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc))),
    deletes: Object.fromEntries([...ds.clients].map(([id, ranges]) => [id, ranges.map(({ clock, len }) => [clock, len])])),
  };
}

export function coversUpdate(coverage, bytes) {
  if (!coverage?.vector || !coverage?.deletes) return false;
  const { structs, ds } = Y.decodeUpdate(bytes);
  for (const item of structs) {
    if (item instanceof Y.Skip) continue;
    if ((coverage.vector[item.id.client] ?? 0) < item.id.clock + item.length) return false;
  }
  for (const [id, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      if (!(coverage.deletes[id] ?? []).some(([start, length]) => start <= clock && start + length >= clock + len)) return false;
    }
  }
  return true;
}

export async function updateDigest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function verifyReceipt(receipt, key, boardId) {
  try {
    if (receipt?.payload?.boardId !== boardId || typeof receipt.signature !== 'string') return false;
    return await crypto.subtle.verify('Ed25519', key, decodeBytes(receipt.signature), new TextEncoder().encode(JSON.stringify(receipt.payload)));
  } catch { return false; }
}
