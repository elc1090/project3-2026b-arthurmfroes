ALTER TABLE board_updates
  ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1 CHECK (sequence > 0);

UPDATE board_updates AS current_update
SET sequence = (
  SELECT COUNT(*)
  FROM board_updates AS earlier_update
  WHERE earlier_update.board_id = current_update.board_id
    AND (
      earlier_update.received_at < current_update.received_at
      OR (
        earlier_update.received_at = current_update.received_at
        AND earlier_update.rowid <= current_update.rowid
      )
    )
);

CREATE UNIQUE INDEX board_updates_by_board_sequence
  ON board_updates(board_id, sequence);

CREATE TABLE board_update_cursors (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

INSERT INTO board_update_cursors (board_id, last_sequence)
SELECT board_id, MAX(sequence)
FROM board_updates
GROUP BY board_id;

ALTER TABLE board_checkpoints
  ADD COLUMN covered_sequence INTEGER NOT NULL DEFAULT 0 CHECK (covered_sequence >= 0);

CREATE UNIQUE INDEX board_checkpoints_by_board_coverage
  ON board_checkpoints(board_id, covered_sequence);
