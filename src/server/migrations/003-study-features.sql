CREATE TABLE study_board_images (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  png_bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE study_board_feedback (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  notes_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
