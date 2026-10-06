const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('whiteboard/app.js', 'utf8');
const history = source.slice(source.indexOf('function ensureElementIds()'), source.indexOf('function rehydrateImages()'));
const handlers = source.slice(source.indexOf('function handleWsMessage('), source.indexOf('// Broadcast throttle helpers'));
function client() {
  const context = vm.createContext({ document: { getElementById: () => null }, console });
  vm.runInContext(`
    let elements = [], undoStack = [], redoStack = [], pendingUndoState = null;
    let drawStartState = null, dragStartState = null, eraseStartState = null;
    let selectedElement = null, isDrawing = false, isDraggingElement = false;
    const MAX_UNDO_STACK = 100;
    const peerLiveStrokes = new Map();
    let messages = [];
    const sendWsMessage = msg => messages.push(msg);
    const scheduleAutoSave = () => {};
    const rehydrateImages = () => {};
    const render = () => {};
    const showSyncBadge = () => {};
    ${history}
    ${handlers}
  `, context);
  return {
    run: code => vm.runInContext(code, context),
    board: () => JSON.parse(vm.runInContext('serializeBoardState()', context)),
    sendTo(other) {
      const messages = JSON.parse(vm.runInContext('JSON.stringify(messages.splice(0))', context));
      for (const msg of messages) other.run(`handleWsMessage(${JSON.stringify(msg)})`);
    },
  };
}
const add = (c, id) => c.run(`recordState(); elements.push({id: '${id}', type: 'text', x: 0}); commitLocalAction();`);

test('two participants undo and redo only their own additions', () => {
  const a = client(), b = client();
  add(a, 'a'); a.sendTo(b);
  add(b, 'b'); b.sendTo(a);
  a.run('undo()'); a.sendTo(b);
  assert.deepEqual(a.board().map(e => e.id), ['b']);
  assert.deepEqual(b.board(), a.board());
  a.run('redo()'); a.sendTo(b);
  assert.deepEqual(a.board().map(e => e.id), ['a', 'b']);
  b.run('undo()'); b.sendTo(a);
  assert.deepEqual(a.board().map(e => e.id), ['a']);
});

test('remote drawing during a local gesture is excluded from its history', () => {
  const a = client(), b = client();
  a.run('drawStartState = serializeBoardState(); isDrawing = true;');
  add(b, 'b'); b.sendTo(a);
  a.run("pushUndoState(drawStartState); elements.push({id: 'a'}); isDrawing = false; commitLocalAction(); undo();");
  assert.deepEqual(a.board().map(e => e.id), ['b']);
});

test('undo clear restores removed elements without removing subsequent additions', () => {
  const a = client(), b = client();
  add(a, 'a'); a.sendTo(b);
  a.run('recordState(); elements = []; commitLocalAction();'); a.sendTo(b);
  add(b, 'b'); b.sendTo(a);
  a.run('undo()'); a.sendTo(b);
  assert.deepEqual(a.board().map(e => e.id), ['a', 'b']);
  assert.deepEqual(b.board(), a.board());
});

test('undo preserves a later edit by another participant to the same element', () => {
  const a = client(), b = client();
  add(a, 'a'); a.sendTo(b);
  b.run('recordState(); elements[0].x = 20; commitLocalAction();'); b.sendTo(a);
  a.run('undo()');
  assert.equal(a.board()[0].x, 20);
});

test('delete, move, and eraser split can be undone and redone', () => {
  const a = client();
  add(a, 'a');
  a.run('recordState(); elements[0].x = 20; commitLocalAction(); undo();');
  assert.equal(a.board()[0].x, 0);
  a.run('redo();');
  assert.equal(a.board()[0].x, 20);
  a.run('recordState(); elements = []; commitLocalAction(); undo();');
  assert.equal(a.board()[0].x, 20);
  a.run('recordState(); elements = [{...elements[0], x: 10}, {...elements[0], x: 30}]; commitLocalAction();');
  assert.equal(new Set(a.board().map(el => el.id)).size, 2);
  a.run('undo()');
  assert.equal(a.board().length, 1);
  assert.equal(a.board()[0].x, 20);
});

test('editing after undo does not mutate previous history entries', () => {
  const a = client();
  add(a, 'a');
  a.run('recordState(); elements[0].x = 10; commitLocalAction(); undo();');
  a.run('recordState(); elements[0].x = 30; commitLocalAction(); undo(); undo();');
  assert.deepEqual(a.board(), []);
});

test('canonical echoes reconcile simultaneous insertion order', () => {
  const a = client(), b = client();
  add(a, 'a'); add(b, 'b');
  for (const c of [a, b]) {
    c.run(`handleWsMessage({type: 'board_patch', changes: [{id: 'a', after: {id: 'a'}, afterIndex: 0}]});`);
    c.run(`handleWsMessage({type: 'board_patch', changes: [{id: 'b', after: {id: 'b'}, afterIndex: 0}]});`);
  }
  assert.deepEqual(a.board().map(el => el.id), ['b', 'a']);
  assert.deepEqual(b.board(), a.board());
});
