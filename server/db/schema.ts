// Postgres schema (idempotent). Applied on boot by a migrate plugin.
// Scoped per portal member_id (multitenant). See docs/redesign 02 §3.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_tokens (
  member_id          TEXT PRIMARY KEY,
  domain             TEXT NOT NULL,
  client_endpoint    TEXT NOT NULL DEFAULT '',
  access_token       TEXT NOT NULL DEFAULT '',
  refresh_token_enc  TEXT NOT NULL DEFAULT '',
  application_token  TEXT NOT NULL DEFAULT '',
  expires_in         INTEGER NOT NULL DEFAULT 3600,
  issued_at_ms       BIGINT NOT NULL DEFAULT 0,
  refreshed_at_ms    BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_tombstone (
  member_id  TEXT PRIMARY KEY,
  deleted_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_result (
  member_id    TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  entity_type_id INTEGER NOT NULL,
  entity_id    BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, job_id)
);

CREATE TABLE IF NOT EXISTS import_job (
  member_id    TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  file_name    TEXT NOT NULL DEFAULT '',
  result       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, job_id)
);

CREATE TABLE IF NOT EXISTS import_text (
  member_id  TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, job_id)
);

CREATE TABLE IF NOT EXISTS import_doc (
  member_id  TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, job_id)
);

CREATE TABLE IF NOT EXISTS metrics_counter (
  member_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, name)
);
`
