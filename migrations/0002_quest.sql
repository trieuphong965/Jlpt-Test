-- Quest ôn tập: mỗi lượt làm + từng câu trả lời (để phân tích điểm yếu).
CREATE TABLE IF NOT EXISTS quest_attempt (
  id          TEXT PRIMARY KEY,
  level       TEXT NOT NULL,
  quest_id    TEXT NOT NULL,          -- k1, g3… hoặc 'review' (ôn câu yếu)
  correct     INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quest_attempt_lv ON quest_attempt(level, finished_at);

CREATE TABLE IF NOT EXISTS quest_answer (
  attempt_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL,          -- N2-g3-04
  level       TEXT NOT NULL,
  correct     INTEGER NOT NULL,       -- 1 | 0
  ms          INTEGER,                -- thời gian trả lời
  at          INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, item_id)
);
CREATE INDEX IF NOT EXISTS quest_answer_lv ON quest_answer(level, at);
