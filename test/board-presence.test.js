import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoardPresence } from '../src/client/board-presence.js';

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      const due = [...timers.entries()].filter(([, timer]) => timer.delay <= milliseconds);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    get timers() { return [...timers.values()]; },
  };
}

test('cursor and preview are throttled while clear and disconnect cancel pending sends', () => {
  const clock = fakeClock();
  const presence = createBoardPresence('board-1', () => {}, {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  presence.setLocalCursor({ x: 0, y: 0 });
  for (let x = 1; x <= 20; x += 1) presence.setLocalCursor({ x, y: x });
  assert.deepEqual(clock.timers.map(({ delay }) => delay), [35]);

  clock.advance(35);
  assert.equal(clock.timers.length, 0);
  presence.setLocalCursor({ x: 21, y: 21 });
  assert.deepEqual(clock.timers.map(({ delay }) => delay), [35]);
  presence.setLocalCursor(null);
  assert.equal(clock.timers.length, 0, 'clearing cursor bypasses and cancels the throttle');

  presence.setStrokePreview({ tool: 'pen', points: [{ x: 0, y: 0 }] });
  for (let x = 1; x <= 20; x += 1) {
    presence.setStrokePreview({ tool: 'pen', points: [{ x, y: x }] });
  }
  assert.deepEqual(clock.timers.map(({ delay }) => delay), [45]);
  presence.clearForDisconnect();
  assert.equal(clock.timers.length, 0, 'disconnect clears and cancels pending preview sends');
  presence.destroy();
});

test('presence payloads reject invalid or oversized points', () => {
  const presence = createBoardPresence('board-1');
  assert.throws(() => presence.setLocalCursor({ x: Number.NaN, y: 0 }), /coordinates/);
  assert.throws(() => presence.setStrokePreview({ tool: 'pen', points: Array(257).fill({ x: 0, y: 0 }) }), /at most 256/);
  assert.throws(() => presence.setLocalPresence({ displayName: 'x'.repeat(65), color: '#000' }), /displayName/);
  presence.destroy();
});
