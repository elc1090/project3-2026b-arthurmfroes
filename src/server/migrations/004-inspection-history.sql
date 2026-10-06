CREATE TABLE inspection_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  replica_id TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 1048576),
  source_sequence INTEGER,
  source_clock TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX inspection_snapshots_board_cursor ON inspection_snapshots(board_id, id DESC);
CREATE INDEX inspection_snapshots_board_replica ON inspection_snapshots(board_id, replica_id, id DESC);

CREATE TABLE inspection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  replica_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX inspection_events_board_cursor ON inspection_events(board_id, id DESC);
