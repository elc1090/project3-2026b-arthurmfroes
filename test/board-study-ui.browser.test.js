import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createAppServer, openDatabase } from '../src/server/main.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const templateImage = join(root, 'whiteboard/templates/completo_multi_fsm_10_estados.png');

function addAccount(db, username) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sessionId = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO accounts (id, username, password_hash) VALUES (?, ?, ?)')
    .run(accountId, username, 'study-ui-browser-test');
  db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)')
    .run(sessionId, accountId, new Date(Date.now() + 60_000).toISOString());
  return { accountId, token };
}

test('real board page restores study tools, exports shared PNG, saves per board, and gates members', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-study-ui-'));
  const db = await openDatabase(join(directory, 'board.sqlite'));
  const owner = addAccount(db, 'studyuiowner');
  const member = addAccount(db, 'studyuimember');
  const outsider = addAccount(db, 'studyuioutsider');
  const boardId = randomUUID();
  db.prepare('INSERT INTO boards (id, title) VALUES (?, ?)').run(boardId, 'Study UI browser test');
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, owner.accountId);
  db.prepare('INSERT INTO memberships (board_id, account_id) VALUES (?, ?)').run(boardId, member.accountId);
  db.prepare('INSERT INTO study_board_feedback (board_id, notes_json) VALUES (?, ?)')
    .run(boardId, JSON.stringify([{ author: 'Tutoria', text: 'Revisar o sinal de branch.' }]));
  await build({
    absWorkingDir: root,
    entryPoints: ['src/public/board-session-entry.js'],
    bundle: true,
    format: 'esm',
    outfile: join(root, 'src/public/board.bundle.js'),
  });
  const server = await createAppServer({ db, assetStorageDirectory: join(directory, 'assets') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserPath = ['/usr/bin/google-chrome', '/snap/bin/chromium', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'a local Chromium executable is required for this focused browser test');
  let ownerContext;
  let memberContext;
  let outsiderContext;
  try {
    ownerContext = await chromium.launchPersistentContext(join(directory, 'profile-owner'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
      acceptDownloads: true,
    });
    memberContext = await chromium.launchPersistentContext(join(directory, 'profile-member'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    outsiderContext = await chromium.launchPersistentContext(join(directory, 'profile-outsider'), {
      executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await Promise.all([
      ownerContext.addCookies([{ name: 'whiteboard_session', value: owner.token, url: baseUrl }]),
      memberContext.addCookies([{ name: 'whiteboard_session', value: member.token, url: baseUrl }]),
      outsiderContext.addCookies([{ name: 'whiteboard_session', value: outsider.token, url: baseUrl }]),
    ]);

    const page = await ownerContext.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const readSharedElements = () => page.evaluate(async boardIdValue => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/content`);
      if (!response.ok) return [];
      return (await response.json()).elements;
    }, boardId);
    await page.goto(`${baseUrl}/boards/${boardId}`);
    await page.locator('#board-workspace').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll('.study-template-card').length > 0, null, { timeout: 10_000 });

    const catalog = await page.evaluate(async () => (await (await fetch('/api/templates')).json()));
    const categories = [...new Set(catalog.map(template => template.category))].sort();
    assert.deepEqual(categories, [
      'Completos (Referência)', 'Exercícios dos Slides', 'Incompletos (Para Praticar)',
      'Passos Multiciclo', '🏆 Prova Real (UFSM)',
    ].sort());
    await page.locator('#study-gallery-toggle').click();
    for (const category of categories) {
      await page.locator(`[data-study-filter="${category}"]`).click();
      assert.ok(await page.locator('.study-template-card:not([hidden])').count() > 0, `filter ${category} has cards`);
      assert.equal(await page.locator('.study-template-card:not([hidden])').evaluateAll(cards =>
        cards.every(card => card.dataset.templateCategory === document.querySelector(`[data-study-filter][aria-pressed="true"]`).dataset.studyFilter)), true);
    }
    await page.locator('[data-study-filter="all"]').click();
    const selectedTemplate = catalog.find(item => item.filename === 'completo_multi_fsm_10_estados.png');
    await page.locator('.study-template-card').filter({ hasText: selectedTemplate.title }).getByRole('button').click();
    await page.waitForFunction(async boardIdValue => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/content`);
      return response.ok && (await response.json()).elements.some(element => element.type === 'image');
    }, boardId, { timeout: 15_000 });

    await page.locator('#study-template-select').selectOption(selectedTemplate.filename);
    await page.waitForFunction(async boardIdValue => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/content`);
      return response.ok && (await response.json()).elements.filter(element => element.type === 'image').length === 2;
    }, boardId, { timeout: 15_000 });

    await page.locator('#study-sidebar-toggle').click();
    await page.locator('[data-study-tab="signals"]').click();
    assert.equal(await page.locator('#study-panel-signals').isVisible(), true);
    await page.locator('[data-study-tab="formulas"]').click();
    assert.equal(await page.locator('#study-panel-formulas').isVisible(), true);
    await page.locator('[data-study-tab="questions"]').click();
    assert.ok(await page.locator('#study-question-list button').count() > 0);
    await page.locator('[data-study-tab="feedback"]').click();
    await page.getByText('Revisar o sinal de branch.').waitFor({ timeout: 5_000 });
    assert.equal(await page.getByText('Este fluxo não executa inferência automática.').isVisible(), true);
    await page.locator('#study-sidebar-toggle').click();

    const canvas = page.locator('#board-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const draw = async (tool, start, end) => {
      await page.locator(`[data-board-tool="${tool}"]`).click();
      await page.mouse.move(box.x + start.x, box.y + start.y);
      await page.mouse.down();
      await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 4 });
      await page.mouse.up();
    };
    await page.locator('[data-board-color="#dc2626"]').click();
    await draw('rectangle', { x: 20, y: 30 }, { x: 110, y: 90 });
    await draw('pen', { x: 30, y: 140 }, { x: 180, y: 140 });
    await page.locator('[data-board-tool="text"]').click();
    await page.mouse.click(box.x + 220, box.y + 210);
    try {
      await page.locator('#board-canvas-text-input').waitFor({ state: 'visible', timeout: 5_000 });
    } catch (error) {
      throw new Error(`Canvas text tool did not open its editor: ${JSON.stringify(await page.evaluate(() => ({
        canvas: document.querySelector('#board-canvas').getBoundingClientRect().toJSON(),
        textToolPressed: document.querySelector('[data-board-tool="text"]').getAttribute('aria-pressed'),
        imageStatus: document.querySelector('#board-image-status').textContent,
        pageMessage: document.querySelector('#message').textContent,
      })))}; page errors: ${pageErrors.join('; ')}`, { cause: error });
    }
    await page.locator('#board-canvas-text-input').fill('SUM T3');
    await page.locator('#board-canvas-text-input').press('Enter');
    await page.waitForFunction(async boardIdValue => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/content`);
      return response.ok && (await response.json()).elements.some(element => element.type === 'text');
    }, boardId, { timeout: 15_000 });
    const exportedElements = await readSharedElements();
    const elementTypes = exportedElements.map(element => element.type);
    assert.ok(elementTypes.includes('rect'));
    assert.ok(elementTypes.includes('path'));
    assert.ok(elementTypes.includes('text'));
    assert.ok(elementTypes.includes('image'));

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#study-export-png').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^whiteboard_mips_\d+\.png$/);
    const localPng = await readFile(await download.path());
    assert.deepEqual([...localPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const saveRequests = [];
    page.on('request', request => {
      if (request.url().endsWith(`/api/boards/${boardId}/study/image`) && request.method() === 'POST') saveRequests.push(request);
    });
    await page.locator('#study-save-image').click();
    await page.getByText(/Imagem do quadro salva para análise/).waitFor({ timeout: 15_000 });
    assert.equal(saveRequests.length, 1);
    const savedRequest = saveRequests[0];
    assert.equal(savedRequest.headers()['content-type'], 'image/png');
    const postedPng = Buffer.from(db.prepare('SELECT png_bytes FROM study_board_images WHERE board_id = ?').get(boardId).png_bytes);
    assert.ok(postedPng.length > 8 && postedPng.length <= 10 * 1024 * 1024);
    assert.deepEqual([...postedPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const rendered = await page.evaluate(async ({ boardIdValue, elements }) => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/study/image?download=1`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rectangle = elements.find(element => element.type === 'rect');
      const stroke = elements.find(element => element.type === 'path');
      const text = elements.find(element => element.type === 'text');
      const image = elements.find(element => element.type === 'image');
      const minX = Math.min(rectangle.geometry.x, ...stroke.geometry.points.map(point => point.x), text.geometry.x, image.geometry.x);
      const minY = Math.min(rectangle.geometry.y, ...stroke.geometry.points.map(point => point.y), text.geometry.y, image.geometry.y);
      const offsetX = 50 - minX;
      const offsetY = 50 - minY;
      const count = (x, y, width, height, predicate) => {
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(canvas.width, Math.ceil(x + width));
        const bottom = Math.min(canvas.height, Math.ceil(y + height));
        const region = context.getImageData(left, top, right - left, bottom - top).data;
        let matches = 0;
        for (let index = 0; index < region.length; index += 4) if (predicate(region, index)) matches += 1;
        return matches;
      };
      const red = (data, index) => data[index] > 150 && data[index + 1] < 100 && data[index + 2] < 100 && data[index + 3] > 0;
      const dark = (data, index) => data[index] < 100 && data[index + 1] < 100 && data[index + 2] < 100 && data[index + 3] > 0;
      const result = {
        width: bitmap.width,
        height: bitmap.height,
        rectangleRed: count(offsetX + rectangle.geometry.x - 3, offsetY + rectangle.geometry.y - 3,
          rectangle.geometry.width + 6, rectangle.geometry.height + 6, red),
        strokeRed: count(offsetX + 30, offsetY + 137, 150, 7, red),
        textRed: count(offsetX + text.geometry.x, offsetY + text.geometry.y, 100, 35, red),
        imageDark: count(offsetX + image.geometry.x + 10, offsetY + image.geometry.y + 10,
          image.geometry.width - 20, image.geometry.height - 20, dark),
      };
      bitmap.close();
      return { status: response.status, result };
    }, { boardIdValue: boardId, elements: exportedElements });
    assert.equal(rendered.status, 200);
    assert.ok(rendered.result.width >= 1200 && rendered.result.height >= 800, 'manual analysis PNG is high resolution');
    assert.ok(rendered.result.rectangleRed > 10, `export contains the shared rectangle (${JSON.stringify(rendered.result)})`);
    assert.ok(rendered.result.strokeRed > 10, `export contains the shared stroke (${JSON.stringify(rendered.result)})`);
    assert.ok(rendered.result.textRed > 2, `export contains the shared text (${JSON.stringify(rendered.result)})`);
    assert.ok(rendered.result.imageDark > 50, `export contains pixels from the authorized image asset (${JSON.stringify(rendered.result)})`);

    const keyboardSaveRequest = page.waitForRequest(request =>
      request.url().endsWith(`/api/boards/${boardId}/study/image`) && request.method() === 'POST');
    await page.keyboard.press('Control+s');
    await keyboardSaveRequest;
    await page.getByText(/Imagem do quadro salva para análise/).waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('#study-save-image').disabled === false);
    assert.equal(saveRequests.length, 2, 'Ctrl/Cmd+S calls the manual per-board save');

    const memberPage = await memberContext.newPage();
    const memberResponse = await memberPage.goto(baseUrl);
    assert.equal(memberResponse.status(), 200);
    const memberResult = await memberPage.evaluate(async boardIdValue => {
      const response = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/study/image?download=1`);
      return { status: response.status, contentType: response.headers.get('content-type') };
    }, boardId);
    assert.deepEqual(memberResult, { status: 200, contentType: 'image/png' });

    const outsiderPage = await outsiderContext.newPage();
    await outsiderPage.goto(baseUrl);
    const outsiderResult = await outsiderPage.evaluate(async boardIdValue => {
      const image = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/study/image?download=1`);
      const feedback = await fetch(`/api/boards/${encodeURIComponent(boardIdValue)}/study/feedback`);
      return [image.status, feedback.status];
    }, boardId);
    assert.deepEqual(outsiderResult, [403, 403]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await ownerContext?.close();
    await memberContext?.close();
    await outsiderContext?.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
