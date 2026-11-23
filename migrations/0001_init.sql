-- Hàng đợi TTS: mỗi job = 1 đoạn script (1 lần gọi API = 1 file mp3 trên R2).
-- key = sha256(model|voice_id|format|text) → trùng nội dung giữa các đề thì chỉ sinh 1 lần.
CREATE TABLE IF NOT EXISTS tts_job (
  key         TEXT PRIMARY KEY,
  sp          TEXT NOT NULL,          -- N | M | F | M2 | F2
  voice_id    TEXT NOT NULL,
  text        TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  prio        INTEGER NOT NULL,       -- thứ tự xử lý: đề → câu → đoạn
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS tts_job_queue ON tts_job(status, prio);

-- Hash nội dung đề đã đồng bộ vào hàng đợi (đổi file đề → đồng bộ lại).
CREATE TABLE IF NOT EXISTS exam_sync (
  exam_id   TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

-- Nhật ký mỗi lần chạy cron.
CREATE TABLE IF NOT EXISTS tts_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  remaining   INTEGER,                -- credit còn lại trước khi chạy
  reset_at    INTEGER,
  jobs_done   INTEGER NOT NULL DEFAULT 0,
  credits     INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

-- Khóa đơn giản tránh 2 lần chạy chồng nhau (cron + chạy tay).
CREATE TABLE IF NOT EXISTS lock (
  name    TEXT PRIMARY KEY,
  until   INTEGER NOT NULL
);

-- Bài làm: 1 dòng 'progress' đang làm dở mỗi đề + các dòng 'done' là lịch sử.
CREATE TABLE IF NOT EXISTS attempt (
  id          TEXT PRIMARY KEY,
  exam_id     TEXT NOT NULL,
  status      TEXT NOT NULL,          -- progress | done
  answers     TEXT NOT NULL DEFAULT '{}',
  left_sec    INTEGER,
  score       TEXT,                   -- JSON {moji:[c,t],bunpou:[..],dokkai:[..],choukai:[..]}
  correct     INTEGER,
  total       INTEGER,
  started_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempt_exam ON attempt(exam_id, status, finished_at);
