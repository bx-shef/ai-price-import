# procure-ai (редизайн)

> Last reviewed: 2026-07-14

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

## GitHub API Rate Limits

Квоты раздельные: REST-core (5000 запросов/час) и GraphQL (5000 очков/час). MCP-инструменты записи/
поиска/листинга идут через GraphQL — батчить записи, не молотить list/search в цикле. Читать прямым
REST где можно. Помнить про secondary limits (≈80/мин, 500/час на контент-операции) → backoff с jitter.
