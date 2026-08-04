// Postgres schema (idempotent). Applied on boot by a migrate plugin.
// Scoped per portal member_id (multitenant). See docs/PROCESS.md

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

-- #316: id of the portal's chat bot, so notices are signed by the app and not by the employee
-- whose token we hold. 0 = not registered (free plan, bot limit, or installed before the imbot
-- scope existed) — those portals keep the old im.message.add path. ADD COLUMN IF NOT EXISTS, not a
-- new column in the CREATE above: the table already exists on every deployed portal.
ALTER TABLE portal_tokens ADD COLUMN IF NOT EXISTS bot_id INTEGER NOT NULL DEFAULT 0;

-- Event-ordering guard (#77): a late/retried install job must not resurrect an uninstalled portal.
-- deleted_ts is a B24 event ts in unix SECONDS. Growth is bounded — retentionSweep drops rows older
-- than ~30d (a months-old tombstone can no longer be raced); see server/utils/retentionSweep.ts.
CREATE TABLE IF NOT EXISTS portal_tombstone (
  member_id  TEXT PRIMARY KEY,
  deleted_ts BIGINT NOT NULL
);

-- job_result REMOVED (#135): crm-sync idempotency moved to a Bitrix24 entity marker (originId/xmlId)
-- searched before create — the portal is the source of truth, nothing has written this checkpoint
-- table since. Drop it if a prior deploy created it (it's always empty — clients aren't launched, no
-- data to migrate); new deploys never create it. Uninstall-purge no longer references it.
DROP TABLE IF EXISTS job_result;

-- import_job moved OFF Postgres to Redis+TTL (#B): status/meta of each import job now lives in Redis
-- (server/utils/jobStore.ts + jobStoreRedis.ts) with native PX expiry, so nothing accumulates and no
-- per-portal table grows. Drop the legacy table if a prior deploy created it (clients aren't launched
-- yet → no data to migrate; safe to drop). New deploys never create it.
DROP TABLE IF EXISTS import_job;

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

-- Принятие Лицензионного соглашения и Политики конфиденциальности, одна строка на портал (#414).
-- Обращение к BitrixGPT идёт под учётной записью издателя, а его условия требуют от вызывающего
-- гарантировать наличие прав на передаваемые данные. Издатель документов не видел и такую гарантию
-- сам дать не может — она держится ТОЛЬКО на подтверждении клиента (п. 4.3.2 EULA). Значит
-- подтверждение должно быть получено и записано, а не считаться полученным по факту установки.
--
-- Что хранится: КАКИЕ редакции приняты (иначе запись доказывает лишь «когда-то нажали галочку»,
-- а спор всегда про то, ЧТО именно приняли) и когда.
--
-- ⚠ Уровень портала, НЕ сотрудника: по п. 2.7 EULA устанавливающее лицо действует от имени
-- организации, лицензиат — она. Идентификатор администратора расширил бы состав персональных
-- данных без всякой надобности, поэтому столбца под него здесь нет и заводить его нельзя.
--
-- ⚠ Строка неизменяемая: запись идёт ON CONFLICT DO NOTHING. Первое согласие — то, которое
-- имеет силу; перезапись стёрла бы дату, на которую и ссылаются. Деинсталляция строку удаляет
-- (см. deletePortal), поэтому повторная установка законно берёт согласие заново.
CREATE TABLE IF NOT EXISTS portal_consent (
  member_id       TEXT PRIMARY KEY,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  eula_edition    TEXT NOT NULL,
  privacy_edition TEXT NOT NULL
);

-- App-rating prompt state, one row per portal (kept «рядом с авторизацией», keyed like it by
-- member_id). Drives the in-portal «оцените приложение» modal:
--   prompted_at — last time the modal was shown (throttle: не чаще одного раза в RATING_REPROMPT_DAYS);
--   opened_at   — when the user clicked «Оценить» and we opened the Market detail page. While set,
--                 the modal is suppressed until an owner MANUALLY verifies the review (see docs);
--   reviewed    — set MANUALLY (true) once a real Market review is confirmed → terminal, never prompt again.
-- Manual verification (docs/PROJECT_MAP.md): if after ~RATING_REPROMPT_DAYS no review appeared, clear
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
