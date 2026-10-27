import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';

async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return port;
}

async function start(directory, host) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), DATABASE_PATH: join(directory, `test-${port}.sqlite`), TRUST_PROXY: 'true', SIGNALING_SECRET: 'isolated-render-startup-test' };
    if (host === undefined) delete env.HOST; else env.HOST = host;
    const child = spawn(process.execPath, ['src/server/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise((resolve, reject) => {
      const read = (chunk) => { output += chunk; if (output.includes('Whiteboard T3 ouvindo')) resolve(); };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', reject); child.once('exit', (code) => reject(new Error(`Startup exited ${code}: ${output}`)));
    });
    try {
      await ready;
      assert.ok(output.includes(`http://${host ?? '0.0.0.0'}:${port}`), output);
      console.log('Render startup fixture:', { cwd: process.cwd(), command: 'node src/server/main.js', pid: child.pid, url: `http://127.0.0.1:${port}` });
      return { child, baseUrl: `http://127.0.0.1:${port}` };
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      if (!output.includes('EADDRINUSE') || attempt === 2) throw error;
    }
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}

// Exercises the real entry point: direct createAppServer tests do not execute its bind or env handling.
test('Render entry binds publicly by default, honors HOST/PORT, and serves HTTPS cookies and authenticated WebSockets', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whiteboard-render-startup-')); let app; let socket;
  try {
    app = await start(directory);
    const health = await fetch(`${app.baseUrl}/health`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), {status: 'ok'});
    const post = (path, body, cookie) => fetch(`${app.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', ...(cookie ? {cookie} : {}) }, body: JSON.stringify(body) });
    const credentials = { username: 'render-test', password: 'isolated-render-password' };
    assert.equal((await post('/api/auth/register', credentials)).status, 201);
    const login = await post('/api/auth/login', credentials); assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/); assert.match(login.headers.get('set-cookie'), /; HttpOnly/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const created = await post('/api/boards', {title: 'Render isolated test'}, cookie); assert.equal(created.status, 201);
    const {board} = await created.json();
    const signal = await fetch(`${app.baseUrl}/api/boards/${board.id}/signaling`, {headers: {cookie}}); assert.equal(signal.status, 200); const {topic} = await signal.json();
    socket = new WebSocket(`${app.baseUrl.replace('http:', 'ws:')}/api/signaling`, {headers: {cookie}}); await once(socket, 'open');
    const reply = once(socket, 'message'); socket.send(JSON.stringify({type: 'subscribe', topics: [topic]}));
    assert.deepEqual(JSON.parse(String((await reply)[0])), {type: 'subscribed', topics: [topic]});
    assert.equal((await fetch(`${app.baseUrl}/api/boards/${board.id}/persistence-trace`, {headers: {cookie}})).status, 200);
    socket.terminate(); socket = null; await stop(app.child); app = null;
    app = await start(directory, '127.0.0.1');
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
  } finally { socket?.terminate(); if (app) await stop(app.child); await rm(directory, {recursive: true, force: true}); }
});
