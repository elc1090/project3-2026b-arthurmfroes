CREATE TABLE persistence_batches (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (board_id, batch_id)
);
