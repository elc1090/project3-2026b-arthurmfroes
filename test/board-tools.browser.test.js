import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const imagePath = join(root, 'whiteboard/templates/completo_multi_fsm_10_estados.png');
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="board-toolbar">
  <button data-board-tool="select" aria-pressed="true">Selecionar</button>
  <button data-board-tool="pen">Caneta</button><button data-board-tool="highlighter">Marca-texto</button>
  <button data-board-tool="line">Linha</button><button data-board-tool="arrow">Seta</button>
  <button data-board-tool="rectangle">Retângulo</button><button data-board-tool="mux">MUX</button>
  <button data-board-tool="alu">ULA / ALU</button><button data-board-tool="text">Texto</button>
  <button data-board-tool="eraser">Borracha</button><button data-board-tool="pan">Mover tela</button>
  <button data-board-color="#1e293b" aria-pressed="true">Preto</button>
  <button data-board-color="#dc2626">Vermelho</button>
  <button data-board-size="2" aria-pressed="true">Fina</button><button data-board-size="8">Grossa</button>
  <button data-board-action="clear">Limpar quadro</button>
  <button data-board-action="zoom-in">Zoom +</button><button data-board-action="zoom-out">Zoom -</button>
  <button data-board-action="zoom-reset">Zoom 1:1</button><button data-board-action="fit">Enquadrar</button>
  <button data-board-image-add>Adicionar imagem</button><input data-board-image-picker type="file" accept="image/png,image/jpeg,image/gif,image/webp">
  <button data-board-undo disabled>Desfazer</button><button data-board-redo disabled>Refazer</button>
  <p data-board-image-status></p>
</div><canvas id="board-canvas" width="800" height="480"></canvas>
<script type="module">
  import { mountBoardCanvas } from '/board.bundle.js';
  window.__mounted = mountBoardCanvas({
    boardId: new URL(location.href).searchParams.get('boardId'),
    canvas: document.querySelector('#board-canvas'), toolbar: document.querySelector('#board-toolbar'),
  });
  window.__elements = () => {
    const maps = window.__mounted.doc.getMap('elements');
    return window.__mounted.doc.getArray('order').toArray().flatMap(id => {
      const record = maps.get(id);
      if (!record || record.get('deleted')) return [];
      return [{ id, type: record.get('type'), geometry: record.get('geometry'),
        style: Object.fromEntries(record.get('style').entries()), data: Object.fromEntries(record.get('data').entries()) }];
    });
  };
  document.body.dataset.ready = 'true';
</script></body></html>`;

test('real browser exercises Canvas tools, text, selection, eraser, clear, shortcuts, and viewport controls', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-tools-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const boardId = randomUUID();
  const imageBytes = await readFile(imagePath);
  let allowUpload = false;
  await build({ absWorkingDir: root, entryPoints: ['src/public/board-session-entry.js'], bundle: true, format: 'esm', outfile: join(root, 'src/public/board.bundle.js') });
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this focused browser test');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.route(`**/api/boards/${boardId}/assets`, route => {
      if (route.request().method() === 'POST') {
        if (!allowUpload) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline' }) });
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
          asset: { boardId, assetId: 'offline-published-asset', mimeType: 'image/png' },
        }) });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
    });
    await page.route('**/__board-tools*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
    await page.goto(`${baseUrl}/__board-tools?boardId=${encodeURIComponent(boardId)}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    const canvas = page.locator('#board-canvas');
    const box = await canvas.boundingBox();
    const draw = async (tool, start, end) => {
      await page.locator(`[data-board-tool="${tool}"]`).click();
      await page.mouse.move(box.x + start.x, box.y + start.y);
      await page.mouse.down();
      await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 4 });
      await page.mouse.up();
    };

    await page.locator('[data-board-color="#dc2626"]').click();
    await page.locator('[data-board-size="8"]').click();
    await draw('pen', { x: 30, y: 40 }, { x: 120, y: 40 });
    await draw('highlighter', { x: 30, y: 80 }, { x: 120, y: 80 });
    await draw('line', { x: 170, y: 30 }, { x: 250, y: 60 });
    await draw('arrow', { x: 280, y: 30 }, { x: 360, y: 60 });
    await draw('rectangle', { x: 400, y: 30 }, { x: 480, y: 90 });
    await draw('mux', { x: 500, y: 30 }, { x: 540, y: 70 });
    await draw('alu', { x: 570, y: 30 }, { x: 630, y: 80 });
    await page.locator('[data-board-tool="text"]').click();
    await page.mouse.click(box.x + 650, box.y + 40);
    await page.locator('#board-canvas-text-input').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#board-canvas-text-input').fill('SUM A,B');
    await page.locator('#board-canvas-text-input').press('Shift+Enter');
    await page.locator('#board-canvas-text-input').type('C');
    await page.locator('#board-canvas-text-input').press('Enter');

    const shapes = await page.evaluate(() => window.__elements());
    assert.deepEqual(shapes.map(element => element.type), ['path', 'path', 'line', 'arrow', 'rect', 'mux', 'alu', 'text']);
    assert.equal(shapes[0].style.color, '#dc2626');
    assert.equal(shapes[0].style.strokeWidth, 8);
    assert.equal(shapes[1].style.tool, 'highlighter');
    assert.equal(shapes.at(-1).data.text, 'SUM A,B\nC');

    await page.locator('[data-board-tool="select"]').click();
    await page.mouse.move(box.x + 440, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 455, box.y + 65, { steps: 3 });
    await page.mouse.up();
    const moved = await page.evaluate(() => window.__elements());
    assert.deepEqual(moved.find(element => element.type === 'rect').geometry, { x: 415, y: 45, width: 80, height: 60 });
    assert.deepEqual(moved.find(element => element.type === 'line').geometry, { x1: 170, y1: 30, x2: 250, y2: 60 },
      'the reference selection hitbox excludes lines');

    await page.locator('[data-board-tool="eraser"]').click();
    await page.mouse.move(box.x + 75, box.y + 25);
    await page.mouse.down();
    await page.mouse.move(box.x + 75, box.y + 55, { steps: 4 });
    await page.mouse.up();
    const erased = await page.evaluate(() => window.__elements());
    assert.ok(erased.filter(element => element.type === 'path').length >= 3, 'eraser split the crossed stroke into visible segments');
    assert.ok(await page.locator('[data-board-undo]').isEnabled());
    await page.locator('[data-board-undo]').click();
    assert.equal((await page.evaluate(() => window.__elements())).filter(element => element.type === 'path').length, 2);
    await page.locator('[data-board-redo]').click();
    assert.ok((await page.evaluate(() => window.__elements())).filter(element => element.type === 'path').length >= 3);

    const initialViewport = await page.evaluate(() => window.__mounted.canvas.getViewport());
    await page.locator('[data-board-action="zoom-in"]').click();
    assert.ok((await page.evaluate(() => window.__mounted.canvas.getViewport())).zoom > initialViewport.zoom);
    await page.locator('[data-board-action="zoom-reset"]').click();
    assert.deepEqual(await page.evaluate(() => window.__mounted.canvas.getViewport()), { zoom: 1, panX: 0, panY: 0 });
    await page.locator('[data-board-action="fit"]').click();
    assert.ok((await page.evaluate(() => window.__mounted.canvas.getViewport())).zoom > 0);
    await page.keyboard.press('p');
    assert.equal(await page.locator('[data-board-tool="pen"]').getAttribute('aria-pressed'), 'true');
    const beforeSpacePan = await page.evaluate(() => window.__mounted.canvas.getViewport());
    await page.keyboard.down('Space');
    await page.mouse.move(box.x + 700, box.y + 400);
    await page.mouse.down();
    await page.mouse.move(box.x + 720, box.y + 410, { steps: 2 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    assert.equal(await page.locator('[data-board-tool="pen"]').getAttribute('aria-pressed'), 'true', 'space temporarily pans without changing the selected tool');
    assert.notDeepEqual(await page.evaluate(() => window.__mounted.canvas.getViewport()), beforeSpacePan);
    await page.mouse.move(box.x + 400, box.y + 240);
    const beforeWheel = await page.evaluate(() => window.__mounted.canvas.getViewport().zoom);
    await page.mouse.wheel(0, -100);
    assert.ok((await page.evaluate(() => window.__mounted.canvas.getViewport().zoom)) > beforeWheel);

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-board-action="clear"]').click();
    await page.waitForFunction(() => window.__elements().length === 0);

    await page.locator('[data-board-image-picker]').setInputFiles(imagePath);
    await page.getByText('Imagem salva neste navegador; será enviada quando a conexão voltar.').waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => {
      const pixels = document.querySelector('#board-canvas').getContext('2d').getImageData(183, 15, 434, 450).data;
      return pixels.some((channel, index) => index % 4 === 3 && channel > 0);
    }, null, { timeout: 10_000 });
    assert.deepEqual(await page.evaluate(() => window.__elements()), [], 'an offline preview stays outside the shared Y.Doc');
    allowUpload = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => window.__elements().length === 1, null, { timeout: 10_000 });
    const uploadedImage = (await page.evaluate(() => window.__elements()))[0];
    assert.equal(uploadedImage.type, 'image');
    assert.equal(uploadedImage.data.assetId, 'offline-published-asset');
    const dropped = await page.evaluate(({ base64, x, y }) => {
      const raw = atob(base64);
      const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
      const canvas = document.querySelector('#board-canvas');
      const expected = window.__mounted.canvas.clientToBoardPoint(x, y);
      canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y }));
      return expected;
    }, { base64: imageBytes.toString('base64'), x: box.x + 700, y: box.y + 400 });
    await page.waitForFunction(() => window.__elements().length === 2, null, { timeout: 10_000 });
    const droppedImage = (await page.evaluate(() => window.__elements()))[1];
    assert.ok(Math.abs(droppedImage.geometry.x + droppedImage.geometry.width / 2 - dropped.x) < 0.01);
    assert.ok(Math.abs(droppedImage.geometry.y + droppedImage.geometry.height / 2 - dropped.y) < 0.01);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
