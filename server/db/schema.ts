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

-- DEPRECATED (#135): crm-sync idempotency moved to a Bitrix24 entity marker (originId/xmlId)
-- searched before create — the source of truth is the portal, not this checkpoint. The table is
-- retained (not dropped) to avoid a prod migration on the switch; a later migration may DROP it.
-- Nothing writes it anymore; uninstall still purges it (harmless on an empty table).
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
  -- Write-once finalize claim (#164): flipped false→true by the run that first delivers the
  -- success chat message + timeline дело, so a retry resuming after a post-create failure
  -- (setRows threw) still finalizes exactly once and a redelivery of a done job doesn't re-post.
  notified     BOOLEAN NOT NULL DEFAULT false,
  -- Manual import target chosen by the operator at upload (entityTypeId/categoryId/stageId JSON) —
  -- overrides the routing rules for this one job. NULL = follow the rules / default target.
  manual_override JSONB,
  -- Archived source-file ref ({id, detailUrl}) when the portal's saveFile is on (#129 follow-up) —
  -- crm-sync links it as an «Исходный файл» button on the timeline дело. NULL = not archived.
  disk_file JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, job_id)
);
-- Backfill the columns on portals created before the feature (idempotent — no-op once present).
ALTER TABLE import_job ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE import_job ADD COLUMN IF NOT EXISTS manual_override JSONB;
ALTER TABLE import_job ADD COLUMN IF NOT EXISTS disk_file JSONB;
-- Close the one-time deploy window: rows that reached a terminal state BEFORE #164 backfill to
-- notified=false, so a stalled redelivery across the deploy could re-post a chat/дело for an
-- already-finished job. Mark every terminal job as finalized. The "notified=false" guard makes
-- this a no-op on every later boot (SCHEMA_SQL re-runs each start) and for jobs finalized normally.
UPDATE import_job SET notified=true WHERE notified=false AND status IN ('done','error');

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

-- App-rating prompt state, one row per portal (kept «рядом с авторизацией», keyed like it by
-- member_id). Drives the in-portal «оцените приложение» modal:
--   prompted_at — last time the modal was shown (throttle: не чаще одного раза в RATING_REPROMPT_DAYS);
--   opened_at   — when the user clicked «Оценить» and we opened the Market detail page. While set,
--                 the modal is suppressed until an owner MANUALLY verifies the review (see docs);
--   reviewed    — set MANUALLY (true) once a real Market review is confirmed → terminal, never prompt again.
-- Manual verification (docs/redesign/12): if after ~RATING_REPROMPT_DAYS no review appeared, clear
-- opened_at (UPDATE ... SET opened_at=NULL) so the modal returns; if it did, set reviewed=true.
CREATE TABLE IF NOT EXISTS portal_app_rating (
  member_id   TEXT PRIMARY KEY,
  prompted_at TIMESTAMPTZ,
  opened_at   TIMESTAMPTZ,
  reviewed    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`
