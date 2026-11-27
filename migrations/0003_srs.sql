-- Trạng thái lặp lại ngắt quãng (SM-2 kiểu Anki) cho từng thẻ.
-- due / added: số ngày (ngày địa phương tính từ 1970-01-01).
CREATE TABLE IF NOT EXISTS srs (
  level      TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  state      TEXT NOT NULL,      -- learn | review
  due        INTEGER NOT NULL,
  ivl        INTEGER NOT NULL,   -- khoảng cách (ngày)
  ease       REAL NOT NULL,      -- hệ số dễ (≥ 1.3)
  reps       INTEGER NOT NULL,
  lapses     INTEGER NOT NULL,
  added      INTEGER NOT NULL,   -- ngày học lần đầu
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (level, card_id)
);
CREATE INDEX IF NOT EXISTS srs_due ON srs(level, due);
