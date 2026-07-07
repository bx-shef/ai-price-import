# Целевая архитектура (редизайн procure-ai)

> Last reviewed: 2026-07-07

Как должно быть после редизайна. Синтез двух референсов: раскладка/дисциплина/лендинг/деплой —
из эталона `client-bank-alfa-by` (облачное приложение Маркета Б24); слой «изолированный MCP + агент
Claude Code» — из методологии репозитория `ai-agent` (`docs/09-tz/00_intake-ai/`, `docs/15-integrations/`).
Снимок «как есть» — [`00-legacy-architecture.md`](00-legacy-architecture.md); процесс/статусы —
[`01-project-map.md`](01-project-map.md).

**Ключевые решения (зафиксированы):** продукт — **облачное приложение для Маркета Bitrix24**
(мультитенант, OAuth на портал); **никакого кода для ядра/коробки Б24** — только MCP поверх
**стандартного REST API**; провайдер LLM — **DeepSeek** (провайдер-агностично); публичный лендинг — да.

---

## 1. Принципы

1. **Единое Nuxt-приложение (монолит).** Лендинг, in-portal UI и Nitro-backend — в одном репо
   и одном приложении, как `client-bank-alfa-by`. Один домен, nginx проксирует `/api/*` в backend.
2. **Облачное приложение Маркета, мультитенант.** Каждый портал ставит приложение → событие
   `ONAPPINSTALL` приносит OAuth-креды; токены хранятся per-portal (Postgres, refresh шифруется).
   Никакого «одного целевого портала через вебхук» — портал определяется токеном установившего.
3. **Только стандартный REST, ноль кода в ядре Б24.** Убираем PHP-модуль коробки и патчи ядра.
   Поиск/создание сущностей — штатными методами (`crm.*`, `catalog.*`) по OAuth-токену портала.
4. **Изолированный MCP (обязателен для AI-проектов).** Агент работает с **абстрактными**
   инструментами (`find_supplier`, `find_product`, `create_deal`) и не знает, что за ними физически
   (Bitrix24 REST сейчас, 1С — потом подменой транспорта). Backend не ходит в Bitrix24 REST из
   бизнес-логики напрямую — только через MCP. **Поиск договора в стандартное приложение не входит**
   (решение Q8) — это платная индивидуальная доработка на сервере клиента.
5. **Пер-портальная настройка маппинга.** Приложение generic → нельзя хардкодить инфоблоки/поля
   конкретного клиента. Настройки портала (`app.option` через server-side REST) задают: каталог(и),
   поле артикула, где хранится УНП (реквизит), как искать договор, воронку/стадию сделки, правила НДС.
   Чистое ядро маппинга — в `app/utils` с тестами (как матрицы/аллокатор в эталоне).
6. **Чистое ядро в `app/utils`, покрытое тестами.** Детерминированная логика (классификация,
   нормализация, homoglyph-folding, сборка payload сделки, распознавание идентификаторов) — чистые
   функции без I/O, юнит-тестируемые без Nuxt/БД/сети. I/O и реактивность — на краях.
7. **Тяжёлое — через очередь.** Извлечение текста, прогон агента, запись в CRM — джобы BullMQ+Redis,
   идемпотентные, с ретраями. Backend не держит состояние в памяти → масштабируется.
8. **Server-side REST по OAuth-токену портала.** Фрейм-SDK Б24 — только установка и UI-хром
   (`setTitle`/`fitWindow`). Данные/настройки — серверным REST по сохранённому токену.
9. **Безопасность.** Least-privilege allowlist агента, framing недоверенного документа, non-root
   контейнеры, magic-byte MIME, SSRF-allowlist, секреты вне argv/логов, шифрование refresh в покое.

---

## 2. Схема

```
Браузер (лендинг / B24 iframe) ──HTTPS──▶ nginx (:8080, unprivileged, CSP-hashing)
        │                                     │  /  → статика Nuxt (лендинг + in-portal UI)
        │                                     │  /api/* → backend:3000 (Nitro)
        ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ app (nginx + статика Nuxt generate)   │  backend (Nitro node-server)       │
  │  лендинг /                            │   server/api/* (upload, job, health,│
  │  in-portal /app /import /install ...  │     b24/events, queues, settings)   │
  │                                       │   server/queue/ (BullMQ producers)  │
  │                                       │   server/utils/ (pure, DI, tests)   │
  └───────────────────────────────────────────────┬───────────┬───────────────┘
                                                   │           │
                                          enqueue  │           │  writes
                                                   ▼           ▼
  ┌──────────────────────────┐        ┌────────────────────┐  ┌──────────────┐
  │ worker (BullMQ)          │        │ Redis (очереди)    │  │ Postgres     │
  │  file-extract → текст    │◀──────▶│ file-extract       │  │ OAuth-токены │
  │  agent-run   → Claude ───┼──MCP──▶│ agent-run          │  │ per-portal,  │
  │  crm-sync    → запись    │        │ crm-sync           │  │ дедуп, метрики│
  └──────────┬───────────────┘        └────────────────────┘  └──────────────┘
             │ MCP (Streamable HTTP, Bearer)
             ▼
     ┌────────────────────────────────────────────────┐
     │ MCP-сервер (изолированный, мультитенант)        │
     │  find_supplier / find_product(s) /              │
     │  create_deal                                    │
     │  └─ СТАНДАРТНЫЙ REST по OAuth-токену портала ───┼──▶ Bitrix24 (облако/коробка клиента)
     │     crm.* / catalog.* — без кода в ядре Б24     │    crm.company.list, crm.requisite.*,
     └────────────────────────────────────────────────┘    catalog.product.list, crm.deal.add,
                                                            crm.item.productrow.set, ...
```

Границы деплоя: `app` (статика+nginx), `backend` (Nitro), `worker` (в MVP совпадает с backend,
выносится под нагрузкой), `mcp` (наружу не публикуется), `redis`, `db` (Postgres). **PHP-модуля
коробки и патчей ядра больше нет.** Bitrix24 клиента — внешняя система, доступ только по OAuth-REST.

---

## 3. Раскладка репозитория (целевая)

```
app/                      # Nuxt (авто-импорт)
  pages/                  # /, /app, /import, /install, /settings, /metrics, /queues, /login
  layouts/                # landing.vue (тёмная бренд-оболочка), clear.vue (in-portal)
  components/             # UI; лендинг (HeroGraph, BriefForm, BusinessCardModal, AppInBitrixCard)
  composables/            # useB24, useAppSettings/useMapping, useMetrikaGoal, useUpload, useJobStatus
  utils/                  # ЧИСТОЕ ЯДРО + тесты: классификация, нормализация, homoglyph, распознавание
                          #   идентификаторов, сборка deal-payload по маппингу, landing.ts, b24Form
  config/                 # константы: b24.ts (scopes/события), дефолты маппинга
  types/                  # доменные типы: документ, позиция, поставщик, сделка, задача, маппинг портала
  middleware/ app.vue app.config.ts assets/css/main.css
server/                   # Nitro
  api/                    # upload, job/[id], health, b24/events, queues, ops, settings, auth
  utils/                  # pure DI-логика: tokenStore, secretCrypto, b24Oauth, ensureAccessToken,
                          #   portalRest, companyLookup, productLookup, dealWrite (договор — не ищем)
  queue/                  # topology, connection, producers, handlers, worker, cron, stats
  db/                     # client.ts (pg pool + schema: portal_tokens, job_dedup, metrics), плагины
  agent/                  # оркестрация Claude Code (spawn, MCP-конфиг, таймауты/ретраи, DeepSeek env)
  plugins/                # migrate, queue, envCheck
mcp/                      # изолированный MCP-сервер (первоклассный код + тесты)
  tools/                  # find-supplier, find-product(s), create-deal
                          #   (внутри — вызовы стандартного crm.*/catalog.* по per-portal токену)
prompts/                  # системный промпт агента
tests/                    # unit (node) + nuxt (happy-dom); eval-харнесс точности
public/  scripts/  docs/  nginx.conf  Dockerfile  docker-compose*.yml  .github/
```

**Каталога `b24-controller/` (PHP) в целевой раскладке нет** — вся интеграция ушла в MCP поверх
стандартного REST. Философия split'а (из эталона): `utils` — чистое; `composables` — реактивное;
`config` — данные; `types` — типы; `server/utils` + `server/queue/handlers` — чистые обработчики с DI
(`HandlerDeps`), живая проводка в `worker.ts`, фейки в тестах.

---

## 4. Потоки данных

**Импорт файла (happy path):**
1. `POST /api/upload` → сохранить файл, создать задачу (Postgres), `enqueue file-extract`.
2. `file-extract` (worker): pdftotext/OCR/office → `DOCUMENT_TEXT` → `enqueue agent-run`.
3. `agent-run` (worker): spawn Claude Code (DeepSeek) с промптом + `DOCUMENT_TEXT`; агент через MCP
   ищет поставщика и товары (стандартный REST по токену портала + маппинг), извлекает структуру
   позиций; результат → `enqueue crm-sync`. Договор не ищем (Q8).
4. `crm-sync` (worker): дедуп (персистентный стор) → `create_deal` через MCP → **стандартный REST**
   создаёт сделку, пишет позиции (`crm.item.productrow.set`, штатный НДС), прикрепляет файл, таймлайн;
   счётчики метрик.
5. UI поллит `GET /api/job/:id` → результат по файлу.

**Установка в портал (мультитенант):** `/install` → `init → app.info/scope/event.get →
event.bind(ONAPPINSTALL/ONAPPUNINSTALL → /api/b24/events) → installFinish`. Событие `ONAPPINSTALL`
на `/api/b24/events` приносит OAuth-креды → токены в Postgres (refresh шифруется). UF-поля/каталог —
не создаём молча: показываем чек-лист настройки и форму маппинга (`/settings`).

**События Б24:** `POST /api/b24/events` → верификация `application_token` (fail-closed) → очередь
`b24-events`; consumer — единственный писатель токенов. `ONAPPUNINSTALL` → чистим токены/дедуп портала.

**Запись в CRM (только стандартный REST через MCP):**
- Поставщик — `crm.company.list` + `crm.requisite.list`/`crm.requisite.bankdetail.list` по УНП
  (реквизит `RQ_INN`/`RQ_IIK`), поле берётся из маппинга портала.
- Договор — **не ищем** (решение Q8). Подбор договора — платная индивидуальная доработка на
  сервере клиента (маркетинговая фича, см. `04-marketing-landing.md`).
- Товар — `catalog.product.list` по свойству-артикулу (поле из маппинга); родительский товар.
- Сделка — `crm.deal.add` (воронка/стадия из маппинга) + `crm.item.productrow.set` (штатный НДС),
  `crm.timeline.comment.add`, прикрепление файла через стандартный REST.

---

## 5. Ключевые отличия от старого проекта

| Аспект | Старое | Целевое |
|---|---|---|
| Продукт | внутренний инструмент под 1 портал (вебхук-таргет) | облачное приложение Маркета, мультитенант |
| Доступ к Б24 | кастомный PHP-модуль `shef.purchase` + `procure*.php` | **только стандартный REST через MCP**, ноль кода в ядре |
| НДС | патч ядра `CCrmProductRow::SaveRows` | штатный `crm.item.productrow.set`, без патча |
| Привязка полей | хардкод инфоблоков (IBLOCK 15/32, RQ_INN) | пер-портальный маппинг в настройках |
| Токены | вебхук в env | OAuth per-portal (Postgres, refresh шифруется) |
| Форма | 2 образа (app+mcp) + отдельный UI | монолит Nuxt (лендинг+UI+Nitro) + mcp + worker |
| Состояние задач | in-process + Redis | очередь BullMQ, идемпотентные джобы |
| MCP | вендоренный git-subtree + overlay, тесты мимо | первоклассный MCP-пакет, тесты в общем прогоне |
| Лендинг/маркетинг | нет | тёмная оболочка, HeroGraph, BriefForm, Метрика, OG, листинг Маркета |
| Мёртвый код | бот, выключенный OAuth | бот выкинут; **OAuth оживает** (мультитенант) |

## 6. Что остаётся неизменным (сознательно)

- **Изолированный MCP** как единственная дверь в учётную систему.
- **Безопасность агента** (allowlist, framing недоверенного текста, non-root, magic-byte MIME).
- **Ядро извлечения текста** (pdftotext/OCR/office) и homoglyph-логика — переносим, чистим под тесты.

## 7. Требование точности: 1-в-1 со счётом

Позиции и цены в созданной сделке должны выходить **1-в-1 со счётом/накладной поставщика** —
без потерь строк, без искажения цен/количеств. Со штатным `crm.item.productrow.set` (без патча
ядра) бумажная цена мапится напрямую; НДС считается порталом штатно. **Eval-скоринг-харнесс не
используем** (решение D5) — фидельность проверяем ручными тест-накладными и юнит-тестами чистого
ядра сборки payload (детерминированная сверка вход→ожидаемый productrow).
