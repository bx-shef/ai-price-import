# procure-ai (редизайн)

> Last reviewed: 2026-07-15

AI-импорт документов с табличной частью в Bitrix24. Облачное приложение Маркета
(мультитенант, OAuth), издатель ИП Шевчик И.С. Вход — любой документ с таблицей
(накладная/счёт/КП/прайс), суть — найти контрагента и внести товары в целевую CRM-сущность.

> **Идёт редизайн.** Полное описание проекта, процесса, архитектуры, стека и решений —
> в [`docs/redesign/`](docs/redesign/README.md) (00 старая арх. → 01 карта → 02 целевая арх. →
> 03 стек → 04 маркетинг → 05 политика данных → 06 мультиязычность → 07 план тестирования →
> 08 демо на лендинге → 09 деплой → 10 чек-лист проверок → 11 тарифы/self-hosted). Держим их синхронно.

## Раскладка

- `app/` — Nuxt (авто-импорт): `utils` (чистое ядро + тесты) / `composables` / `config` / `types` /
  `components` / `pages` / `layouts`.
- `server/` — Nitro backend: `api` / `utils` (чистые с DI) / `queue` (BullMQ) / `db` / `plugins` / `agent`.
  - **Событие install/uninstall — через очередь** `b24-events` (порт из client-bank): роут
    `api/b24/events.post.ts` верифицирует и **кладёт в очередь**, консьюмер (`queue/handlers.handleEventJob`)
    — **единственный писатель** `portal_tokens`; при недоступности Redis роут пишет **синхронным
    фолбэком** (B24 online-события не ретраит). Порядок событий защищает **тумбстоун** `portal_tombstone`
    (#77): stale/out-of-order install не воскрешает удалённый портал (гард в `tokenStore.saveToken/deletePortal`
    по `eventTs` = top-level `ts` вебхука). Тумбстоун неатомарен, но TOCTOU-free — событийный воркер
    **single-instance**.
  - **Роль-сплит воркеров** (`queue/runtime.ts`, scale-out): роли `QUEUE_WORKERS`/`QUEUE_CRON`.
    `startEventWorker` (события) идёт **только на primary/cron-инстансе**; `startThroughputWorkers`
    (extract/agent/crm-sync) масштабируется на N реплик (`worker`-контейнер, `QUEUE_CRON=0`). Гейтинг — в
    `plugins/queue.ts`. Per-queue concurrency — отдельно (`QUEUE_EXTRACT/AGENT/CRM_CONCURRENCY`,
    `worker.queueConcurrency`, #95).
  - **Рефреш OAuth-токена сериализован per-portal** (`utils/dbLock.withAdvisoryLock`, `ensureAccessToken`,
    #35): advisory-lock + re-read внутри лока → портал рефрешится ровно раз, без гонки на ротации
    refresh-token. Персист — `updateTokensOnRefresh` (UPDATE-only, не воскрешает удалённый портал); строка
    исчезла под локом ⇒ рефреш не делаем. Рефреш-POST ограничен таймаутом (`AbortSignal`), чтобы зависший
    OAuth не запинил лок + соединение пула. **Область**: этот путь — у **keep-alive крона** (`ensureFreshToken`,
    single-instance) и синхронных frame-token API-роутов. **crm-sync hot-path им НЕ ходит** — там транспорт
    `@bitrix24/b24jssdk` рефрешит **реактивно** (свой per-job `B24OAuth`, `setCallbackRefreshAuth`→персист),
    без advisory-лока: при scale-out throughput-воркеры могут ротануть один портал параллельно, но персист
    UPDATE-only идемпотентен, а SDK-лимитер гасит всплеск — гонка безопасна, лишь возможен лишний рефреш.
  - **REST-транспорт к порталу (crm-sync) — `@bitrix24/b24jssdk`, единственный** (`utils/b24Sdk.ts`,
    адаптер `B24OAuth`→`RestCall`): у SDK встроенный **RestrictionManager** (пер-портальный leaky-bucket
    лимитер + auto-retry на `QUERY_LIMIT_EXCEEDED`/429/5xx) — решает REST-бюджет при scale-out. Один
    `B24OAuth` на портал на джобу = пер-портальный лимит + bind-once; рефреш SDK сам,
    `setCallbackRefreshAuth` → персист (`updateTokensOnRefresh`, UPDATE-only). **Live-верифицирован**
    на `bel.bitrix24.by` (`pnpm sdk:smoke`: profile+crm.item.list+burst 30 без `QUERY_LIMIT_EXCEEDED`,
    лимитер троттлит ~12 req/s). SDK-путь строится **per-job** (не мемоизируется, иначе заклинит на
    устаревшем токене после ротации соседом/кроном). Ручной `makePortalRestCall` удалён; синхронные
    frame-token API-роуты (`settings`/`catalog-properties`) остаются на `b24Rest.makeRestCall` (другой
    механизм — фрейм-access-токен, не OAuth). Чистые мапперы +
    `makeSdkRestCall` тестируются фейком; типизация `new B24OAuth` как `OAuthCallClient` — compile-time
    drift-guard (typecheck ловит дрейф API SDK). Для Bitrix24-вызовов в новом коде — предпочитать SDK.
  - **Пагинация enumerate-all списков** (`utils/restPaginate.fetchAllPages`, #87): find-one lookup'ы
    (`findCompanyByTaxId`/`findProduct`) берут первый id и в пагинации не нуждаются, но три **enumerate-all**
    чтения молча обрезались на дефолтной странице B24 (50). RestCall отдаёт **unwrapped** `result` (envelope
    `next`/`total` не виден), поэтому `fetchAllPages` листает по `start`-оффсету и стопается на короткой/пустой
    странице; кап `MAX_PAGES=200` не молчит (`console.warn`). Подключены `fetchVatRates` (`crm.vat.list`) и
    `searchCatalogProperties` (`catalog.productProperty.list`). `fetchCurrencies` (`crm.currency.list`) **НЕ**
    паджинируется намеренно — метод отдаёт все валюты за один вызов (`total:0`, игнорит `start`; live+docs).
  - **Keep-alive рефреш токенов** (`utils/tokenKeepAlive.runTokenKeepAlive`, #175): на cron-инстансе
    суточный крон рефрешит **только** порталы у истечения (`selectTokensNearExpiry` по `updated_at`,
    порог ~3 д, батч-кап 50) — иначе простаивающий портал теряет refresh_token на 180-й день. Гейт на
    `B24_CLIENT_ID/SECRET`, каденция `TOKEN_KEEPALIVE_HOURS` (дефолт 24, кламп [1h,168h]).
- `legacy/` — **старый проект** (backend/mcp/mcp-overlay/ui/b24-controller/prompts/scripts). Держим
  для порта удачных кусков; **новым тулингом не линтуется/не типизируется** (исключён в eslint/tsconfig).
- `docs/redesign/` — документация редизайна; `docs/*` — старые доки (справочно).

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # nuxt prepare + vue-tsc --build (Nuxt 4 split-tsconfig)
pnpm test         # Vitest (unit + nuxt)
pnpm test:unit    # только unit (чистое ядро)
pnpm generate     # SSG-сборка
pnpm check        # lint + typecheck + test
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
  Скоупы: `crm, catalog, disk, im, placement`. Проверять REST-факты вживую, а не по памяти.
- **Родственный репозиторий `bx-shef/client-bank-alfa-by` разрешён к чтению** (только чтение —
  правки/пуши туда не делаем) как источник платформенных паттернов для порта (события/токены/
  очереди). Трекер портов — issue #89; событийный механизм — #97. Разрешение владельца, 2026-07-14.

## Обратная связь (feedback-triage)

Разбор отзывов в чистый инженерный бэклог — портированный «feedback-triage kit» (PR #118).
**Статус:** триаж-сторона готова (доки + скрипты); ingestion-канал в редизайне ещё не пересобран
(legacy `legacy/backend/feedback.js`; `.env.example` без `GITHUB_FEEDBACK_*`) — #122.

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
