# procure-ai (редизайн)

> Last reviewed: 2026-07-31

AI-импорт прайсов с табличной частью в Bitrix24. Облачное приложение Маркета
(мультитенант, OAuth), издатель ИП Шевчик И.С. Вход — любой документ с таблицей
(накладная/счёт/КП/прайс), суть — найти контрагента и внести товары в целевую CRM-сущность.

> **Документация — три файла в `docs/`** (переработана 2026-07-29, было 40 файлов в двух папках):
> - [`docs/PROCESS.md`](docs/PROCESS.md) — как работает продукт от установки до записи в Битрикс24;
> - [`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md) — из чего состоит проект и что в каком состоянии
>   (сделано / проверено / отложено / блокеры);
> - [`docs/BACKLOG.md`](docs/BACKLOG.md) — фичи на будущее.
>
> Рядом три документа **для передачи наружу**, не внутренняя документация:
> [`docs/ui-spec.md`](docs/ui-spec.md) (дизайнеру), [`docs/privacy-policy.md`](docs/privacy-policy.md)
> (юристу и на публикацию) и [`docs/PRICING.md`](docs/PRICING.md) (модель заработка + калькулятор
> кастомной работы, #301). Этот `CLAUDE.md` — технические инварианты для работы с кодом; держим
> синхронно с тремя файлами выше.

## Раскладка

- `app/` — Nuxt (авто-импорт): `utils` (чистое ядро + тесты) / `composables` / `config` / `types` /
  `components` / `pages` / `layouts`.
- `server/` — Nitro backend: `api` / `routes` (не-`/api` публичные роуты) / `utils` (чистые с DI) /
  `queue` (BullMQ) / `db` / `plugins` / `agent`.
  - **SEO лендинга** (#292): share/SEO-мета живёт в `app/pages/index.vue`, **не** в корневом `app.vue` —
    корневой `useSeoMeta` применял маркетинговый OG лендинга к `/app`, `/settings`, `/queues`. `og:image`
    и `canonical` **обязаны быть абсолютными** (Facebook/LinkedIn выбрасывают относительные), а лендинг
    пререндерится ⇒ тег впекается в статический HTML на сборке и рантайм-env его уже не исправит. Поэтому
    база — `landing.siteBaseUrl`: `NUXT_PUBLIC_SITE_URL`, если это абсолютный URL (staging/Vibecode
    объявляют себя сами), иначе константа `LANDING_SITE_URL`; от наличия env корректность **не зависит**.
    База **разбирается `new URL`, а не проверяется регуляркой** — она попадает в строчный формат
    (robots.txt) и в разметку (`<loc>`), а префиксная проверка пропускала перевод строки (инъекция
    директив), `@` (userinfo-подмена → чужой домен в `canonical`) и query (og:image вёл на HTML-страницу);
    `.origin` заодно нормализует регистр. Планка — как у `isSafeB24Domain`. Гард — `RUN` в `Dockerfile`
    после `pnpm build`: относительный `og:image` роняет сборку (тег матчится **независимо от порядка
    атрибутов** — unhead их не сортирует).
    `/robots.txt` + `/sitemap.xml` — **роуты** (`server/routes/*.ts`), не статика в `public/`: обоим нужен
    абсолютный хост, который различается по деплою. Вся композиция «сырой env → проверенная база → тело»
    живёт в одной функции `seoFiles.crawlerFiles` — роуты без логики; иначе тесты хелпера и билдеров
    зелены, а шов между ними не покрыт (роут, передающий сырой `siteUrl` в билдер, возвращал инъекцию).
    **Без суффикса `.get`** — h3 не подменяет HEAD на GET, а краулерные инструменты ходят HEAD; плата за
    это — файл без суффикса отвечает на **любой** метод, поэтому `crawlerRoute.crawlerMethodGate`
    возвращает 405 с обязательным `Allow` (RFC 9110 §15.5.6) и 204 на OPTIONS.
    `siteUrl`/`buildDate` читаются в рантайме ⇒ обе переменные обязаны стоять и на **рантайм-стадии**
    образа (`ENV` не переходит через `FROM` — тот же капкан, что с `COMMIT_SHA`). ⚠ пустое присваивание
    в `env_file` перебивает `ENV` образа, поэтому запекаемые переменные в `.env.example` закомментированы.
    Служебные страницы (`/app`, `/settings`, `/metrics`, `/install`, `/import`, `/login`, `/queues`)
    несут `robots:noindex`, но в `robots.txt` **НЕ закрыты**: `Disallow` и `noindex` — альтернативы, а не
    слои. Заблокированную страницу краулер не читает ⇒ `noindex` не видит ⇒ URL может остаться в выдаче.
    Страницы пререндерятся и отдают 200 (`/app`, `/settings`, `/metrics` — пустое `ClientOnly`-тело,
    остальные — тонкий статический каркас), краулить дёшево, а `noindex` работает. В `DISALLOWED_PATHS`
    только `/api/` — там нет HTML, который нёс бы мету; `Disallow` матчит **по префиксу**, поэтому
    инертная статика под теми же префиксами краулима (закрывать — заголовком `X-Robots-Tag`).
    **Инвариант заявлен над страницами, а не над конфигом**: «индексируется только лендинг» — тест
    рекурсивно обходит `app/pages`, потому что пререндер в Nuxt включается четырьмя способами, а на
    `node-server` публична вообще каждая страница. Комментарии и `definePageMeta` вырезаются перед
    сопоставлением (закомментированный `useHead` тег не отдаёт), `property:` не принимается (краулеры
    читают `name=`), `robots:'none'` принимается. Гард утечки меты покрывает **все обёртки** — `app.vue`,
    `app/layouts/*`, `app.head` в `nuxt.config`. Дублирующая проверка — в `Dockerfile` **по готовому
    HTML**: там вопросы написания и механизма исчезают по построению. Статика вне `app/pages`
    (`public/b24-form.html`) гардом не видна — у неё свой `noindex` в самом файле.
  - **LLM-экстрактор — OpenAI-совместимый chat-вызов** (`server/agent/`, tool-less, чистый text→JSON,
    инъекция документа не может ничего кроме JSON; claude-code CLI удалён): `llmConfig.ts` (чистый
    резолвер `LLM_PROVIDER` → `{baseURL,apiKey,model}`: `deepseek`/`bitrixgpt`/`custom`, тесты) →
    `chatExtract.ts` (чистая оркестрация `runChatExtract`: `buildChatRequest` с
    `response_format:json_object`, ретрай через общий `retry.ts`, парс `extractJson` +
    `validateExtractedDocument` + гард `MAX_ITEMS`; DI — `ChatFn`, тесты) → `openaiChat.ts` (живой
    адаптер `makeChatFn` на `openai` SDK, `maxRetries:0` — ретрай наш; тонкий I/O-край, юнит-тестами
    не покрыт). **BitrixGPT** (Bitrix Vibecode AI Router `/v1`, `bitrix/bitrixgpt-5.5`; **дефолт** —
    AI Router — инференс в экосистеме Битрикс, уход от прямого зарубежного/КНР-инференса; **этим выбором снят
    юр-блокер облачного LLM**, #215) и **DeepSeek** (`/v1`, `deepseek-v4-flash`; быстрее, юрисдикция
    КНР) — один транспорт, оба переключаются `LLM_PROVIDER` (дефолт `bitrixgpt`). Живой прогон — `pnpm verify:chat --provider <p>` + E2E `pnpm live:crm
    --ai`. Резолв в `worker.ts buildLiveInfra` (и в демо `api/demo/extract.post.ts`); ключ живёт в самом
    процессе (нет подпроцесса) → санит-env не нужен. **Ключи по единой схеме:** deepseek — `DEEPSEEK_API_KEY`,
    bitrixgpt — `BITRIXGPT_API_KEY`/`VIBE_API_KEY` (легаси-фолбэк `ANTHROPIC_AUTH_TOKEN` удалён — прод на
    bitrixgpt/VIBE_API_KEY). Извлечение **live-verified** на реальных счетах РБ/РФ (PDF/скан/xls: тип, УНП/ИНН,
    позиции, НДС) + E2E на тест-портале (сделка+позиции).
  - **crm-sync — запись документа в сделку** (`queue/crmSyncCore.runCrmSync`, чистое ядро с DI, тесты;
    транспорты `crmWrite`/`companyLookup`/`productLookup`/`offerLookup`/`measureList`; проводка `liveDeps`).
    Ключевые правила (все **live-verified на `bel.bitrix24.by`** 2026-07-26, каждый прогон с очисткой):
    - **Цена/НДС/итог** (`app/utils/pricing.ts`): НДС считаем **построчно** (округление раз на строку:
      0,86×10000×20% = 10 320, не 10 300). `reconcilePricing` сверяет `priceIncludesVat` с печатным «Всего к
      оплате» **асимметрично** — правит флаг только в сторону «без НДС», НЕ флипает обратно (иначе «Итого»≡Σцена×кол
      роняет НДС). **Скидка** (отрицательная цена) вычитается из итога сделки (`lineGross` не клампит негативы;
      цена записанной строки остаётся ≥0 для B24, а `opportunity` — из сверенного итога). НДС=0 → «Без НДС»
      (`taxRate null`), негативная ставка → жёсткая ошибка. Толеранс сверки капнут.
    - **Подбор товара** (`productLookup.findProduct`): **приоритет торговых предложений (SKU/ТП)** —
      `offerLookup` (инфоблок ТП = каталог с `productIblockId`; `catalog.product.offer.list`, `iblockId`
      обязателен в filter И select; строка сделки принимает `offer.id` как `productId`), инфоблок ТП резолвится
      раз на джобу (fail-soft: нет каталога/подписки → фолбэк на товары). Затем базовый товар: свойство
      артикула (`%PROPERTY_<id>`+точная сверка) → **внешний код `XML_ID`** → имя. Всё **только `ACTIVE:'Y'`**.
      **Создание товара удалено** (`onMissing`: `skip-warn`/`freeform`).
    - **Единицы** (`measureList`): список через **`catalog.measure.list`** (не deprecated) + статическая карта
      `SYSTEM_MEASURE_RU` (код ОКЕИ/UNECE → рус. подпись+символ: 796=Штука/шт, 166=Килограмм/кг, 6=Метр/м, 112=Литр/л
      и т.д.) — `enrichMeasureRow` дозаполняет `null` русских подписей системных мер (их `catalog.measure.list`
      отдаёт без локализации), кастомные меры не трогает. Коды ОКЕИ/UNECE международные (одни для РФ/РБ/РК —
      см. `docs/PROCESS.md` §6.5); сопоставление единицы документа — по словарю, не по символу. **Встроенный словарь синонимов**
      (`app/config/unitSynonyms.ts` — данные, лукап в `app/utils/units.ts`) — слой ПОД словарём портала (#272):
      порядок `словарь портала (точный ключ → свёрнутый) → каталог мер портала по имени → встроенная карта →
      defaultCode`. Встроенный код **проверяется по каталогу портала** (`deps.measureCatalog`, мемо на джобу,
      `null` = каталог не прочитан → fail-open на встроенный код) — свежий портал везёт ~5 мер, запись
      отсутствующего кода дала бы молча неверную единицу. Свёртка ключа при поиске (`foldUnitForLookup`):
      внутренние точки/пробелы, `м²`→`м2`; латиница — только явными написаниями, авто-свёртки букв нет.
    - **Идемпотентность**: маркер `originId`+`originatorId` (сделка) / `xmlId` (инвойс/СП), `findExisting`-поиск
      в Б24 перед созданием; повтор одним `jobId` → `created:false`, дубля нет.
    - **Код владельца товарных строк** (`crmWrite.ownerTypeCode`): L/D/Q/SI для статичных типов, а для
      динамического СП — `T` + entityTypeId **в шестнадцатеричном виде** (`1120` → `T460`; live-verified:
      десятичный `T1120` → `ENTITY_TYPE_NOT_SUPPORTED` — тот же ответ, что у типа без товаров, поэтому баг
      маскировался под «клиент не настроил»). Live-проходы записи: сделка, смарт-инвойс (`pnpm live:crm
      --type счёт`), динамический СП с товарами (`--type акт`, `[TEST]`-тип etid 1120 оставлен на портале).
    - **Цель/роутинг**: удалённое направление → фолбэк на дефолт/сделку (`resolveValidTarget`, `crm.category.list`).
      **Лид на портале «без лидов»** (простой режим CRM, `crm.settings.mode.get`=2) авто-конвертится → crm-sync
      **редиректит лид в сделку** (`crmMode.ts` `fetchCrmMode`/`leadsEnabled`, мемо на джобу, fail-open) + warning.
      **Стадия лида** — одним шагом: поле lead-item `stageId` (crm_status, статусы `crm.status.list ENTITY_ID='STATUS'`),
      `stageEntityId(1)→'STATUS'`, `createTargetItem` кладёт `stageId` и лиду; категорию лиду не форвардим (⚠ приём
      стадии лида `add`-ом на **классическом** портале не переверифицирован — тест-портал в простом режиме).
      **UI в упрощённой CRM**: `GET /api/crm-mode` (`{leadsEnabled}`, фрейм-токен) + `useCrmMode` → TargetPicker (импорт)
      и `/settings` **скрывают вариант «Лид»** на портале без лидов (fail-open: по умолчанию показываем).
      **Режим открытия `/app`** (`app/utils/appLaunchMode.ts`, #262): базовый фрейм портала (прямая ссылка / пункт
      левого меню) — **пусковая страница**, она сама открывает главную слайдером (`APP_SLIDER_PLACE_MAIN='app-main'` →
      маршрут `/app`) и рабочий экран НЕ поднимает (иначе опрос статусов, метрики, настройки и pull крутились бы в двух
      фреймах); слайдер (по нашему `place` или `IFRAME=Y`), мобильное приложение и открытие вне портала — рабочий экран,
      как раньше. Страховка от бесконечного открытия — отметка в `sessionStorage` (ставится только на успехе);
      отказ открытия слайдера → уходим в рабочий экран, а не в тупик. Глобальный middleware маршрутизирует фрейм по
      `place` **один раз** (иначе фолбэк настроек/метрик отбрасывало обратно на `/app`).
      **Гейт настройки** (`/app`): пока `needsSetup` (дефолтные настройки) — показываем **только баннер** (не-админу «обратитесь
      к администратору», админу — кнопка «Настроить»), весь рабочий контент скрыт (`v-if="!needsSetup"`).
    - **Настраиваемое дело в таймлайне** (`configurableActivity.ts`+`liveDeps.writeActivity`, `crm.activity.configurable.add`,
      только OAuth-контекст): **модель «владелец + доп. привязки»** — у дела **один владелец** (`ownerTypeId`/
      `ownerId`, карточка, где оно физически живёт), всё остальное — **привязки** через `crm.activity.binding.add`
      (не второе дело). Владелец: **компания** (тип **4**), если контрагент найден по `RQ_INN`, + привязка к
      созданной сущности (сделка/лид/инвойс/СПА) → дело видно в **обоих** таймлайнах; **нет компании** → владелец —
      сама созданная сущность (привязывать нечего). Пишется **ровно одно** дело (раньше было два). Кнопка «Открыть»
      открывает созданную сущность (полезно из таймлайна компании); **владелец = сущность (нет компании) → кнопки нет**.
      В теле — счётчики + блок **«Проблемы (N):»** (warnings импорта). Кнопка «Исходный файл» ведёт на архивную копию
      на Диске **сконструированным** URL `/docs/file/<путь>?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER` (`disk.commonDiskFileUrl` —
      не API-`DETAIL_URL`, тот не открывал файл; сегменты `encodeURIComponent`+скобки). Внешние поля BB-нейтрализованы.
      Owner=компания + `binding.add` на configurable-деле **live-verified** (`binding.list` показывает обе привязки).
      Best-effort: сбой дела/привязки импорт не роняет.
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
  - **Попап «оцените приложение»** ([`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md)):
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
  - **Глубокая телеметрия — OpenTelemetry** ([`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md), вектор
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
    `auth_failed`/`forbidden`/`rate_limited`/`bad_request`/`conflict`/`unavailable`/`upstream_error`/`no_db`) + `portal.hash` (по
    домену) — тело запроса/ответа (маппинг/комментарий/файл/id заданий/названия чатов) в спан **не** кладётся.
    (Публичный вебхук `/api/b24/events` покрыт job-спаном очереди `b24-events`; **клиентские** pull/слайдер спанами
    не покрыты — серверная OTel, браузерного RUM нет.) **PII-защита тройная:** allowlist
    наших атрибутов (`telemetryAttributes.ts` `pickSafeAttributes` — поставщика/артикул/цену прикрепить
    нельзя) + redaction-SpanProcessor авто-атрибутов (SQL/URL/токены) + `portal.hash` (SHA-256) вместо
    member_id, `error_kind` вместо текста ошибки. Чистые ядра + тесты (`telemetryAttributes`/`telemetrySpan`)
    + parity-тест против inline-списка бутстрапа. **Слайс 2 — общая станция** (`telemetry-station/`:
    otel-collector-contrib + ClickHouse 72ч + Grafana, отдельный деплой, вне build-context/CI).
  - **Алертинг очередей + телеграм-канал** ([`docs/BACKLOG.md`](docs/BACKLOG.md) §1): на cron-инстансе
    раз в 5 минут `readQueueHealth` (`server/utils/queueHealthRead.ts`, DI над BullMQ `getJobs`/`getFailed`)
    → чистая `evaluateQueueHealth` (`queueAlert.ts`) → три вида тревоги: **`stalled`** (самая старая
    незакрытая задача старше `STALL_AGE_MS` 20 мин), **`failing`** (≥3 **наших** отказа за час, по меткам времени; порог
    низкий, потому что выборка узкая: отвергнутый документ в `failed` не попадает вовсе — `failJob`
    завершает задачу нормально; а отказ **портала** (`ACCESS_DENIED`, тип недоступен, нет токена) туда
    попадает, но отсеивается `isServiceFailure` — он детерминирован на портал, и счёт по нему привязал бы
    тревогу к числу криво настроенных клиентов, а не к нашему здоровью. Прежние «10 за 15 мин» были
    почти недостижимы для небольшого сервиса), **`unreadable`** (очередь не читается — отдельный вид, т.к. `queue/stats.ts` отвечает на
    мёртвый Redis нулями, и авария рисовалась бы пустой здоровой очередью). **Правила без состояния** —
    возраст задачи не зависит ни от ретеншена, ни от трафика, ни от предыдущего замера. ⚠ **две неверные
    версии до этой** (описаны в шапке `queueAlert.ts`, не повторять): дельта `completed`/`failed` между
    замерами — это размеры **урезанных** множеств (`removeOnComplete:1000`/`removeOnFail:5000`), дельта
    нулевая ровно когда всё работает; и порог по **размеру** хвоста (50+) — привязывал тревогу к объёму,
    мёртвый воркер `b24-events` не поймался бы никогда. Доставка — `queueAlertDeliver.ts` (чистые
    `planAlertDelivery`+`markAnnounced`: **одно сообщение на эпизод**, не на замер, + «восстановилось») →
    `telegramAlert.ts` (`sendMessage`, DI `FetchFn`, `parse_mode` НЕ ставим, кап 4096, `AbortSignal.timeout`
    10с, токен нигде не логируется — он в URL; `http.url`/`url.full` в OTel-redaction, спан-имя undici без
    URL). **Три гарда, каждый закрывает сломанное в первом варианте:** (1) **мерцание** — поломка на пороге
    срабатывает через замер = 24 сообщения в час; повтор запрещён `MIN_REANNOUNCE_MS` 1ч, а «восстановилось»
    шлётся только для эпизода из `awaitingRecovery` (о чьей поломке успели сказать); (2) **потеря** —
    `markAnnounced` вызывается **по факту доставки**, иначе один 429 хоронил тревогу навсегда (со следующего
    замера она «уже идущая»); (3) **зависание** — отправка идёт **после** снятия `healthRunning` и вне
    guarded-секции, иначе медленный Телеграм глушил бы саму проверку (зависший исходящий HTTP коррелирует с
    аварией, о которой сообщаем). Env `TELEGRAM_ALERT_BOT_TOKEN`+`TELEGRAM_ALERT_CHAT_ID`, **fail-closed**
    (наполовину настроенный молча терял бы тревоги). Состояние последнего вердикта для `/queues` —
    `queueAlertState.ts` (in-process; `checkedAtMs` отдаётся наружу, экран отличает «не проверяли» и
    «проверка отстала» от «всё хорошо»). **Разделение каналов:** телеметрия — графики/разбор, `/queues` —
    текущее состояние, телеграм — только «разбуди меня» (не дублировать!). ⚠ вживую не проверялось.
  - **Ограничение частоты загрузок** (`server/utils/uploadRateLimit.ts`, на `demoRateLimit.createRateLimiter`):
    `/api/import/upload` — 40 на **сотрудника** (`member_id|userId` из проверенного фрейм-токена) за 10 мин,
    иначе 429 + `retry-after` + `span.outcome='rate_limited'`. Нужно с тех пор, как отказ пишется админу в
    чат **на каждый** документ (#289): пачка негодных файлов = пачка сообщений в чужом чате. Ключ по
    сотруднику, а не по IP (портал — офис за одним адресом); портал без `userId` считается целиком
    (fail-closed). Лимит стоит **после** `queueEnabled()` и **до** чтения тела. Клиент: `classifyUploadError`
    → `UploadOutcome{ok,stop,message}`, `ImportStaging` на `stop` **останавливает пачку** и показывает текст
    сервера. ⚠ счёт **in-memory** — при размножении HTTP-роли переносить в Redis, иначе лимит фикция.
  - **Трекинг задания импорта — Redis+TTL, НЕ Postgres** (`utils/jobStore.ts` + `utils/jobStoreRedis.ts`):
    статус/мета каждого задания (`status`/`fileName`/`result`/`manualOverride`/`diskFile`/`notified`/`failNotified`/`uploaderId` — последний это id сотрудника из `profile` фрейм-токена, адрес личного чата для сообщения о неудаче; **в браузер не отдаётся**, `mapJob` его не читает)
    живёт в Redis-хеше `import:job:{member}:{jobId}` с native PX-expiry (TTL `IMPORT_JOB_TTL_HOURS`, дефолт
    48ч). **Серверного списка заданий НЕТ** (#B): браузер сотрудника держит свою историю в **localStorage**
    (`app/utils/importHistory.ts`, ключ `jobId`) и опрашивает статус **по id** (`POST /api/import/status {ids:[…]}` → `getJob`;
    **POST, не GET `?ids=`** — #260: список рос вместе с капом истории (50 UUID ≈ 1,9 КБ query) и упёрся
    бы в буфер заголовков прокси, плюс id утекали в access-логи, хотя в телеметрию мы их специально не
    кладём. Переполнение капа `MAX_IDS` больше не глушится молча — ответ несёт `truncated`);
    список задания нужен только тому, кто импорт запустил. Таблица Postgres `import_job`
    **удалена** (`DROP TABLE IF EXISTS` в `schema.ts`; клиентов ещё не запускали — мигрировать нечего) →
    **ничего не копится** ни на сервере, ни в БД (`retentionSweep` её не чистит). `JobRedis` инъектируется
    (DI) — чистое ядро тестируется `createMemoryJobRedis`; прод — ioredis на том же `REDIS_URL`, что BullMQ;
    без Redis — in-memory фолбэк (single-instance). Финализация once-only (`claimJobNotify`, #164) —
    `HSETNX` (атомарно), но память ограничена TTL (см. JSDoc). **Дедуп отзыва — тоже на клиенте** (флаг
    `feedback` в той же записи `importHistory`), серверного поиска-перед-созданием больше нет.
    **Демо (`/api/demo/*`) на свой `demoJobStore`** — `import_job`/`jobStore` не трогает.
- `prompts/` — **промпт извлечения** (`extract.ts`, `buildExtractionPrompt`): единственное место, где
  задаётся, что именно нейросеть должна вернуть. Используют и воркер (`queue/liveDeps.ts`), и демо
  (`api/demo/extract.post.ts`) — правка тут меняет поведение обоих.
- `telemetry-station/` — **отдельно деплоящаяся станция сбора телеметрии** (коллектор + ClickHouse +
  Grafana). Своя документация внутри, вне сборки приложения и вне CI.
- `legacy/` — **старый проект** (backend/mcp/mcp-overlay/ui/b24-controller/prompts/scripts). Держим
  для порта удачных кусков; **новым тулингом не линтуется/не типизируется** (исключён в eslint/tsconfig).
- `docs/` — вся документация: `PROCESS.md` / `PROJECT_MAP.md` / `BACKLOG.md` + три документа
  для передачи наружу (`ui-spec.md`, `privacy-policy.md`, `PRICING.md`). Старая россыпь из 40 файлов
  свёрнута 2026-07-29; удалённое доступно в истории git.
- **Альтернативный таргет деплоя — Битрикс24 Вайбкод Black Hole** (закрытый Bitrix-Cloud VM по REST,
  без SSH, приложение **одним Nitro-процессом на :3000**): [`docs/PROCESS.md`](docs/PROCESS.md).
  `deploy/vibecode-deploy.sh` (идемпотентный: найти сервер по имени / создать / ждать `CONNECTED` /
  `access-policy=PUBLIC` / deploy) + `.github/workflows/deploy-vibecode.yml` (**opt-in**: джоба идёт только
  при repo-переменной `VIBECODE_DEPLOY==true`, основной GHCR/Watchtower-путь не трогает; в Docker-образ не
  попадают). Порт из client-bank #319. Проверено локально: `pnpm build` (preset `node-server`) →
  `node .output/server/index.mjs` отдаёт **и лендинг, и in-portal, и `/api/*`** из одного процесса
  (`/`,`/app`,`/import`,`/settings`,`/metrics`,`/login`,`/queues`,`/install` GET **и POST** = 200,
  `/api/health` = ok; `/api/ready` у нас нет). pg/redis + OCR-тулчейн провижнятся на VM в `preStart`
  (LLM-вызов in-process, CLI-бинаря нет), миграции в процессе на старте. **Паритет безопасности без nginx —
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
  `NUXT_PUBLIC_SITE_URL` нужен **и на build** (пререндер `/install` + canonical/og лендинга), **и в рантайме**
  (`/robots.txt`, `/sitemap.xml` читают его на запрос) — скрипт запекает его в `pnpm build` из
  `ENV_JSON`. Env под PUBLIC: `OPERATOR_PASSWORD`+`OPERATOR_SESSION_SECRET` (включают консоль),
  `LLM_PROVIDER`+`DEEPSEEK_API_KEY`/`VIBE_API_KEY`, `B24_TOKEN_ENC_KEY` (32 байта),
  `NUXT_PUBLIC_SITE_URL=<appUrl>`, **`APP_EDGE_SECURITY=1`**.

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # nuxt prepare + vue-tsc --build (Nuxt 4 split-tsconfig)
pnpm test         # Vitest (unit + nuxt)
pnpm test:unit    # только unit (чистое ядро)
pnpm generate     # SSG-сборка
pnpm check        # lint + typecheck + test

# Живые проверки (нужен .env.b24test/B24_HOOK + LLM-ключ DEEPSEEK_API_KEY/VIBE_API_KEY):
pnpm sdk:smoke    # OAuth-транспорт SDK: profile+crm.item.list+burst 30 без QUERY_LIMIT_EXCEEDED
pnpm verify:chat  # экстрактор (openai SDK): --provider deepseek|bitrixgpt → ExtractedDocument (ru/be/kk)
pnpm live:crm --ai# полный E2E: текст → DeepSeek → runCrmSync → сделка+позиции+уведомление+очистка
pnpm verify:idem  # идемпотентность: 2 прогона одним jobId → повтор нашёл по маркеру, created:false
pnpm verify:332   # копия файла на Диске: запись → чтение байт → удаление (+--commit → репо отзывов)
pnpm loadtest:123 # доказательство rate-limiter (RestrictionManager)
pnpm loadtest:queue # очередь под нагрузкой (локальный Redis): backlog, дедуп, обрыв воркера,
                    # scale-out, приём под нагрузкой, реальный темп лимитера Б24 (~900 док/ч на портал)
                    # + ретраи (#267): падающий обработчик → ровно N попыток, растущая пауза,
                    # список неудачных с причиной, перемежающийся сбой сам себя лечит
```

## Конвенции

- **НЕ логировать** полный текст документа (`DOCUMENT_TEXT`) и секреты — ни в общие логи, ни в
  payload'ы очередей, ни в Postgres, ни в спаны телеметрии. Текст живёт в своём сторе и удаляется
  на терминальных стадиях; в очереди едет только ссылка на задание.
- **Документация — три файла** (`docs/PROCESS.md` / `PROJECT_MAP.md` / `BACKLOG.md`) плюс три
  материала для передачи наружу (`ui-spec.md`, `privacy-policy.md`, `PRICING.md`). Новые `.md` в `docs/` не
  заводим — дописываем в существующие; иначе за месяц снова получим россыпь (её сворачивали
  2026-07-29). Гвард — `tests/docsStructure.test.ts`.
- **Статусы в `PROJECT_MAP.md` — часть PR:** тронул подсистему — обнови её строку.
- Комментарии/JSDoc — английский; пользовательский текст и доки — русский.
- Чистые функции — `app/utils/*` (+ тесты), данные — `app/config/*`, типы — `app/types/*`.
  Реактивное — `app/composables/*`, UI — компоненты/страницы.
- Данные из API — только через `{{ }}` (auto-escape), без `v-html` с внешними данными.
- Каждый `.md` в корне и `docs/` несёт `> Last reviewed: YYYY-MM-DD` под H1.

## Workflow / Git

- **В `main` не пушим — только через PR.** Ветка сессии — из контекста. Мержит владелец
  (в этой сессии — по явному разрешению, если уверен, что не ломаешь).
- Живой тест-портал Б24 доступен через вебхук в env `B24_HOOK` (в репозиторий не коммитим).
  Скоупы **вебхука**: `crm, catalog, disk, im` (это НЕ scope приложения — у приложения ещё `pull`
  для real-time; см. `app/config/b24.ts` `B24_REQUIRED_SCOPES`). Проверять REST-факты вживую, а не по памяти.
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
`useFeedback`: на строке результата `/app`, показ по `GET /api/feedback {enabled}`; **обе оценки — одна и та же
форма** (#299): нажатие открывает комментарий + галочку «Приложить исходный файл» (по умолчанию снята), файл уходит
ТОЛЬКО по галочке одинаково для обеих; заголовок задачи один — `[🟢]`/`[🔴] Отзыв сотрудника`; кнопки — иконки
b24icons `LikeIcon`/`DislikeIcon`, не эмодзи; nuxt-тесты). **Контекст в отзыве — добавлен:** виджет прокидывает `jobId`/`fileName` строки
результата → `submit(kind, comment, context)` → `POST /api/feedback {context}` → `buildFeedbackIssue` рендерит
секцию «Контекст» (jobId/файл/сущность/ссылка/версия), **каждое поле stripHostileChars+escapeHtml+кап 300** (как
комментарий). Разрешено, т.к. репо-приёмник **приватный**; пустые поля — секция опускается целиком.
**Репо-приёмник — `bx-shef/ai-price-import-feedback`** (приватный, владелец).
**✅ Канал включён и live-verified end-to-end (2026-07-19):** `GITHUB_FEEDBACK_TOKEN` + `GITHUB_FEEDBACK_REPO`
настроены, сотрудник создал реальные отзывы **через приложение** — issue завелись в приёмнике (метки
`user-feedback`+`feedback:down`, контекст jobId/файл отрендерен инертно).

- [`docs/BACKLOG.md`](docs/BACKLOG.md) §«Как сюда попадают строки» — **каналы отзыва**: три канала #182 (сотрудник 👍/👎, агент
  `feedback[]`, MCP-матчинг) → issue в репо-приёмнике (`GITHUB_FEEDBACK_REPO`).
- [`docs/BACKLOG.md`](docs/BACKLOG.md) §«Privacy-guard» + §«Как идёт разбор» — **роль ИИ-агента триажа**:
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
