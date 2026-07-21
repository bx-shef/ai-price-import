# procure-ai (редизайн)

> Last reviewed: 2026-07-21

AI-импорт документов с табличной частью в Bitrix24. Облачное приложение Маркета
(мультитенант, OAuth), издатель ИП Шевчик И.С. Вход — любой документ с таблицей
(накладная/счёт/КП/прайс), суть — найти контрагента и внести товары в целевую CRM-сущность.

> **Идёт редизайн.** Полное описание проекта, процесса, архитектуры, стека и решений —
> в [`docs/redesign/`](docs/redesign/README.md) (00 старая арх. → 01 карта → 02 целевая арх. →
> 03 стек → 04 маркетинг → 05 политика данных → 06 мультиязычность → 07 план тестирования →
> 08 демо на лендинге → 09 деплой → 10 чек-лист проверок → 11 тарифы/self-hosted →
> 12 попап оценки в Маркете → 13 релиз в Маркете/go-to-market). Держим их синхронно.

## Раскладка

- `app/` — Nuxt (авто-импорт): `utils` (чистое ядро + тесты) / `composables` / `config` / `types` /
  `components` / `pages` / `layouts`.
- `server/` — Nitro backend: `api` / `utils` (чистые с DI) / `queue` (BullMQ) / `db` / `plugins` / `agent`.
  - **LLM-экстрактор — два движка за флагом `AGENT_ENGINE`** (`server/agent/`, все — tool-less, чистый
    text→JSON, инъекция документа не может ничего кроме JSON):
    - **`chat` (целевой, OpenAI-совместимый)** — `llmConfig.ts` (чистый резолвер `LLM_PROVIDER` →
      `{baseURL,apiKey,model}`: `deepseek`/`bitrixgpt`/`custom`, тесты) → `chatExtract.ts` (чистая
      оркестрация `runChatExtract`: `buildChatRequest` с `response_format:json_object`, ретрай через
      общий `retry.ts`, парс `extractJson` + `validateExtractedDocument` + гард `MAX_ITEMS`; DI —
      `ChatFn`, тесты) → `openaiChat.ts` (живой адаптер `makeChatFn` на `openai` SDK, `maxRetries:0` —
      ретрай наш; тонкий I/O-край, как `spawn.ts`, юнит-тестами не покрыт). **DeepSeek** (`/v1`,
      `deepseek-chat`) и **BitrixGPT** (Bitrix Vibecode AI Router `/v1`, `bitrix/bitrixgpt-5.5`) — один
      транспорт, оба поддерживаются, переключение конфигом. Живой прогон — `pnpm verify:chat --provider <p>`.
    - **`claude` (легаси, дефолт до cutover)** — `runAgent.ts`/`spawn.ts`/`mcpConfig.ts`: headless
      `claude` CLI (`AGENT_BIN`) через Anthropic-совместимый endpoint (`ANTHROPIC_*`), санит-env +
      таймаут + исчерпывающий tool-denylist. Удаляется после живой проверки chat-пути (#215/#8).
    Выбор движка резолвится в `worker.ts buildLiveInfra` (и в демо `api/demo/extract.post.ts`) → в
    `liveAgentRunDeps.extractDocument` ветвление `runChatExtract` vs `runAgent`. У chat-пути API-ключ
    живёт в самом процессе (нет подпроцесса) — санит-env не нужен, это не ослабление.
  - **Событие install/uninstall — через очередь** `b24-events` (порт из client-bank): роут
    `api/b24/events.post.ts` верифицирует и **кладёт в очередь**, консьюмер (`queue/handlers.handleEventJob`)
    — **единственный писатель** `portal_tokens`; при недоступности Redis роут пишет **синхронным
    фолбэком** (B24 online-события не ретраит). Порядок событий защищает **тумбстоун** `portal_tombstone`
    (#77): stale/out-of-order install не воскрешает удалённый портал (гард в `tokenStore.saveToken/deletePortal`
    по `eventTs` = top-level `ts` вебхука). **Рост тумбстоунов ограничен TTL** (#77): ежечасный `retentionSweep`
    сносит `portal_tombstone` старше `tombstoneDays` (env `TOMBSTONE_TTL_DAYS`, дефолт 30 д, кламп [1,365]) — гард нужен лишь чтобы пережить
    late/retried install той же деинсталляции (часы), а не месяцы; иначе копилась бы строка на каждый
    навсегда-удалённый портал. `deleted_ts` — `ts` в **секундах**, сверка с `EXTRACT(EPOCH FROM now())`
    unit-safe by construction (мс-значение просто никогда не подметётся, а не удалится рано). **Привязка member_id к OAuth-гранту на первой установке**
    (`verifyInstallMember`, #162): `verifyInstallToken` доказывает контроль **домена** (вызов `profile`), но не
    member_id — поэтому дополнительно рефрешим присланный `refresh_token` и сверяем **authoritative** member_id из
    ответа токен-эндпоинта с присланным `ev.memberId` (mismatch → 403; forged grant `invalid_grant` → 403;
    network/`wrong_client` → 503, fail-closed). Так поддельная установка (валидный токен своего портала + чужой
    member_id) не отравит member_id жертвы. Рефреш **ротирует** токен ⇒ на успехе храним **возвращённый** грант,
    а не присланные креды. Гейт на `B24_CLIENT_ID/SECRET` (без них рефреш невозможен в принципе). Тумбстоун
    неатомарен, но TOCTOU-free — событийный воркер
    **single-instance**.
  - **Роль-сплит воркеров** (`queue/runtime.ts`, scale-out): роли `QUEUE_WORKERS`/`QUEUE_CRON`.
    `startEventWorker` (события) идёт **только на primary/cron-инстансе**; `startThroughputWorkers`
    (extract/agent/crm-sync) масштабируется на N реплик (`worker`-контейнер, `QUEUE_CRON=0`). Гейтинг — в
    `plugins/queue.ts`. Per-queue concurrency — отдельно (`QUEUE_EXTRACT/AGENT/CRM_CONCURRENCY`,
    `worker.queueConcurrency`, #95).
  - **Рефреш OAuth-токена сериализован per-portal** (`utils/dbLock.withAdvisoryLock`, `ensureAccessToken`,
    #35): advisory-lock + re-read внутри лока → портал рефрешится ровно раз, без гонки на ротации
    refresh-token. Персист — `updateTokensOnRefresh` (UPDATE-only, не воскрешает удалённый портал); строка
    исчезла под локом ⇒ рефреш не делаем. Сам refresh идёт **через SDK** (`b24Sdk.sdkRefreshTransport` →
    `B24OAuth.auth.refreshAuth`), ограничен таймаутом (гонка — у SDK-axios рефреша нет своего таймаута), чтобы
    зависший OAuth не запинил лок + соединение пула. **Область**: этот путь — у **keep-alive крона**
    (`ensureFreshToken`, single-instance) и кнопки reauth (`portalReauth`). **crm-sync hot-path им НЕ ходит** — там транспорт
    `@bitrix24/b24jssdk` рефрешит **реактивно** (свой per-job `B24OAuth`, `setCallbackRefreshAuth`→персист),
    без advisory-лока: при scale-out throughput-воркеры могут ротануть один портал параллельно, но персист
    UPDATE-only идемпотентен, а SDK-лимитер гасит всплеск — гонка безопасна, лишь возможен лишний рефреш.
  - **REST-транспорт к порталу (crm-sync) — `@bitrix24/b24jssdk`, единственный** (`utils/b24Sdk.ts`,
    адаптер `B24OAuth`→`SdkTransport` `{ call, list }`): `call` — одиночный `RestCall`, `list` —
    **полная выборка списка** (`SdkListCall`, SDK сам пагинирует keyset-ом по `ID` через
    `actions.v2.callList.make` — ручной пейджер на этом транспорте не нужен). У SDK встроенный
    **RestrictionManager** (пер-портальный leaky-bucket лимитер + адаптивный operating-backoff). **In-SDK
    ретрай ОТКЛЮЧён** (`disableSdkRetry`, #123: `maxRetries:1`, `retryOnNetworkError:false`) — crm-sync
    создаёт НЕидемпотентные сущности (`crm.item.add`/`crm.product.add`), ретрай такого вызова после
    client-timeout/504 задвоил бы (Битрикс не гарантит уникальность `originId`/`xmlId`); целый джоб ретраит
    **BullMQ** (там create идемпотентен — find-before-create по маркеру). Find-before-create — TOCTOU: защищает
    **последовательные** ретраи (crash-recovery), но не **конкурентную** stalled-переобработку одного джоба
    (#163). Полный advisory-lock отклонён — держал бы pooled pg-соединение на REST-create при `pool max 5` →
    голодание пула на scale-out; вместо этого **тюнинг BullMQ-лока crm-воркера** (`crmLockTuning`:
    `lockDuration` 60с > дефолт 30с — живой воркер продлевает лок и не «протухает» ложно → второй воркер не
    стартует конкурентно; `maxStalledCount:1` — один recovery-редоставки для реально упавшего джоба). Остаются: проактивный rate-throttle,
    адаптивный backoff, реактивный OAuth-рефреш (`setCallbackRefreshAuth` → персист `updateTokensOnRefresh`,
    UPDATE-only). **Live-верифицирован** на `bel.bitrix24.by` (`pnpm sdk:smoke`: profile+crm.item.list+burst 30
    без `QUERY_LIMIT_EXCEEDED`). `makePortalSdkCall` строит `B24OAuth`; резолвер `createPortalSdkResolver` (#123/#163,
    порт из client-bank) **мемоизирует один клиент на портал** (единый лимитер-бакет + одна загрузка токена
    на джобу — раньше `need()` строил ~9 клиентов на джобу). Кэш безопасен при внешней ротации
    refresh-токена (сосед/keep-alive-крон) двумя клапанами: короткий **TTL** (`SDK_CLIENT_TTL_MS` 60с) +
    **evict-on-error** (упавший вызов дропает клиент → следующий resolve пересобирает из свежего DB-токена
    сразу, без вечного `invalid_grant`). На процесс с forever-кэшем НЕ полагаемся — самозаживает. Ручной
    `makePortalRestCall` удалён. Общий билдер
    `sdkPortalDeps(SdkInfra)` связывает `SdkPortalDeps` со стором/env — им пользуются и `liveDeps.restResolver`
    (crm-sync), и frame-token роут `catalog-properties` (читает по OAuth-токену портала: `resolveFrameMember`
    верифицирует фрейм-токен → `member_id`, дальше SDK). Чистые мапперы +
    `makeSdkRestCall`/`makeSdkListCall` тестируются фейком; типизация `new B24OAuth` как `OAuthCallClient` —
    compile-time drift-guard (typecheck ловит дрейф API SDK). Для Bitrix24-вызовов в новом коде — предпочитать SDK.
  - **ВСЕ вызовы Б24 идут через `@bitrix24/b24jssdk`** (ручной `fetch`-транспорт `b24Rest.makeRestCall`
    удалён). Два пути, раньше шедшие мимо SDK, переведены (единый транспорт: RestrictionManager, таймаут REST
    30s — внутренний axios SDK, refresh — 15s `REST_TIMEOUT_MS`, drift-guard):
    - **Frame/install-токен REST** (`profile`-верификация в `resolveFrameMember`/`verifyInstallToken`,
      `app.option` в роутах `settings.get/post`) → `b24Sdk.makeBareTokenSdkCall(domain, accessToken)`: per-call
      `B24OAuth` с фрейм-токеном, `expires` в 2100 (SDK не рефрешит проактивно) + `setCustomRefreshAuth` →
      `BARE_TOKEN_REJECTED` (у bare-токена нет server-side refresh → любой auth-error = «токен отвергнут»,
      `isAuthRejection` ловит → 401/403 vs 502/503). **SSRF-гард сохранён** (`isSafeB24Domain` внутри —
      клиентский `X-B24-Domain`/домен install-события не должен утащить токен на чужой хост). `verifyInstallToken`/
      `resolveFrameMember` берут инъектируемую фабрику `makeCall` (дефолт — SDK) → юнит-тестируются фейком.
      **Admin-гейт настроек (#182):** запись `POST /api/settings` серверно гейтится на `profile.ADMIN` через
      `verifyFrameToken` (token-only проверка: доказывает контроль домена + читает ADMIN, **без** `member_id`/
      install-зависимости — `app.option` скоуплен фрейм-токеном, так install-гонка/purge не отвергают валидного
      админа; `resolveFrameMember` надстроен над ним для роутов, которым нужен `member_id`). Не-админ → 403; GET
      отдаёт `admin`-флаг → клиент скрывает форму. Пикер-роуты (`catalog-*`/`crm-categories`/`crm-stages`) и
      `import/metrics-reset` гейтятся так же (admin). Раньше запись настроек была открыта любому пользователю портала.
    - **OAuth-refresh POST** (keep-alive крон `liveDeps`, кнопка reauth `portalReauth`) → `b24Sdk.sdkRefreshTransport()`
      через `B24OAuth.auth.refreshAuth()`: тот же refresh (POST `grant_type=refresh_token` на OAuth-сервер), но
      **секреты в теле POST** (старый код слал их в URL-query → утечка в access-логи), таймаут-гард (гонка —
      у SDK-axios рефреша нет таймаута), а вокруг остаётся `ensureFreshToken`: advisory-lock + re-read +
      UPDATE-only persist (#35). `rawTokenFromRefresh` (чистый маппер SDK-результат→raw JSON) тестируется.
    `b24Rest.ts` теперь несёт только чистые хелперы/контракт: тип `RestCall`, SSRF-гард `isSafeB24Domain`/
    `normaliseHost`, `B24RestError`, `isAuthRejection` (сырой `fetch`-транспорт `makeRestCall` + `unwrap`/`restUrl`
    удалены — SDK разворачивает `result` и строит URL сам; тип `FetchFn` остаётся для не-Б24 GitHub-POST `feedbackGithub`).
    **Единственное осознанное исключение из «всё через SDK» — `verifyInstallMember.rawOauthRefresh`** (#162): один
    сырой POST на `oauth.bitrix.info/oauth/token/` при верификации установки, т.к. SDK-рефреш **выбрасывает**
    `member_id` из ответа (`oauth/auth.mjs` его не читает), а привязка member_id его требует. Хост фиксированный
    (нет SSRF), секреты в теле POST, AbortSignal-таймаут.
  - **Пагинация enumerate-all списков** (#87): find-one lookup'ы (`findCompanyByTaxId`/`findProduct`)
    берут первый id и в пагинации не нуждаются, но enumerate-all чтения молча обрезались на дефолтной
    странице B24 (50). Оба таких чтения теперь на **SDK full-list** (`SdkListCall`→`callList.make`, SDK сам
    пагинирует keyset-ом; ручной пейджер удалён):
    - `fetchVatRates` (`crm.vat.list`) — дефолтный keyset по `ID`.
    - `searchCatalogProperties` (`catalog.productProperty.list`) — grouped-ключ `productProperties` + keyset
      `id` (opts `listKey`/`idKey`). Пикер артикула переведён на OAuth-токен портала (`resolveFrameMember`
      → `makePortalSdkCall`), поэтому SDK-клиент ему доступен.
    - `fetchCurrencies` (`crm.currency.list`) **НЕ** паджинируется намеренно — метод отдаёт все валюты
      за один вызов (`total:0`, игнорит `start`, у строк нет `ID` для keyset; live+docs).
  - **Keep-alive рефреш токенов** (`utils/tokenKeepAlive.runTokenKeepAlive`, #175): на cron-инстансе
    суточный крон рефрешит **только** порталы у истечения (`selectTokensNearExpiry` по `updated_at`,
    порог ~3 д, батч-кап 50) — иначе простаивающий портал теряет refresh_token на 180-й день. Гейт на
    `B24_CLIENT_ID/SECRET`, каденция `TOKEN_KEEPALIVE_HOURS` (дефолт 24, кламп [1h,168h]).
  - **Попап «оцените приложение»** ([`docs/redesign/12-app-rating.md`](docs/redesign/12-app-rating.md)):
    переиспользуемый `AppRatingModal.vue` (на `B24Modal`) на `/app` всплывает **после успешного импорта**
    и по кнопке открывает детальную страницу Маркета через `frame.slider.openPath('/marketplace/detail/<code>/')`
    (`marketDetailPath`; код по умолчанию — реальный слаг `shef.priceimport` из `LANDING_MARKET_CODE`,
    override — `NUXT_PUBLIC_B24_MARKET_CODE`). Решение показа — **на
    сервере**, рядом с авторизацией: таблица `portal_app_rating` (ключ `member_id`, чистится при uninstall) +
    чистая `shouldPrompt` (`prompted_at` троттлит показ ≤1 раза в `RATING_REPROMPT_DAYS`=4д; `opened_at`
    глушит до **ручной** проверки; `reviewed` — терминально). Роуты `GET /api/app-rating` (read-only `{show}`)
    / `POST` (`prompted`/`opened`) — фрейм-токен (`resolveFrameMember`). Факт отзыва Маркет по REST не отдаёт →
    владелец подтверждает **из UI оператора** (`/queues`, карточка «Оценки приложения», паттерн reauth):
    `GET/POST /api/ops/app-rating` (сессия оператора, чистые `appRatingStatus`/`appRatingOpsHandler` →
    `markReviewed`/`clearOpened`), SQL — запасной путь. Гифка-подсказка `public/app-rating-demo.gif`
    (сжата Pillow, ленивая загрузка).
  - **Глубокая телеметрия — OpenTelemetry** ([`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md), вектор
    Bitrix `b24-ai-starter-otel`; порт из client-bank PR #317/#318). **Слайс 1 (app-side) — DEFAULT OFF:**
    бутстрап `otel.instrument.mjs` грузится через `NODE_OPTIONS=--import` **до** приложения (иначе
    авто-инструментирование не перехватит http/pg/ioredis; Nitro-бандлер ломает require-хуки OTel → deps
    вне бандла, `otel-preload-package.json` **точными** версиями ставится в backend-образ). Без
    `OTEL_EXPORTER_OTLP_ENDPOINT` — no-op (поведение не меняется). Ручные спаны на `@opentelemetry/api`
    (no-op без SDK): `withDependencySpan` оборачивает каждый исходящий вызов к Б24 — все REST
    (`makeSdkRestCall`/`makeSdkListCall`, `memberId` проброшен) **и** OAuth-refresh POST'ы
    (`oauth.refresh`/`oauth.install-verify`); `withSpan(…)` — job-спан на **каждую** очередь
    (`b24-events`/`file-extract`/`agent-run`/`crm-sync`): латентность+исход+`portal.hash` по стадии;
    у extract/agent — `job.ok`, у crm-sync — исходы записи (`created`/`lines`/`unmatched`/`idempotent`/
    `warnings`/`errors`). **ВСЕ фрейм-токен HTTP-роуты** в `withSpan`: `/api/settings` (GET/POST) — напрямую,
    остальные (`app-rating` get/post, `catalog-measures`, `catalog-properties`, `chat-search`, `crm-categories`,
    `crm-stages`, `feedback`, `import/metrics`, `import/metrics-reset`, `import/status`, `import/upload`) — через
    общий хелпер `withFrameRouteSpan` (`server/utils/frameRouteSpan.ts`: мутабельный `span.outcome` в хендлере,
    `portal.hash` считается в finalize → zero-cost при выкле): латентность + `http.outcome` (`ok`/`no_auth`/
    `auth_failed`/`forbidden`/`bad_request`/`conflict`/`unavailable`/`upstream_error`/`no_db`) + `portal.hash` (по
    домену) — тело запроса/ответа (маппинг/комментарий/файл/id заданий/названия чатов) в спан **не** кладётся.
    (Публичный вебхук `/api/b24/events` покрыт job-спаном очереди `b24-events`; **клиентские** pull/слайдер спанами
    не покрыты — серверная OTel, браузерного RUM нет.) **PII-защита тройная:** allowlist
    наших атрибутов (`telemetryAttributes.ts` `pickSafeAttributes` — поставщика/артикул/цену прикрепить
    нельзя) + redaction-SpanProcessor авто-атрибутов (SQL/URL/токены) + `portal.hash` (SHA-256) вместо
    member_id, `error_kind` вместо текста ошибки. Чистые ядра + тесты (`telemetryAttributes`/`telemetrySpan`)
    + parity-тест против inline-списка бутстрапа. **Слайс 2 — общая станция** (`telemetry-station/`:
    otel-collector-contrib + ClickHouse 72ч + Grafana, отдельный деплой, вне build-context/CI).
  - **Трекинг задания импорта — Redis+TTL, НЕ Postgres** (`utils/jobStore.ts` + `utils/jobStoreRedis.ts`):
    статус/мета каждого задания (`status`/`fileName`/`result`/`manualOverride`/`diskFile`/`notified`)
    живёт в Redis-хеше `import:job:{member}:{jobId}` с native PX-expiry (TTL `IMPORT_JOB_TTL_HOURS`, дефолт
    48ч). **Серверного списка заданий НЕТ** (#D): браузер сотрудника держит свою историю в **localStorage**
    (`app/utils/importHistory.ts`, ключ `jobId`) и опрашивает статус **по id** (`GET /api/import/status?ids=`
    → `getJob`); список задания нужен только тому, кто импорт запустил. Таблица Postgres `import_job`
    **удалена** (`DROP TABLE IF EXISTS` в `schema.ts`; клиентов ещё не запускали — мигрировать нечего) →
    **ничего не копится** ни на сервере, ни в БД (`retentionSweep` её не чистит). `JobRedis` инъектируется
    (DI) — чистое ядро тестируется `createMemoryJobRedis`; прод — ioredis на том же `REDIS_URL`, что BullMQ;
    без Redis — in-memory фолбэк (single-instance). Финализация once-only (`claimJobNotify`, #164) —
    `HSETNX` (атомарно), но память ограничена TTL (см. JSDoc). **Дедуп отзыва — тоже на клиенте** (флаг
    `feedback` в той же записи `importHistory`), серверного поиска-перед-созданием больше нет.
    **Демо (`/api/demo/*`) на свой `demoJobStore`** — `import_job`/`jobStore` не трогает.
- `legacy/` — **старый проект** (backend/mcp/mcp-overlay/ui/b24-controller/prompts/scripts). Держим
  для порта удачных кусков; **новым тулингом не линтуется/не типизируется** (исключён в eslint/tsconfig).
- `docs/redesign/` — документация редизайна; `docs/*` — старые доки (справочно).
- **Альтернативный таргет деплоя — Битрикс24 Вайбкод Black Hole** (закрытый Bitrix-Cloud VM по REST,
  без SSH, приложение **одним Nitro-процессом на :3000**): [`docs/DEPLOY_VIBECODE.md`](docs/DEPLOY_VIBECODE.md).
  `deploy/vibecode-deploy.sh` (идемпотентный: найти сервер по имени / создать / ждать `CONNECTED` /
  `access-policy=PUBLIC` / deploy) + `.github/workflows/deploy-vibecode.yml` (**opt-in**: джоба идёт только
  при repo-переменной `VIBECODE_DEPLOY==true`, основной GHCR/Watchtower-путь не трогает; в Docker-образ не
  попадают). Порт из client-bank #319. Проверено локально: `pnpm build` (preset `node-server`) →
  `node .output/server/index.mjs` отдаёт **и лендинг, и in-portal, и `/api/*`** из одного процесса
  (`/`,`/app`,`/import`,`/settings`,`/metrics`,`/login`,`/queues`,`/install` GET **и POST** = 200,
  `/api/health` = ok; `/api/ready` у нас нет). pg/redis + OCR-тулчейн + `@anthropic-ai/claude-code`
  провижнятся на VM в `preStart`, миграции в процессе на старте. **Паритет безопасности без nginx —
  `APP_EDGE_SECURITY=1`** (`server/utils/edgeSecurity.ts` + `server/middleware/edgeSecurity.ts`): раз nginx
  нет, приложение само вешает его защиту — security-заголовки (CSP + `frame-ancestors` доменов Б24, nosniff,
  Referrer-Policy, HSTS; относительно `/b24-form.html` — расслабленный form-CSP) на **все** ответы и
  app-level анти-брутфорс на `/api/auth/login` (10/15мин по реальному IP пира `socket.remoteAddress`, т.к.
  без доверенного прокси XFF подделываем). CSP-строки байт-в-байт с `nginx.conf`. **За nginx флаг НЕ ставим**
  (дефолт off) — иначе двойной CSP (заголовки пересекаются рестриктивно) + троттл логина сгруппировал бы всех
  под IP прокси. Плюс **body-size backstop** (`edgeBodyGuard`/`EDGE_MAX_BODY_BYTES` 25 МБ = nginx
  `client_max_body_size`): middleware **глобально** (любой роут, включая публичный вебхук `/api/b24/events`)
  рубит заявленный `Content-Length` > кап → 413 и chunked-тело без длины → 411 **до** чтения тела; безтелые
  запросы не трогает. Буферящие всё тело роуты (`/api/demo/extract`, `/api/import/upload`) кап-чекают свой
  предел (`bodySizeStatus`). Служебная зона (`/api/ops/*`, `/api/queues`) **fail-closed** (nginx для неё не нужен); демо
  `/api/demo/*` держит собственный пер-IP лимитер (`demoRateLimit`) плюс глобальный `AI_MAX_CONCURRENCY`. ⚠
  `NUXT_PUBLIC_SITE_URL` пекётся на **build** (пререндер `/install`) — скрипт запекает его в `pnpm build` из
  `ENV_JSON`. Env под PUBLIC: `OPERATOR_PASSWORD`+`OPERATOR_SESSION_SECRET` (включают консоль), `ANTHROPIC_*`,
  `B24_TOKEN_ENC_KEY` (32 байта), `NUXT_PUBLIC_SITE_URL=<appUrl>`, **`APP_EDGE_SECURITY=1`**.

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # nuxt prepare + vue-tsc --build (Nuxt 4 split-tsconfig)
pnpm test         # Vitest (unit + nuxt)
pnpm test:unit    # только unit (чистое ядро)
pnpm generate     # SSG-сборка
pnpm check        # lint + typecheck + test

# Живые проверки (нужен .env.b24test/B24_HOOK + LLM-ключ ANTHROPIC_*):
pnpm sdk:smoke    # OAuth-транспорт SDK: profile+crm.item.list+burst 30 без QUERY_LIMIT_EXCEEDED
pnpm verify:agent # легаси-путь: spawn claude → DeepSeek (Anthropic-endpoint) → ExtractedDocument
pnpm verify:chat  # chat-движок (openai SDK): --provider deepseek|bitrixgpt → ExtractedDocument (ru/be/kk)
pnpm live:crm --ai# полный E2E: текст → DeepSeek → runCrmSync → сделка+позиции+уведомление+очистка
pnpm verify:idem  # идемпотентность: 2 прогона одним jobId → повтор нашёл по маркеру, created:false
pnpm loadtest:123 # доказательство rate-limiter (RestrictionManager)
```

## Конвенции

- Комментарии/JSDoc — английский; пользовательский текст и доки — русский.
- Чистые функции — `app/utils/*` (+ тесты), данные — `app/config/*`, типы — `app/types/*`.
  Реактивное — `app/composables/*`, UI — компоненты/страницы.
- Данные из API — только через `{{ }}` (auto-escape), без `v-html` с внешними данными.
- Каждый `.md` в корне и `docs/` несёт `> Last reviewed: YYYY-MM-DD` под H1.

## Workflow / Git

- **В `main` не пушим — только через PR.** Ветка сессии — из контекста. Мержит владелец
  (в этой сессии — по явному разрешению, если уверен, что не ломаешь).
- Живой тест-портал Б24 доступен через вебхук в env `B24_HOOK` (в репозиторий не коммитим).
  Скоупы: `crm, catalog, disk, im`. Проверять REST-факты вживую, а не по памяти.
- **Родственный репозиторий `bx-shef/client-bank-alfa-by` разрешён к чтению** (только чтение —
  правки/пуши туда не делаем) как источник платформенных паттернов для порта (события/токены/
  очереди). Трекер портов — issue #89; событийный механизм — #97. Разрешение владельца, 2026-07-14.

## Обратная связь (feedback-triage)

Разбор отзывов в чистый инженерный бэклог — портированный «feedback-triage kit» (PR #118).
**Статус:** триаж-сторона готова (доки + скрипты). **Ingestion-канал «сотрудник» — backend пересобран**
(#122, частично): чистое ядро `app/utils/feedback.ts` (санитизация Trojan-Source/`escapeHtml`/метки,
порт из legacy) + `server/utils/feedbackConfig.ts` (**fail-closed**, НЕ дефолтит на публичный код-репо) +
`server/utils/feedbackGithub.ts` (POST issue, не логирует токен/URL/тело) + роуты `server/api/feedback.post.ts`
(фрейм-токен, гейт на config → 503) / `feedback.get.ts` (`{enabled}` для показа виджета) + `GITHUB_FEEDBACK_*`
в `.env.example`. Тесты. **UI-виджет 👍/👎 — сделан** (`app/components/FeedbackWidget.vue` +
`useFeedback`: на строке результата `/app`, показ по `GET /api/feedback {enabled}`; 👍 шлёт сразу, 👎 сперва
просит комментарий; nuxt-тесты). **Контекст в отзыве — добавлен:** виджет прокидывает `jobId`/`fileName` строки
результата → `submit(kind, comment, context)` → `POST /api/feedback {context}` → `buildFeedbackIssue` рендерит
секцию «Контекст» (jobId/файл/сущность/ссылка/версия), **каждое поле stripHostileChars+escapeHtml+кап 300** (как
комментарий). Разрешено, т.к. репо-приёмник **приватный**; пустые поля — секция опускается целиком.
**Репо-приёмник — `bx-shef/ai-price-import-feedback`** (приватный, владелец).
**✅ Канал включён и live-verified end-to-end (2026-07-19):** `GITHUB_FEEDBACK_TOKEN` + `GITHUB_FEEDBACK_REPO`
настроены, сотрудник создал реальные отзывы **через приложение** — issue завелись в приёмнике (метки
`user-feedback`+`feedback:down`, контекст jobId/файл отрендерен инертно).

- [`docs/FEEDBACK.md`](docs/FEEDBACK.md) — **ingestion**: три канала #182 (сотрудник 👍/👎, агент
  `feedback[]`, MCP-матчинг) → issue в репо-приёмнике (`GITHUB_FEEDBACK_REPO`).
- [`docs/FEEDBACK_TRIAGE_AGENT.md`](docs/FEEDBACK_TRIAGE_AGENT.md) — **роль ИИ-агента триажа**:
  группирует по корню, заводит **обезличенные** issue в `bx-shef/ai-price-import`, закрывает
  разобранное со связкой. **Privacy-guard нагружен:** код-репо **публичный** (`private:false`) →
  клиентский контекст (jobId/файл/№ сделки/УНП) в issue не переносится, только ссылка на приватный отзыв.
- Скрипты — `scripts/feedback-triage.sh` (REST-fallback, `GH_WRITE_TOKEN`; токен через `curl --config`,
  не argv; privacy fail-closed `_assert_feedback_target`) + офлайн-валидатор `scripts/validate-docs.sh` /
  `.ps1`. Валидатор **CI-gated** через `tests/feedbackTriageValidate.test.ts` (спавнит `.sh`, ждёт exit 0
  → входит в `pnpm test`/`pnpm check`, без правки `ci.yml`).
- Репо-координаты — через ENV (`PROJECT_REPO`/`FEEDBACK_REPO`/`GITHUB_FEEDBACK_REPO`), не хардкод;
  `FEEDBACK_REPO` fail-closed (не дефолтится на публичный репо).

## GitHub API Rate Limits

Квоты раздельные: REST-core (5000 запросов/час) и GraphQL (5000 очков/час). MCP-инструменты записи/
поиска/листинга идут через GraphQL — батчить записи, не молотить list/search в цикле. Читать прямым
REST где можно. Помнить про secondary limits (≈80/мин, 500/час на контент-операции) → backoff с jitter.
