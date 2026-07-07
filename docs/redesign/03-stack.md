# Стек технологий (редизайн procure-ai)

> Last reviewed: 2026-07-07

Целевой стек взят из эталона `client-bank-alfa-by` (проверенная на проде раскладка Bitrix24-приложения)
и дополнен слоем AI-агента из старого procure-ai. Версии — ориентир на момент фиксации; при инициализации
берём актуальные и пиним lockfile'ом. Где применимо — точные пакеты.

---

## 1. Фронтенд / приложение

| Что | Пакет / версия | Роль |
|---|---|---|
| Фреймворк | **Nuxt `^4.x`** | SSG (`nuxt generate`) для статики лендинга/UI + Nitro node-server (`nuxt build`) для backend |
| View | **Vue 3** (`<script setup lang="ts">`) | — |
| Язык | **TypeScript** (строгий), `vue-tsc --noEmit` | typecheck |
| Стили | **Tailwind CSS v4** (`@import "tailwindcss"`) | из `app/assets/css/main.css` |
| UI Kit | **`@bitrix24/b24ui-nuxt`** + **`@bitrix24/b24icons-vue`** | нативные компоненты Б24 |
| B24 SDK | **`@bitrix24/b24jssdk`** + **`@bitrix24/b24jssdk-nuxt`** | встройка в портал (dual-mode) |
| Утилиты | **`@vueuse/core`** + **`@vueuse/nuxt`** | реактивные хелперы |
| Шрифты | **`@fontsource/*`** (self-hosted) | без Google CDN (CSP) |
| Графики | **`echarts`** (tree-shaken, динамический импорт) | queue-monitor, метрики |
| QR | **`qrcode`** (динамический импорт, только мобилка) | визитка/промо |

Node **>=22**, менеджер пакетов **pnpm**, `"type": "module"`, `"private": true`, лицензия MIT.

## 2. Backend / инфраструктурные библиотеки

| Что | Пакет | Роль |
|---|---|---|
| Server | **Nitro** (в составе Nuxt), `server/` | API-роуты, плагины |
| БД | **`pg`** (+ `@types/pg`), ленивый `Pool` | Postgres: OAuth-токены per-portal, идемпотентность джоб, метрики |
| Очереди | **`bullmq`** поверх Redis | file-extract / agent-run / crm-sync |
| Крипто | `node:crypto` (AES-256-GCM) | шифрование refresh-токена в покое |
| Интеграция Б24 | **только стандартный REST** по OAuth (`crm.*`/`catalog.*`) | облачное приложение Маркета, мультитенант; **ноль кода в ядре/коробке Б24** |

## 3. AI-слой (из procure-ai)

| Что | Технология | Роль |
|---|---|---|
| Агент | **Claude Code CLI** (headless, `--print --bare --output-format json`) | извлечение структуры + вызов MCP |
| Провайдер | **DeepSeek** (Anthropic-совместимый endpoint) через `ANTHROPIC_*` env | решение Q5; см. заметку о юрисдикции ниже |
| Протокол инструментов | **MCP** (`@modelcontextprotocol/sdk`, Streamable HTTP, Bearer) | изолированный MCP-сервер |
| Извлечение текста | `poppler-utils` (pdftotext), `tesseract-ocr` (**rus+bel+kaz+eng**), python (`openpyxl`/`xlrd`/`python-docx`) | PDF/скан/офис → текст; языки — см. `06-multilingual.md` |
| Схемы | **`zod`** | валидация входов MCP-инструментов и вывода агента |

## 4. Тесты / тулинг

| Что | Пакет | Роль |
|---|---|---|
| Тест-раннер | **Vitest** — 2 проекта | `unit` (node, чистые утилиты) + `nuxt` (`@nuxt/test-utils` + `happy-dom`, компоненты/страницы) |
| Компоненты | `@vue/test-utils`, `mountSuspended` | in-portal и лендинг-страницы |
| Скриншоты | **`playwright`** (только скриншоты; CI не качает браузер) | визуальная верификация, OG |
| Линт | **ESLint** через `@nuxt/eslint` (flat config) | `commaDangle: 'never'`, `braceStyle: '1tbs'` |

Требование точности — позиции/цены **1-в-1 со счётом** (решение D5): проверяем ручными
тест-накладными + юнит-тестами чистого ядра сборки productrow, **без eval-скоринг-харнесса**.

## 5. Сборка / деплой

| Что | Технология | Роль |
|---|---|---|
| Контейнеры | **Docker multi-stage / multi-target** | `runner` (nginx-unprivileged + статика), `backend` (node:22-alpine + Nitro), `mcp`, `worker` |
| Веб-сервер | **`nginxinc/nginx-unprivileged`** (:8080) | статика + прокси `/api/*` → backend; CSP без `unsafe-inline` |
| CSP | `scripts/csp-hashes.mjs` (sha256 инлайн-скриптов на сборке) | строгий CSP + allowlist доменов Б24 |
| Реестр/CD | **GHCR + Watchtower** за общим nginx-proxy + acme (Let's Encrypt) | авто-pull `:latest` |
| CI | **GitHub Actions** — `ci` (install→prepare→lint→test→typecheck→generate) + `docker-build` + `deploy` | required-check `ci` |
| Зависимости | **Dependabot** (npm/actions/docker, группировка), сторонние actions пиним на SHA | supply-chain |
| Web-сессии | `.claude/` SessionStart-хук: `pnpm install` + `nuxi prepare` | lint/test/build с первого хода |

## 6. Команды (целевые, как в эталоне)

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # vue-tsc --noEmit
pnpm test         # Vitest (unit + nuxt); быстрый прогон: pnpm test --project unit
pnpm generate     # SSG-сборка (то же гоняет CI)
pnpm build        # Nitro node-server (backend-таргет)
```

Перед пушем — `pnpm check` (= lint + typecheck + test) или `bash scripts/check-app.sh`.

> **Юрисдикция LLM (DeepSeek = КНР).** Провайдер выбран DeepSeek. Данные документов (накладные,
> реквизиты поставщиков) уходят на инференс в юрисдикцию КНР — для NDA/152-ФЗ/коммерческой тайны
> нужно согласие заказчика и юриста (методология `ai-agent`, `docs/01-install/`). Технически слой
> сделан провайдер-агностично (`ANTHROPIC_*` env), поэтому смена на Anthropic/Bedrock/Vertex —
> замена переменных без правки кода. Извлечение текста и запись в CRM происходят локально; в LLM
> уходит только текст документа (бинарники — нет).

## 7. Конвенции (из эталона)

- Комментарии/JSDoc — **английский**; пользовательский текст и README — **русский**.
- Чистые функции — `app/utils/*`, данные/константы — `app/config/*`, типы — `app/types/*`; всё покрываем тестами.
  Реактивное — `app/composables/*`, UI — компоненты/страницы.
- Данные из API рендерим только через `{{ }}` (auto-escape); никакого `v-html` с внешними данными;
  внешний текст перед чатом/CRM нейтрализуем.
- Каждый `.md` в корне и `docs/` несёт `> Last reviewed: YYYY-MM-DD` блок-цитатой под H1
  (проверяется тестом; дату бампим при содержательном изменении).
- Definition of Done для UI: после правки — `pnpm generate && pnpm screenshot`, смотреть пиксели
  (mobile/desktop × light/dark), не доверять «собралось без ошибок».
