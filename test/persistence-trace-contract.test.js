import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTraceEvent } from '../src/shared/persistence-trace.js';
export const sample = (data = {}) => ({ version: 1, eventId: 'event-1', boardId: 'board-1', traceSessionId: 'tab-1', docClientId: '100', sequence: 1, type: 'candidate-drawn', observedAt: '2026-10-22T10:00:00.000Z', monotonicMs: 10, data });
test('trace contract bounds priorities and metadata without accepting identity, secrets or server claims', () => {
  const candidate = { id: '100', token: 'generation', priority: 0xffffffff, eligible: true, reason: 'initial' };
  assert.equal(validateTraceEvent(sample({ candidate })).data.candidate.priority, 0xffffffff);
  assert.throws(() => validateTraceEvent(sample({ candidate: { ...candidate, priority: 0x100000000 } })));
  assert.throws(() => validateTraceEvent({ ...sample(), username: 'another-user' }));
  assert.throws(() => validateTraceEvent(sample({ password: 'secret' })));
  assert.throws(() => validateTraceEvent(sample({ update: 'AQID' })));
  assert.throws(() => validateTraceEvent({ ...sample(), type: 'server-committed' }));
  assert.doesNotThrow(() => validateTraceEvent({ ...sample(), type: 'server-committed' }, { server: true }));
  assert.throws(() => validateTraceEvent(sample({ candidates: Array(400).fill(candidate) })));
  assert.throws(() => validateTraceEvent(sample({ elapsedMs: -1 })));
  assert.doesNotThrow(() => validateTraceEvent({ ...sample({ elapsedMs: 23 }), observedAt: '2099-01-01T00:00:00Z' }));
});
