# Целевая архитектура (редизайн procure-ai)

> Last reviewed: 2026-07-07

Как должно быть после редизайна. Синтез двух референсов: раскладка/дисциплина/лендинг/деплой —
из эталона `client-bank-alfa-by`; слой «изолированный MCP + агент Claude Code» — из методологии
репозитория `ai-agent` (`docs/09-tz/00_intake-ai/`, `docs/15-integrations/`). Снимок «как есть» —
[`00-legacy-architecture.md`](00-legacy-architecture.md); процесс/статусы — [`01-project-map.md`](01-project-map.md).

---

## 1. Принципы

1. **Единое Nuxt-приложение (монолит).** Лендинг, in-portal UI и Nitro-backend — в одном репо
   и одном приложении, как `client-bank-alfa-by`. Один домен, nginx проксирует `/api/*` в backend.
2. **Изолированный MCP (обязателен для AI-проектов).** Backend не ходит в Bitrix24 REST напрямую
   из бизнес-логики — только через MCP-инструменты. Агент работает с **абстрактными** инструментами
   (`find_supplier`, `find_contract`, `create_deal`) и не знает, какая система за ними физически.
   Это оставляет открытым пивот на 1С подменой транспорта MCP.
3. **Чистое ядро в `app/utils`, покрытое тестами.** Вся детерминированная логика (классификация,
   нормализация, homoglyph-folding, сборка полезной нагрузки сделки) — чистые функции без I/O,
   переносимые между фронтом и backend, юнит-тестируемые без Nuxt/БД/сети. I/O и реактивность —
   на краях (`composables`, `server/`, worker).
4. **Тяжёлое — через очередь.** Извлечение текста, прогон агента, запись в CRM — джобы BullMQ+Redis,
   идемпотентные, с ретраями. Backend не держит состояние в памяти процесса → масштабируется.
5. **Server-side REST по OAuth-токену портала.** Фрейм-SDK Б24 — только установка и UI-хром
   (`setTitle`/`fitWindow`). Данные/настройки — серверным REST по сохранённому токену.
6. **Безопасность как в старом проекте, но чище.** Least-privilege allowlist агента, framing
   недоверенного документа, non-root контейнеры, magic-byte MIME, SSRF-allowlist, секреты вне argv/логов.

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
  │  file-extract → текст    │◀──────▶│ file-extract       │  │ токены,      │
  │  agent-run   → Claude ───┼──MCP──▶│ agent-run          │  │ дедуп,       │
  │  crm-sync    → запись    │        │ crm-sync           │  │ метрики      │
  └──────────┬───────────────┘        └────────────────────┘  └──────────────┘
             │ MCP (Streamable HTTP, Bearer)
             ▼
     ┌────────────────────────────────────────┐
     │ MCP-сервер (изолированный)             │
     │  find_supplier / find_contract /       │
     │  find_product(s) / create_deal         │
     │  └─ REST-вебхук ──▶ Bitrix24 box       │
     └────────────────────────────────────────┘
                        │
              shef.purchase + procure*.php
              (+ НДС-патч ядра — по решению Q7)
```

Границы деплоя: `app` (статика+nginx), `backend` (Nitro), `worker` (может совпадать с backend
в MVP, выносится в отдельный контейнер под нагрузкой), `mcp` (наружу не публикуется), `redis`,
`db` (Postgres). Bitrix24-коробка — внешняя.

---

## 3. Раскладка репозитория (целевая)

```
app/                      # Nuxt (авто-импорт)
  pages/                  # /, /app, /import, /install, /metrics, /queues, /login
  layouts/                # landing.vue (тёмная бренд-оболочка), clear.vue (in-portal)
  components/             # UI; лендинг (HeroGraph, BriefForm, BusinessCardModal, промо)
  composables/            # useB24, useAppSettings, useMetrikaGoal, useUpload, useJobStatus
  utils/                  # ЧИСТОЕ ЯДРО + тесты: классификация, нормализация, homoglyph,
                          #   сборка deal-payload, landing.ts, build.ts, b24Events/b24Form
  config/                 # константы: b24.ts (scopes/события), catalog/поля
  types/                  # доменные типы: документ, позиция, сделка, задача
  middleware/ app.vue app.config.ts assets/css/main.css
server/                   # Nitro
  api/                    # upload, job/[id], health, b24/events, queues, ops, settings, auth
  utils/                  # pure DI-логика: tokenStore, crypto, b24Oauth, portalRest, lookups
  queue/                  # topology, connection, producers, handlers, worker, cron, stats
  db/                     # client.ts (pg pool + schema), плагины миграции
  agent/                  # оркестрация Claude Code (spawn, MCP-конфиг, таймауты/ретраи)
  plugins/                # migrate, queue, envCheck
mcp/                      # изолированный MCP-сервер (первоклассный код + тесты)
  tools/                  # find-supplier, find-contract, find-product(s), create-deal
b24-controller/           # PHP-контроллеры коробки (procure*.php) — переносим
prompts/                  # системный промпт агента
tests/                    # unit (node) + nuxt (happy-dom); eval-харнесс точности
public/  scripts/  docs/  nginx.conf  Dockerfile  docker-compose*.yml  .github/
```

Философия split'а (из эталона): `utils` — чистое; `composables` — реактивное; `config` — данные;
`types` — типы; `server/utils` + `server/queue/handlers` — чистые обработчики с DI (`HandlerDeps`),
живая проводка в `worker.ts`, фейки в тестах. Это даёт почти полное покрытие бизнес-логики без БД/сети.

---

## 4. Потоки данных

**Импорт файла (happy path):**
1. `POST /api/upload` → сохранить файл, создать задачу (Postgres/Redis), `enqueue file-extract`.
2. `file-extract` (worker): pdftotext/OCR/office → `DOCUMENT_TEXT` → `enqueue agent-run`.
3. `agent-run` (worker): spawn Claude Code с промптом + `DOCUMENT_TEXT`; агент через MCP ищет
   поставщика/договор/товары, извлекает структуру; результат → `enqueue crm-sync`.
4. `crm-sync` (worker): дедуп (персистентный стор) → `create_deal` через MCP → PHP-контроллер
   создаёт сделку, прикрепляет файл, пишет таймлайн; счётчики метрик.
5. UI поллит `GET /api/job/:id` → результат по файлу.

**Установка в портал:** `/install` → `init → app.info/scope/event.get → event.bind(ONAPPINSTALL/
ONAPPUNINSTALL → /api/b24/events) → installFinish` + авто-провижн UF-полей сделки (`ensureSchema`).

**События Б24:** `POST /api/b24/events` → верификация `application_token` (fail-closed) →
очередь `b24-events`; consumer — единственный писатель токенов (Postgres, refresh шифруется).

---

## 5. Ключевые отличия от старого проекта

| Аспект | Старое | Целевое |
|---|---|---|
| Форма | 2 образа (app+mcp) + отдельный UI-билд | монолит Nuxt (лендинг+UI+Nitro) + mcp + worker |
| Состояние задач | in-process + Redis, не масштабируется | очередь BullMQ, идемпотентные джобы |
| MCP | вендоренный git-subtree + overlay, тесты мимо `pnpm test` | первоклассный MCP-пакет, тесты в общем прогоне |
| Лендинг/маркетинг | нет | тёмная бренд-оболочка, HeroGraph, BriefForm, Метрика, OG |
| Хранилище | Redis | Postgres (токены/дедуп/метрики) + Redis (очереди) |
| Встройка | локальное приложение, вебхук-таргет | dual-mode, server-side REST по OAuth портала |
| Деплой | app CD на main, PHP на теге | multi-target Docker, CSP-hashing, GHCR+Watchtower |
| Мёртвый код | бот, OAuth-стор | выкинут/законсервирован |

## 6. Что остаётся неизменным (сознательно)

- **Изолированный MCP** как единственная дверь в учётную систему.
- **PHP-контроллеры коробки** (`procure*.php`) и контракт Node↔PHP (деплой на теге).
- **Безопасность агента** (allowlist, framing недоверенного текста, non-root, magic-byte MIME).
- **НДС-модель** — до решения Q7 (искать ли модель без патча ядра).
