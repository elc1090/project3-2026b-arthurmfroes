CREATE TABLE persistence_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  reporter_key TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trace_session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('client', 'server')),
  type TEXT NOT NULL,
  doc_client_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  batch_id TEXT,
  election_view_id TEXT,
  attempt_id TEXT,
  event_json TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (board_id, reporter_key, event_id)
);
CREATE INDEX persistence_trace_board_cursor ON persistence_trace_events(board_id, id DESC);
CREATE INDEX persistence_trace_board_batch ON persistence_trace_events(board_id, batch_id, id);
CREATE INDEX persistence_trace_board_view ON persistence_trace_events(board_id, election_view_id, id);
CREATE TABLE persistence_trace_state (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  dropped INTEGER NOT NULL DEFAULT 0,
  pruned_through INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE persistence_trace_floors (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  reporter_key TEXT NOT NULL,
  trace_session_id TEXT NOT NULL,
  pruned_sequence INTEGER NOT NULL,
  PRIMARY KEY(board_id, reporter_key, trace_session_id)
);
