export const TRACE_LIMITS = Object.freeze({ eventBytes: 32768, requestBytes: 65536, requestEvents: 32, serverEvents: 2048, serverBytes: 8 * 1024 * 1024, localEvents: 1000, localBytes: 4 * 1024 * 1024, pageSize: 50 });
export const CLIENT_TRACE_TYPES = new Set(['candidate-drawn', 'election-view', 'batch-send', 'attempt-failed', 'ack-received', 'ack-verified', 'ack-rejected', 'receipt-forwarded', 'trace-gap']);
export const SERVER_TRACE_TYPES = new Set(['server-received', 'server-committed', 'server-ack-sent']);
const fields = new Set(['version', 'eventId', 'boardId', 'traceSessionId', 'docClientId', 'sequence', 'type', 'observedAt', 'monotonicMs', 'electionViewId', 'candidateToken', 'batchId', 'attemptId', 'receiptId', 'data']);
const dataFields = new Set(['candidate', 'candidates', 'representative', 'reason', 'rule', 'updateBytes', 'digest', 'retry', 'path', 'elapsedMs', 'confirmedUpdates', 'remainingUpdates', 'dropped', 'deduplicated', 'committedAt']);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
export const traceBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function validateTraceEvent(event, { server = false } = {}) {
  const fail = () => { throw new TypeError('Invalid persistence trace event'); };
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !fields.has(key))) fail();
  if (event.version !== 1 || !id(event.eventId) || !id(event.boardId) || !id(event.traceSessionId) || !id(event.docClientId)
    || !integer(event.sequence) || !Number.isFinite(Date.parse(event.observedAt))
    || !Number.isFinite(event.monotonicMs) || event.monotonicMs < 0
    || !(server ? SERVER_TRACE_TYPES : CLIENT_TRACE_TYPES).has(event.type)) fail();
  for (const key of ['electionViewId', 'candidateToken', 'batchId', 'attemptId', 'receiptId']) if (event[key] !== undefined && !id(event[key])) fail();
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => !dataFields.has(key))) fail();
  const candidate = (c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((key) => !['id', 'token', 'priority', 'eligible', 'reason'].includes(key))
      || !id(c.id) || !id(c.token) || !integer(c.priority) || c.priority > 0xffffffff || typeof c.eligible !== 'boolean'
      || typeof c.reason !== 'string' || c.reason.length > 120) fail();
  };
  if (data.candidate !== undefined) candidate(data.candidate);
  if (data.candidates !== undefined) { if (!Array.isArray(data.candidates)) fail(); data.candidates.forEach(candidate); }
  for (const key of ['reason', 'rule', 'path']) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 120)) fail();
  if (data.representative !== undefined && data.representative !== null && !id(data.representative)) fail();
  for (const key of ['updateBytes', 'confirmedUpdates', 'remainingUpdates', 'dropped']) if (data[key] !== undefined && !integer(data[key])) fail();
  if (data.elapsedMs !== undefined && (!Number.isFinite(data.elapsedMs) || data.elapsedMs < 0)) fail();
  for (const key of ['retry', 'deduplicated']) if (data[key] !== undefined && typeof data[key] !== 'boolean') fail();
  if (data.digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(data.digest)) fail();
  if (data.committedAt !== undefined && !Number.isFinite(Date.parse(data.committedAt))) fail();
  if (traceBytes(event) > TRACE_LIMITS.eventBytes) fail();
  return event;
}
