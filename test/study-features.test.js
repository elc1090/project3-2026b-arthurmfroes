import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppServer, openDatabase } from '../src/server/main.js';
import { MAX_STUDY_PNG_BYTES } from '../src/server/study-features.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S3sAAAAASUVORK5CYII=',
  'base64',
);

async function serve(db, templateDirectory) {
  const server = await createAppServer({ db, templateDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function registerAndLogin(baseUrl, username) {
  const password = `${username} secure password`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(registration.status, 201);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  return { cookie: login.headers.get('set-cookie').split(';')[0] };
}

test('study templates filter missing files and board PNG/notes are member-gated and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-t3-study-'));
  const databasePath = join(directory, 'study.sqlite');
  const templateDirectory = join(directory, 'templates');
  await mkdir(templateDirectory);
  await writeFile(join(templateDirectory, 'completo_multi_fsm_10_estados.png'), PNG_1X1);
  await writeFile(join(templateDirectory, 'not-in-catalog.png'), PNG_1X1);
  let db = await openDatabase(databasePath);
  let app;
  try {
    app = await serve(db, templateDirectory);
    const owner = await registerAndLogin(app.baseUrl, 'study-owner');
    const outsider = await registerAndLogin(app.baseUrl, 'study-outsider');
    const created = await fetch(`${app.baseUrl}/api/boards`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Study board' }),
    });
    assert.equal(created.status, 201);
    const { board } = await created.json();
    const secondCreated = await fetch(`${app.baseUrl}/api/boards`, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Other study board' }),
    });
    assert.equal(secondCreated.status, 201);
    const { board: secondBoard } = await secondCreated.json();

    const catalogResponse = await fetch(`${app.baseUrl}/api/templates`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].filename, 'completo_multi_fsm_10_estados.png');
    assert.equal(catalog[0].category, 'Completos (Referência)');
    const templateImage = await fetch(`${app.baseUrl}${catalog[0].url}`);
    assert.equal(templateImage.status, 200);
    assert.deepEqual(Buffer.from(await templateImage.arrayBuffer()), PNG_1X1);
    assert.equal((await fetch(`${app.baseUrl}/api/templates/files/not-in-catalog.png`)).status, 404);

    const imageUrl = `${app.baseUrl}/api/boards/${board.id}/study/image`;
    const secondImageUrl = `${app.baseUrl}/api/boards/${secondBoard.id}/study/image`;
    assert.equal((await fetch(imageUrl, { headers: { cookie: outsider.cookie } })).status, 403);
    assert.equal((await fetch(`${imageUrl}?download=1`, { headers: { cookie: owner.cookie } })).status, 404);
    assert.equal((await fetch(`${secondImageUrl}?download=1`, { headers: { cookie: owner.cookie } })).status, 404);
    const saved = await fetch(imageUrl, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: PNG_1X1,
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).byteLength, PNG_1X1.length);
    assert.equal((await fetch(imageUrl, { headers: { cookie: outsider.cookie } })).status, 403);

    const invalidPng = await fetch(imageUrl, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: Buffer.from('not png'),
    });
    assert.equal(invalidPng.status, 415);
    const oversized = await fetch(imageUrl, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'image/png' },
      body: Buffer.alloc(MAX_STUDY_PNG_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
    const feedbackUrl = `${app.baseUrl}/api/boards/${board.id}/study/feedback`;
    assert.equal((await fetch(feedbackUrl, { headers: { cookie: outsider.cookie } })).status, 403);
    const postedNotes = await fetch(feedbackUrl, {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ notes: [{ author: 'Tutoria', text: 'Revisar o caminho de branch.' }] }),
    });
    assert.equal(postedNotes.status, 200);
    assert.equal((await postedNotes.json()).source, 'provided-notes');
    const otherBoardNotes = await fetch(`${app.baseUrl}/api/boards/${secondBoard.id}/study/feedback`, {
      headers: { cookie: owner.cookie },
    });
    assert.deepEqual((await otherBoardNotes.json()).notes, []);

    await app.close();
    app = null;
    db.close();
    db = await openDatabase(databasePath);
    app = await serve(db, templateDirectory);
    const restartedImageUrl = `${app.baseUrl}/api/boards/${board.id}/study/image`;
    const restartedFeedbackUrl = `${app.baseUrl}/api/boards/${board.id}/study/feedback`;
    const downloaded = await fetch(`${restartedImageUrl}?download=1`, { headers: { cookie: owner.cookie } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), PNG_1X1);
    const feedback = await fetch(restartedFeedbackUrl, { headers: { cookie: owner.cookie } });
    assert.equal(feedback.status, 200);
    assert.deepEqual((await feedback.json()).notes, [{ author: 'Tutoria', text: 'Revisar o caminho de branch.' }]);
  } finally {
    if (app) await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
