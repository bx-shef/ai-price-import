# Наблюдаемость: OpenTelemetry

> Last reviewed: 2026-07-21

Глубокая телеметрия backend'а на **OpenTelemetry** (официальный вектор Bitrix24 —
`bitrix-tools/b24-ai-starter-otel`): трейсы + метрики (+ логи) по OTLP в коллектор →
хранилище → Grafana. Разнесено на два слайса. Портировано из соседнего `client-bank-alfa-by`
(PR #317/#318), адаптировано под домен импорта прайсов.

## Слайс 1 — инструментирование Node (app-side) 🧪

**По умолчанию ВЫКЛЮЧЕНО.** Без `OTEL_EXPORTER_OTLP_ENDPOINT` бэкенд работает ровно как раньше —
`otel.instrument.mjs` при старте ничего не поднимает (лог `[otel] disabled …`).

- **Бутстрап `otel.instrument.mjs`** (корень репо) — грузится через `NODE_OPTIONS=--import` **до**
  приложения (иначе авто-инструментирование не успеет перехватить `http`/`pg`/`ioredis`; Nitro-плагин —
  поздно, а бандлер Nitro ломает require-хуки OTel, поэтому deps **вне** бандла — отдельный
  `otel-preload-package.json`, ставится в backend-образ **точными** версиями = что резолвит
  `pnpm-lock.yaml`/тестит CI). Поднимает `NodeSDK` + `getNodeAutoInstrumentations()`
  (http/pg/ioredis; `fs` выключен как шум) + OTLP trace/metric экспортёры. Эндпоинт/заголовки — из env.
- **Ручные спаны** (`@opentelemetry/api`, no-op когда SDK не зарегистрирован):
  - `withDependencySpan()` — оборачивает **каждый исходящий вызов к Bitrix** в спан `dep bitrix24 <op>`
    со `{system, operation, method, scope, status, error_kind, portal.hash}`: все B24 REST
    (`makeSdkRestCall`/`makeSdkListCall`) **и** OAuth-refresh POST'ы (`oauth.refresh` — keep-alive/reauth;
    `oauth.install-verify` — привязка member при установке, #162). Непокрытых вызовов Б24 не осталось;
  - `withSpan(…)` — **job-спан на КАЖДУЮ очередь конвейера** (`b24-events`/`file-extract`/`agent-run`/
    `crm-sync`): латентность + исход (`job.outcome` ok/error, `job.error_kind`) + `portal.hash` по стадии.
    У `file-extract`/`agent-run` — флаг `job.ok` (handled-fail vs успех); у `crm-sync` — исходы записи
    `{created, lines, unmatched, idempotent, warnings, errors}`. Так вся цепочка (приём события →
    извлечение текста/OCR → прогон агента → запись в CRM) видна в трейсах по стадиям и порталам.
  - `withSpan(…)` также оборачивает **HTTP-роут `/api/settings`** (`http.settings.get`/`http.settings.post`):
    латентность + `{http.method, http.op, http.outcome}` (`ok`/`no_auth`/`auth_failed`/`forbidden`/
    `bad_request`/`upstream_error`) + `portal.hash` (по домену фрейм-токена). Тело маппинга в спан **не**
    попадает (allowlist). **Область серверная:** прочие фрейм-роуты и **клиентские** взаимодействия
    (pull `reload.options`, открытие/закрытие слайдера настроек — идут из браузера во фрейме) спанами
    **не** покрыты — браузерного RUM у нас нет.
- **Приватность ([05-data-policy §4](redesign/05-data-policy.md)) — тройная защита коммерческих данных:**
  1. наши спаны эмитят **только allowlist** безопасных ключей (`server/utils/telemetryAttributes.ts`
     `pickSafeAttributes`) — поставщика/артикул/цену/содержимое документа прикрепить физически нельзя;
  2. **redaction-SpanProcessor** в бутстрапе срезает чувствительные атрибуты авто-инструментирования
     (`db.statement`, `*.url`/`*.query`, `*body*`/`*token*`/`*secret*`/…) до экспорта; `pg` — с
     `enhancedDatabaseReporting:false` (значения параметров не собираются);
  3. member_id идёт как **необратимый `portal.hash`** (SHA-256/12), не сам id; `error_kind` — токен из
     `code`/`name`, **не** текст ошибки (`recordException` не вызывается).
  Ядра чисты и покрыты тестами (`tests/telemetryAttributes.test.ts`, `tests/telemetrySpan.test.ts`);
  drift между inline-списком бутстрапа и каноническим TS-списком ловит parity-тест.

### Env (Слайс 1)

| Переменная | Назначение |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **База** OTLP-эндпоинта коллектора (напр. `http://otel-collector:4318`, **без** `/v1/traces`). **Не задан ⇒ телеметрия выключена**. ⚠ Экспортёр сам добавляет `/v1/traces`/`/v1/metrics` к общему эндпоинту — указывать базу, иначе путь удвоится |
| `TELEMETRY_ENABLED` | `0` — принудительно выключить даже при заданном эндпоинте (дефолт вкл, если эндпоинт есть) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Заголовки OTLP (напр. `Authorization=Bearer <token>`) — для bearer-auth коллектора |
| `OTEL_SERVICE_NAME` | Имя сервиса в трейсах (дефолт `ai-price-import-backend`) |
| `OTEL_SERVICE_VERSION` | Версия сервиса (дефолт — `NUXT_PUBLIC_COMMIT_SHA`) |

## Слайс 2 — общая станция (коллектор + ClickHouse + Grafana) 🧪

Приёмная сторона по образцу `b24-ai-starter-otel` — **отдельный общий сервис** (свой
`docker-compose`), а не профиль внутри приложения: под цель «много приложений в одной Grafana»
станция стоит один раз, а все приложения (это + до N других) шлют в неё по адресу и различаются
по `service.name`. Живёт в [`telemetry-station/`](../telemetry-station/README.md) (самодостаточно,
выносится в свой репозиторий):
- `otel-collector-contrib` — OTLP `:4318`/`:4317` с **bearer-auth**, batch, `transform`-процессор
  (второй барьер PII: срезает `db.statement`/URL/… на traces И logs);
- **ClickHouse** — хранилище, TTL 72ч (`create_schema:true`, схему создаёт коллектор);
- **Grafana** `:3001` — провижининг datasource (ClickHouse-плагин) + стартовый дашборд
  «Apps — Overview» (спаны/ошибки/p95-латентность/топ-ошибок, фильтр по `service.name`).
- **Переносимый Node-клиент** — [`telemetry-station/clients/node/`](../telemetry-station/clients/node/README.md):
  копируешь бутстрап + ставишь deps + 3 переменные окружения → приложение в дашбордах.

Подключить это приложение: задать `OTEL_EXPORTER_OTLP_ENDPOINT` (база станции, без `/v1/traces`),
`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <токен>`. Бутстрап у него уже
есть (слайс 1). **Живой прогон станции — за владельцем на сервере** (отдельный деплой, в CI не гоняется).
Станция исключена из Docker build-context (`.dockerignore`) и не линтуется тулингом приложения.

## Чем это дополняет «лёгкую» наблюдаемость

Не заменяет: снапшот-счётчики очередей (`GET /api/ops/queues`, `/api/queues`), пожизненные
счётчики портала (`metrics_counter`, панель `/metrics`), `GET /api/health` (liveness) — остаются.
OTel добавляет **историю, трейсы «где падает/тормозит по порталам» и метрики латентности REST/джоб**,
чего снапшоты не дают.
