# Старый проект: архитектура procure-ai (as-is)

> Last reviewed: 2026-07-07

Документ фиксирует архитектуру **текущей** реализации (кодовое имя **procure-ai**,
папка репозитория `ai-price-import`) на момент старта редизайна. Это снимок «как есть»,
чтобы при переходе на новую архитектуру ничего не потерять и осознанно решить, что
переносим, что выкидываем, что переделываем. Дальнейшие документы серии `docs/redesign/`
описывают **целевую** архитектуру.

---

## 1. Что это и для кого

AI-импорт прайсов и накладных поставщиков в Bitrix24. Менеджер по закупкам не вбивает
накладную руками — он загружает файл (PDF, скан/фото, XLSX/XLS, DOCX), система распознаёт
поставщика, договор, позиции и цены и **создаёт сделку** в воронке «Закупки».

- **Заказчик:** ООО «Строительный Берег» (`postroyka.by`), прод-домен `purchase.postroyka.by`.
- **Репозиторий:** `postroyka/purchase-ai-chat`. Образы GHCR: `procure-ai-app`, `procure-ai-mcp`.
- **Пользователи:** менеджеры по закупкам (загрузка), операторы/владелец (метрики, точность),
  сисадмин (эксплуатация), программные клиенты (REST + Bearer).

### Сквозной поток

1. `POST /upload` (multipart) → backend кладёт файлы на volume `uploads`, создаёт задачу в Redis.
2. Backend извлекает текст на сервере: PDF-слой через `pdftotext`; сканы/фото через `tesseract`
   (rus+eng+bel); офисные файлы через python-хелпер `doc_to_text.py`.
3. Backend порождает подпроцесс **Claude Code CLI**, отдаёт системный промпт (`prompts/main.md`)
   + `DOCUMENT_TEXT` на stdin.
4. Агент извлекает структуру (УНП поставщика, договор, позиции, цены, валюта) и вызывает
   **MCP-инструменты** `b24_pst_crm_*` для поиска поставщика/договора/товаров и создания сделки.
5. MCP-инструменты дёргают **PHP REST-контроллеры** `shef:purchase.api.procure*` в живом модуле
   коробки `shef.purchase` — те создают сделку, прикрепляют исходный файл, пишут лог в таймлайн.
6. UI поллит `GET /job/:id/status` и показывает результат по каждому файлу (сделка создана /
   «Без сделки» + причина).

### Бизнес-правила, зашитые в поток

- Валюта только **BYN**; российские поставщики (ИНН/КПП) **отклоняются**.
- Цена — за единицу **без НДС**, фиксированная модель 20% НДС; единица всегда «шт».
- **Дедупликации нет** — сделка создаётся всегда. Не найден поставщик/договор — не блокирует
  создание сделки (только предупреждения).

Ядро парсинга **не знает про Bitrix24** — весь доступ к учётной системе идёт **только через MCP**.
Заявленная цель — добавить «1С: Управление торговлей» подменой только MCP-транспорта.

---

## 2. Компоненты (as-is)

Четыре слоя в **двух Docker-образах** + **Redis** + внешний **nginx-proxy**.

```
Браузер / B24 iframe ──HTTPS──▶ nginx-proxy + acme-companion (проект procure-proxy, proxy-net)
                                          │ VIRTUAL_HOST
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │ стек procure-ai (сеть procure-net)                                              │
  │                                                                                 │
  │  app (procure-app) :3000                                                        │
  │    Express backend ──отдаёт──▶ статику UI (Nuxt prerender в ui/public)          │
  │    ├─ spawn Claude Code CLI ── stdin: промпт + DOCUMENT_TEXT                    │
  │    │      └─ MCP over Streamable HTTP ──▶ mcp (внутр., http://mcp:3000/mcp)     │
  │    ├─ extract-text.js → pdftotext / tesseract / doc_to_text.py                  │
  │    └─ Redis (задачи, метрики, сессии, feedback-outbox, стор app-token)          │
  │                                                                                 │
  │  mcp (procure-mcp) :3000 (наружу НЕ публикуется)                                │
  │    Nuxt/Nitro MCP-сервер (вендоренный templates-mcp) + PST-overlay             │
  │    b24_pst_crm_find_supplier / find_contract / find_product(s) / create_deal    │
  │    └─ вебхук Bitrix24 ──▶ shef:purchase.api.procure*                            │
  │                                                                                 │
  │  redis (procure-redis)      watchtower (авто-pull :latest)                      │
  └───────────────────────────────────────────────────────────────────────────────┘
                                          │ REST-вебхук (scope crm)
                                 Bitrix24 box (b24.postroyka.by)
                                 модуль shef.purchase + procure*.php
                                 + кастомный патч ядра CCrmProductRow::SaveRows
```

Ключевой факт: целевой портал (куда создаются сделки) задаётся **вебхуком**
`NUXT_BITRIX24_WEBHOOK_URL`, а не тем порталом, который открыл UI.

---

## 3. Стек по слоям

| Слой | Runtime | Фреймворк / ключевые библиотеки |
|---|---|---|
| **backend** | Node.js 22 LTS, ESM, pnpm 11.5 | Express 5, `multer`, `ioredis`, `uuid`, `file-type`; тесты `vitest` + `supertest` |
| **извлечение текста** | Node + Python 3 | `poppler-utils` (pdftotext), `tesseract-ocr` (rus+eng+bel), `openpyxl`/`xlrd`/`python-docx`; лимит памяти через `prlimit` |
| **AI-агент** | Claude Code CLI (native, v2.1.168) | Anthropic API **или** DeepSeek (Anthropic-совместимый endpoint) через `ANTHROPIC_*`; промпт `prompts/main.md` |
| **mcp** | TypeScript, Nuxt 4 / Nitro | `@nuxtjs/mcp-toolkit`, `@modelcontextprotocol/sdk`, `@bitrix24/b24jssdk`, `better-sqlite3` (OAuth-стор, выключен), `zod`; вендор `bitrix24/templates-mcp` v0.3.0 |
| **mcp-overlay** | TypeScript | `defineMcpTool`, `zod` — 5 PST-инструментов + `rest-timing.ts` |
| **ui** | TypeScript, Vue 3 | Nuxt 4 SPA, `@bitrix24/b24ui-nuxt`, `@bitrix24/b24jssdk-nuxt`, `@nuxtjs/i18n` (19 локалей), `@unovis`, `@tanstack/vue-table`, Tailwind 4, `zod` |
| **b24-controller** | PHP (модуль Bitrix24) | `Bitrix\Main\Engine\Controller`, `CCrmDeal`/`CCrmCompany`/`CIBlockElement`; тесты PHPUnit |
| **infra** | Docker Compose | nginx-proxy + acme-companion, Redis 7, Watchtower 1.7.1 |

### AI-интеграция, детали

- Движок — **Claude Code CLI headless**, не прямой API-вызов. Backend порождает
  `claude --print --bare --output-format json` со **строгим allowlist** инструментов
  (только `Read` + 5 `b24_pst_crm_*`) и `--disallowedTools Bash,Write,Edit,...`.
- Промпт пишется в **stdin** (не argv) — иначе `E2BIG` на больших кириллических документах.
- **Защита от prompt-injection:** текст документа помечен недоверенным, после маркера
  `--- END DOCUMENT_TEXT ---` читаются системные поля.
- **Ретраи:** транзиентные ошибки провайдера (429/5xx/сеть) с экспоненциальным backoff+jitter;
  таймаут на попытку `AGENT_TIMEOUT_MS` (6 мин) в бюджете на файл `AGENT_FILE_BUDGET_MS` (12 мин).
- **Eval-харнесс** (`backend/eval/`, `mcp/tests/evals/`): точность извлечения на реальных
  накладных против `*.expected.json`, следит за критичным сигналом «направление НДС» (÷1.2 vs ×0.8).

---

## 4. Слои подробно

- **`backend/`** — Express REST + оркестрация агента. `index.js` (~1540 строк): `/upload`,
  `/job/:id/status|cancel|file-cancel`, `/health`, `/metrics/data`, `/login|logout|session|session/b24`,
  `/feedback`, `/b24/bot/event`, `/b24/app/event`, статика SPA. Модули: `agent-runner.js`
  (спавн CLI, MCP-конфиг, таймауты/бюджет/ретраи, извлечение JSON), `extract-text.js` +
  `doc_to_text.py`, `jobs-store.js` (Redis + восстановление зависших задач), `metrics.js`,
  `auth.js`, `feedback*.js` (каналы обратной связи через GitHub-issues), `b24-bot*.js`/`app-store.js`
  (чат-бот, **заморожен**), `nbrb-rate.js` (курс USD→BYN). 25 vitest-сьютов.
- **`mcp/`** — вендоренный MCP (upstream `bitrix24/templates-mcp` v0.3.0) через git subtree.
  Nuxt/Nitro, MCP по HTTP на `/mcp`. ~32 примерных инструмента **удаляются на сборке**. OAuth/DXT
  мульти-тенант присутствует, но **выключен** (`NUXT_BITRIX24_OAUTH_ENABLED=false`), только вебхук.
  Собственные `mcp/docs/*` описывают **upstream** и для procure-ai невалидны.
- **`mcp-overlay/`** — реальная поверхность интеграции: 5 инструментов (`find-supplier`,
  `find-contract`, `find-product`, `find-products` батч, `create-deal`) + `rest-timing.ts`.
  Имена `b24_pst_crm_*` (чтобы не пересекаться с upstream `b24_crm_*`). **Тесты overlay НЕ гоняются
  в `cd mcp && pnpm test`** — нужен отдельный `make test-overlay` (копирует их в `mcp/`).
- **`ui/`** — тонкий Nuxt SPA: `index.vue` (загрузка + отчёт), `install.vue`, `metrics.vue`.
  Composables `useApi/useAppAuth/useB24/useInstall/useMetrics/useFeedback`. i18n 19 локалей, `ru` по умолчанию.
- **`b24-controller/`** — PHP-контроллеры в живом модуле `shef.purchase`: `procuredeal.php`
  (создание сделки), `procuresupplier.php` (по УНП), `procurecontract.php`, `procureproduct.php`
  (по артикулу, single + батч), `procureinstall.php` (идемпотентный `ensureSchema` для UF-полей).
  `lib/config.php` — опции + homoglyph-folding. PHPUnit + `tests/stubs/bitrix.php`.
- **`prompts/main.md`** — системный промпт агента (305 строк): роль, безопасность, 5 шагов
  (извлечь → поставщик → договор → товары → сделка), бизнес-правила, JSON-схема вывода, телеметрия.
- **`scripts/`** — деплой, smoke/e2e-тесты, диагностика, `samples/` (эталонная накладная + expected).
- **`docs/`** — обширная русская документация (PROJECT_BRIEF, ROADMAP, гайды ролей, OPERATIONS,
  DIAGNOSTICS_POLICY, FEEDBACK, PARSING_PERFORMANCE, 1C_UT_INTEGRATION и др.).

---

## 5. Встройка в Bitrix24

- Ставится как **локальное приложение** (пункт левого меню). При первом открытии — страница
  установки (`ui/app/pages/install.vue`), подтверждение через `installFinish()`.
- **Авто-провижн UF-полей сделки** (#176): `/install` зовёт `procureinstall.ensureSchema` до
  `installFinish` — идемпотентно создаёт `UF_CRM_DEAL_SH_PRCHS_AI_FILE` (файл документа) и
  `UF_CRM_DEAL_DOGOVOR` (договор). Каталог/воронка/`RQ_INN` — не создаются молча, возвращаются чек-листом.
- **Iframe-совместимая авторизация:** HTTP Basic убран (ломал iframe); app-session cookie `pai_sess`
  (SameSite=None) + `X-PAI-Auth` CSRF; внутри Б24 — молчаливая авторизация через `/session/b24`,
  валидируется `app.info` против SSRF-allowlist `B24_FRAME_ANCESTORS`.
- **REST-контроллеры** регистрируются в модуле коробки → методы `shef:purchase.api.procure*`
  (разделитель `:` module:scope — с `.` будет `ERROR_METHOD_NOT_FOUND`). Зовутся обычным вебхуком.
- **Поиск:** поставщик по УНП в реквизите `RQ_INN` (страна=Беларусь), точное `=`, мин. ID; договор —
  инфоблок-список (IBLOCK 32), фильтр по клиенту/типу, номер/дата матчатся в PHP (homoglyph-tolerant);
  товар — IBLOCK 15, `PROPERTY_PURCHASE_ARTICLE` точное совпадение, родительский товар, мин. ID.
- **Homoglyph-обработка** (`lib/config.php`): операторы вводят артикулы/номера латиницей или кириллицей;
  `foldHomoglyphs()`/`homoglyphVariants()` нормализуют confusable-буквы (кап 64 варианта).

### НДС-модель (#326) — самая хрупкая связка

Портал в режиме «цены с НДС». Каждая строка пишет бумажную цену 1-в-1 в `PRICE_BRUTTO`,
`TAX_RATE=20`, `TAX_INCLUDED=Y`, прибивает `SUM = price×qty`, `TAX_SUM = SUM×20/120`.
Это **зависит от кастомного патча ядра заказчика** `CCrmProductRow::SaveRows` (уважает переданные
`SUM`/`TAX_SUM`). Патч — **в ядре Bitrix**, перезатирается при обновлении: надо ре-патчить, иначе
«Итого»/«НДС» в сделках опустеют.

---

## 6. Деплой / инфраструктура

- **Два образа** через GitHub Actions → GHCR: `procure-ai-app` (`Dockerfile.app`: backend + статика UI
  + Claude Code CLI + poppler/tesseract/python) и `procure-ai-mcp` (`Dockerfile.mcp`: Nuxt-сборка
  `mcp/` + overlay, примеры удалены).
- **Compose:** `docker-compose.prod.yml` (app, mcp, redis, watchtower) и `docker-compose.nginxproxy.yml`
  (nginx-proxy + acme) — намеренно изолированы. `docker-compose.eval.yml` — отдельный eval-стек на тест-портал.
- **Сеть:** только `app` в `proxy-net`; `mcp`/`redis` внутренние; MCP наружу не публикуется.
  Лимиты: app 768M/1CPU, mcp 512M/0.5CPU, `cap_drop: ALL`, `no-new-privileges`.
- **CD:** зелёный CI на `main` → `:latest` + `sha-<sha>`; **Watchtower** (~5 мин поллинг) пуллит
  `:latest`. Теги `v*` дают версионный образ (точка отката). `stop_grace_period: 13m` — дренаж задач.
- **PHP-контроллеры деплоятся отдельно** (`deploy-b24.yml`): **только на `v*`** (или вручную) через
  SSH/rsync только `procure*.php` + `config.php`, с бэкапом + `php -l` + авто-откатом. → **Изменения
  контракта Node↔PHP должны выезжать на теге**, иначе образы обгонят контроллеры.

---

## 7. Сильные стороны и техдолг

**Сильное:**

- Чистое разделение — ядро парсинга agnostic к учётной системе, всё знание про Б24 в `mcp-overlay/` +
  `b24-controller/`. Пивот на 1С-УТ — подмена транспорта.
- Безопасность агента — least-privilege allowlist, framing недоверенного документа, non-root
  контейнеры с лимитом памяти, защита от path-traversal/symlink в `create_deal`, magic-byte MIME,
  constant-time сравнения токенов, SSRF-allowlist, санитайз имён файлов, секреты вне argv/логов.
- Операционная зрелость — метрики за всё время, живой таймер, per-file feedback, durable outbox,
  восстановление зомби-задач, graceful-дренаж под Watchtower, REST-timing.
- Высокое покрытие тестами (backend 25 сьютов, overlay, MCP, UI, PHP) + eval-харнесс точности.

**Техдолг (явно назван в документации):**

- **Патч ядра Битрикса (#326)** — НДС-итоги зависят от правки `CCrmProductRow::SaveRows` в ядре,
  стирается обновлениями. Самая хрупкая связка.
- **Вендоренный MCP** — `mcp/` это git-subtree upstream; кастом в `mcp-overlay/` мёржится только на
  сборке; **overlay-тесты не в дефолтном `pnpm test`** (риск регрессий), нужен `make test-overlay`.
- **Рассинхрон деплоя Node↔PHP** — образы CD на `main`, PHP только на `v*`; контракт-изменение без тега → 500.
- **Backend в одном инстансе** — rate-limiter и счётчик задач в памяти процесса; масштабировать нельзя
  без выноса состояния в Redis/очередь. Очереди нет.
- **AuthZ на коробке не подтверждён** — префильтры REST и минимизация scope вебхука требуют проверки на живом боксе.
- **Чат-бот заморожен (#241)** — целая подсистема построена и убрана из установки; код лежит мёртвым.
- **OAuth/мульти-тенант — мёртвый код** — v0.3.0 OAuth/DXT отгружен, но выключен; `better-sqlite3` раздувает сборку.
- **Слабые места точности** — матчинг артикулов и детект RU/BY-поставщиков; в eval нет happy-path BYN-фикстуры.
- **Отложено** — конверсия единиц (всегда «шт»), дедупликация, точный per-file REST-timing.

---

## 8. Что это значит для редизайна

Коротко — что переносим/переделываем/выкидываем (детально — в `docs/redesign/01-project-map.md`
и `02-target-architecture.md`):

- **Переносим ценность:** промпт (`prompts/main.md`), 5 MCP-инструментов и их бизнес-логику,
  PHP-контроллеры коробки (`procure*.php`), ядро извлечения текста, eval-харнесс, homoglyph-логику.
- **Переделываем по эталону:** раскладку кода (pure `app/utils` + тесты), backend на Nitro c очередью
  (BullMQ+Redis вместо in-process состояния), деплой (multi-target Docker + CSP-hashing + GHCR/Watchtower),
  встройку в Б24 (dual-mode, server-side REST по OAuth), лендинг + маркетинг (отдельного лендинга сейчас нет).
- **Выкидываем/консервируем:** мёртвый чат-бот, выключенный OAuth-стор `better-sqlite3`, вендоренный
  `mcp/` как git-subtree (пересобрать overlay как первоклассный код с тестами в общем прогоне).
