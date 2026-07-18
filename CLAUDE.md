# procure-ai (редизайн)

> Last reviewed: 2026-07-18

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
    **BullMQ** (там create идемпотентен — find-before-create по маркеру). Остаются: проактивный rate-throttle,
    адаптивный backoff, реактивный OAuth-рефреш (`setCallbackRefreshAuth` → персист `updateTokensOnRefresh`,
    UPDATE-only). **Live-верифицирован** на `bel.bitrix24.by` (`pnpm sdk:smoke`: profile+crm.item.list+burst 30
    без `QUERY_LIMIT_EXCEEDED`). `makePortalSdkCall` строит `B24OAuth` **на каждый resolver-вызов** (`need()` в
    джобе перечитывает токен) — мемоизация одного клиента на джобу (единый лимитер-бакет) трекается в **#123**;
    на процесс НЕ мемоизируем (иначе заклинит на устаревшем токене после ротации соседом/кроном). Ручной
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
    - **OAuth-refresh POST** (keep-alive крон `liveDeps`, кнопка reauth `portalReauth`) → `b24Sdk.sdkRefreshTransport()`
      через `B24OAuth.auth.refreshAuth()`: тот же refresh (POST `grant_type=refresh_token` на OAuth-сервер), но
      **секреты в теле POST** (старый код слал их в URL-query → утечка в access-логи), таймаут-гард (гонка —
      у SDK-axios рефреша нет таймаута), а вокруг остаётся `ensureFreshToken`: advisory-lock + re-read +
      UPDATE-only persist (#35). `rawTokenFromRefresh` (чистый маппер SDK-результат→raw JSON) тестируется.
    `b24Rest.ts` теперь несёт только чистые хелперы/контракт: тип `RestCall`, SSRF-гард `isSafeB24Domain`/
    `normaliseHost`, `B24RestError`, `isAuthRejection` (сырой `fetch`-транспорт `makeRestCall` + `unwrap`/`restUrl`
    удалены — SDK разворачивает `result` и строит URL сам; тип `FetchFn` остаётся для не-Б24 GitHub-POST `feedbackGithub`).
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
**Осталось для включения:** `GITHUB_FEEDBACK_TOKEN` (Issues R/W) + `GITHUB_FEEDBACK_REPO=bx-shef/ai-price-import-feedback`
в env прода; live-verify POST по включённому каналу.

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
