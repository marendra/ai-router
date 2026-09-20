CREATE TABLE IF NOT EXISTS provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  logical_model TEXT NOT NULL,
  upstream_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  failure_class TEXT,
  finish_reason TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_calls_ts ON provider_calls (ts);
CREATE INDEX IF NOT EXISTS idx_provider_calls_provider ON provider_calls (provider);
