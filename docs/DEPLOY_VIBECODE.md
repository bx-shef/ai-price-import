# Деплой в Битрикс24 Вайбкод Black Hole (альтернативный таргет)

> Last reviewed: 2026-07-18

Как выгрузить это приложение (`procure-ai`, импорт прайсов) в **Битрикс24 Vibecode Black Hole** —
закрытый Bitrix-Cloud VM, управляемый по REST (без SSH), приложение слушает `:3000` и отдаётся по
HTTPS `https://app-{id}.vibecode.bitrix24.tech`.

> Это **альтернативный** таргет деплоя. Основной путь остаётся GHCR + Watchtower за общим
> nginx-proxy ([`09-deploy.md`](redesign/09-deploy.md)). Артефакты Black Hole
> (`deploy/vibecode-deploy.sh`, `.github/workflows/deploy-vibecode.yml`) **не мешают** основному:
> workflow **opt-in** (см. ниже), в Docker-образ они не попадают (`.dockerignore`).

## Что такое Black Hole (кратко)

- Одна чистая **Ubuntu VM** (root, исходящий интернет открыт, входящий — только через
  туннель платформы с авторизацией Битрикс24). Публичного IP/портов нет.
- **Нет managed-БД** — Postgres/Redis поднимаются на той же VM в `preStart`.
- Управление/деплой — **по REST** (`POST /v1/infra/servers/:id/deploy`), без SSH.
- **Бэкапы** — снимок диска (код+БД+файлы) в клик/по расписанию, переживает удаление сервера.
- **Авто-сон**: сервер засыпает после часа простоя (настраивается), первый запрос будит за 30–60 с.
- **Лимиты**: 3 сервера на API-ключ, 10 деплоев/мин на сервер. Обходятся **Галактиками** (много
  приложений на одном сервере) — но только для stateless-профиля (в контейнер Галактики свой
  Postgres не поставить, а нам нужен pg+redis+OCR-тулчейн → выделенный VM).
- **Биллинг**: вайбы (1 вайб = 1 ₽), RU-контур; хостинг-аккаунт — коммерческий облачный ru-Битрикс24
  с подпиской BitrixGPT + Маркетплейс. Есть demo RU/BY (14 дней, 1 сервер/портал, только `bc-micro`).
- **Обслуживаемый портал** (куда ставится само приложение) — **любой**: приложение ходит в него
  своим B24-OAuth, не через Gateway Вайбкода.
- 💡 **LLM по BYOK.** Агент ходит в свою модель по `ANTHROPIC_BASE_URL` (DeepSeek), поэтому вайбы за
  модели платформы **не** списываются — только за сам сервер. Встроенный AI Router не нужен.

## Выполнимость для нас — ПОДТВЕРЖДЕНА (важное)

Наш стек — stateful (Postgres + Redis + BullMQ) **плюс OCR-тулчейн и Claude Code CLI в рантайме**
(извлечение текста из PDF/скан/office + прогон агента), и в проде многоролевой (SSG-лендинг за nginx +
Nitro-backend отдельно). В Black Hole это схлопывается в **один Nitro-процесс на :3000**.

**Проверено локально** (`pnpm build` → `node .output/server/index.mjs`, один процесс, без pg/redis):
- `GET /api/health` → `{"status":"ok",…}`;
- `GET /` → 200 (пререндеренный лендинг, ~31 КБ);
- `GET /app` · `/import` · `/settings` · `/metrics` · `/login` · `/queues` · `/install` → 200 (пререндеренные страницы);
- **`POST /install` · `/app` · `/settings` → 200** — Nitro отдаёт пререндеренную страницу и на POST,
  поэтому опасения соседнего репо про «Bitrix открывает in-portal POST'ом → 405» **у нас не
  воспроизводятся** (у нас нет и не нужен 405→200 ремап; ⚠ всё же перепроверить в живом iframe).

Это работает, потому что `nuxt build` (**preset `node-server`**) + `nitro.prerender.routes` пекут
лендинг/страницы в `.output/public` и обслуживают их **тем же** node-сервером, что и серверные роуты.
Отдельный `nuxt generate` для Black Hole не нужен. Одна роль (дефолт single-container:
`QUEUE_WORKERS`/`QUEUE_CRON` не заданы ⇒ **оба ON**) — один процесс делает **всё**: HTTP + пререндер +
throughput-воркеры (extract/agent/crm-sync) + событийный воркер + keep-alive крон; **миграции** идут
в процессе на старте (`server/plugins/migrate.ts`, `RUN_MIGRATION` не трогаем).

> ⚠ У нас **только `/api/health`** (liveness) — **`/api/ready` НЕТ** (в отличие от соседнего репо).
> Health-проба на первом деплое — `appUrl/api/health`.

### ⚠ Что теряется без nginx — гейты перед боевым PUBLIC (честно)

В основном деплое nginx (`nginx.conf`) даёт защиту, которой в Black Hole нет (Nitro отдаёт всё сам).
У приложения **нет** `nitro.routeRules`/server-middleware, поэтому нижеперечисленное **теряется** и
не имеет Nitro-эквивалента сегодня — это гейты перед тем, как делать Black Hole основным таргетом:

1. **CSP** — политика страницы (`frame-ancestors` облачных доменов Б24 для iframe-встройки + `connect-src`)
   и отдельный CSP для `/b24-form.html` ставит nginx; в Nitro их нет. **Клик-джекинг-защита теряется**
   (сама iframe-встройка при отсутствии CSP не ломается — ограничение «кто может фреймить» просто
   пропадает). ⚠ CSP у нас **не** hash-based (в inline `window.__NUXT__` инъектятся рантайм-`NUXT_PUBLIC_*`,
   build-time sha256 не совпал бы) — при переносе в Nitro `routeRules` это учесть.
2. **Security-заголовки** — `X-Content-Type-Options: nosniff`, `Referrer-Policy` — тоже от nginx; в Nitro
   не выставляются. (`X-Frame-Options` намеренно не ставим — иначе ломается iframe; HSTS — на TLS-терминаторе.)
3. **Доверенный IP клиента теряется → пер-IP троттлы обходятся.** nginx подставлял реальный IP
   (`real_ip` из `X-Forwarded-For`, `real_ip_recursive off`); под PUBLIC без nginx клиент сам управляет
   `X-Forwarded-For`. Затронуты два пер-IP лимита:
   - **`/api/auth/login`** — `limit_req` по IP (антибрутфорс пароля оператора) обходится; в приложении
     остаётся только 400 мс задержки на неудачу.
   - **🔴 `/api/demo/extract`** (демо на лендинге, **неаутентифицированный**, гоняет реальный OCR+LLM на
     **токене владельца** `ANTHROPIC_*`) — его пер-IP лимит (3 файла/10 мин) обходится ротацией
     `X-Forwarded-For` → **неаутентифицированный расход OCR/LLM** (счёт/CPU-дрейн на `bc-micro`), ограничен
     лишь глобальным `AI_MAX_CONCURRENCY=2`. Это **дороже** login-троттла — перед боевым PUBLIC либо
     отключить демо-роуты (`/api/demo/*`), либо перенести IP-троттл на платформенный edge / доверять
     реальному peer.
4. **Body-size backstop** (`client_max_body_size` 25м / 6м на демо) — nginx-кап снят. В приложении есть свои
   пре-чеки (демо требует `Content-Length` → 411; `/api/import/upload` → 413 по заявленному размеру), но
   upload без `Content-Length` (chunked) пре-чек пропускает → потенциально буферит без границы (OOM на
   `bc-micro`). Frame-auth-gated (только member установленного портала) ⇒ риск низкий; учесть при переносе.

**Что НЕ теряется (уже прикрыто в приложении, nginx не нужен):**

- **Служебная зона — fail-CLOSED, а не fail-open.** `/api/ops/*` (`/api/ops/queues`, `/api/ops/tokens`,
  `/api/ops/tokens/refresh`) и `POST /api/auth/login` закрыты сессией оператора (`operatorAllowed`).
  **Пустой `OPERATOR_PASSWORD` ⇒ вход выключен (503), зона недостижима (401)** — не открыта. Поэтому
  задавать пароль нужно, чтобы **включить** консоль (`/queues`), а не чтобы «заткнуть дыру». Страницы
  `/login`/`/queues` — статические оболочки без секретов; реальный гард — 401 на `/api/ops/*`.
- **Диагностический `/api/queues`** — fail-CLOSED по `B24_APPLICATION_TOKEN` (заголовок `X-Check-Token`,
  `opsTokenOk`): токен пуст (норма) ⇒ 403 всем. nginx `deny all` для него не нужен.
- `/metrics` — **не** операторская зона: это in-portal страница под фрейм-токеном (`/api/import/metrics`,
  member-scoped), PUBLIC её данные не открывает.

Функционально приложение поднимается (лендинг + `/api` + in-portal из одного процесса — проверено).
Пункты 1–3 (CSP/заголовки/rate-limit) — **перед переводом Black Hole в основной таргет** перенести в
Nitro (`routeRules`/плагин) или на платформенный edge.

## Артефакты в репозитории

- **`deploy/vibecode-deploy.sh`** — идемпотентный деплой: находит сервер по `APP_NAME`, создаёт если
  нет, ждёт `running`+`CONNECTED` (таймаут-гард — в не-готовый сервер не деплоит), ставит
  `accessPolicy=PUBLIC`, деплоит (install → preStart → start на :3000). Тянет код из публичного
  `codeload`-архива (репо публичный → токен не нужен).
- **`.github/workflows/deploy-vibecode.yml`** — редеплой на push в `main` / вручную. **OPT-IN**:
  джоба идёт только когда repo-переменная `VIBECODE_DEPLOY == 'true'` — до этого мерж workflow **не**
  запускает деплой и **не** красит CI. `permissions: contents:read`, checkout запинен на SHA (конвенция #2).

## Разовая настройка репозитория

Settings → Secrets and variables → Actions:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `VIBE_KEY` | `vibe_api_...` (личный ключ, владеет сервером + биллингом) |
| Secret | `APP_ENV_JSON` | JSON рантайм-env (ниже) |
| Variable | `APP_NAME` | `ai-price-import` (имя сервера) |
| Variable | `PRESTART_CMD` | строка провижна pg+redis+OCR (ниже) |
| Variable | `VIBECODE_DEPLOY` | `true` — включатель workflow (opt-in) |

### `PRESTART_CMD` (провижн БД + OCR-тулчейн + агент, идемпотентно)

```bash
apt-get update && apt-get install -y --no-install-recommends \
  postgresql redis-server poppler-utils libreoffice-calc libreoffice-writer \
  tesseract-ocr tesseract-ocr-rus tesseract-ocr-bel tesseract-ocr-kaz fonts-dejavu-core && \
service postgresql start && service redis-server start && \
npm install -g @anthropic-ai/claude-code@2.1.207 && mkdir -p /root/.claude; \
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER app PASSWORD 'app';"; \
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='app'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE app OWNER app;"
```

> ⚠ `bc-micro` может не потянуть сборку LibreOffice/OCR по памяти — если `install`/`preStart` падает
> по OOM, бери план крупнее (это уже вне demo-доступа). Агент требует `@anthropic-ai/claude-code` в
> `PATH` (`AGENT_BIN=claude`), иначе пайплайн падает «spawn claude ENOENT»; `mkdir -p /root/.claude` +
> `HOME=/root` в start-команде — чтобы CLI-агент писал конфиг. **Идемпотентность:** роль и БД `app`
> проверяются **раздельно** (`pg_roles` / `pg_database`) — частичный первый прогон (роль есть, БД нет) не
> оставит приложение без базы. Предполагается чистая Ubuntu VM с root/`sudo`/`service` (если их нет —
> заменить на `su postgres -c …`/`pg_ctlcluster`).

### `APP_ENV_JSON` (рантайм-env; секрет)

```json
{
  "DATABASE_URL": "postgres://app:app@127.0.0.1:5432/app",
  "REDIS_URL": "redis://127.0.0.1:6379",
  "B24_CLIENT_ID": "...",
  "B24_CLIENT_SECRET": "...",
  "B24_TOKEN_ENC_KEY": "<openssl rand -base64 32 → декодируется в 32 байта>",
  "OPERATOR_PASSWORD": "<пароль оператора — включает консоль /queues>",
  "OPERATOR_SESSION_SECRET": "<openssl rand -hex 32>",
  "ANTHROPIC_BASE_URL": "https://<deepseek-endpoint>",
  "ANTHROPIC_AUTH_TOKEN": "<ключ модели>",
  "ANTHROPIC_MODEL": "<модель>",
  "NUXT_PUBLIC_SITE_URL": "https://app-XXXX.vibecode.bitrix24.tech",
  "B24_APPLICATION_TOKEN": ""
}
```

> **Обязательные на старте** (`envCheck` пишет в `errors`, но процесс не роняет): `B24_TOKEN_ENC_KEY`
> (**ровно 32 байта** после base64-декода) и `DATABASE_URL`. Без `B24_CLIENT_ID/SECRET` — рефреш токена и
> `app.option` не работают; без `REDIS_URL` — очередь выключена (загрузка отдаёт 503); без `ANTHROPIC_*` —
> агент не запускается. ⚠ **`NUXT_PUBLIC_SITE_URL` пекётся на BUILD-времени** — пререндеренный `/install`
> читает `config.public.siteUrl` из замороженного payload, рантайм-env его **не** переинжектит. Порядок:
> первый деплой создаёт сервер → узнаёшь `appUrl` → кладёшь его в `APP_ENV_JSON` → **передеплой**. Скрипт
> запекает `NUXT_PUBLIC_SITE_URL` из `ENV_JSON` прямо в `pnpm build` (`NUXT_PUBLIC_SITE_URL=<url> pnpm build`),
> поэтому абсолютный URL хендлера `/api/b24/events` попадёт в пререндер вне зависимости от того, прокидывает
> ли платформа deploy-`env` в install-шаг. Первый деплой изначально идёт с пустым `siteUrl` (ещё нет `appUrl`)
> — это нормально: `/install` заработает после передеплоя. `B24_APPLICATION_TOKEN` — **пустой**: он приходит
> в `ONAPPINSTALL` и пишется в **БД**
> (per-portal, write-once); `process.env` остаётся пустым, подпись событий проверяется по токену из БД.

## Первый деплой (проверить вручную)

API-вызовы против живого аккаунта не прогонялись — **первый деплой делаем руками** (по докам платформы
`vibecode.bitrix24.tech/llms-full.txt`). Кратко:

```bash
export VIBE_KEY="vibe_api_..."           # не коммитить
export BASE="https://vibecode.bitrix24.tech/v1"
alias vibe='curl -fsS -H "X-Api-Key: $VIBE_KEY"'

# 1. Доступ/зона (см. коды гейта ниже)
vibe "$BASE/me" | python3 -m json.tool | grep -iA3 servers
# 2. Дальше проще всего — скрипт (он делает create → wait → access-policy → deploy идемпотентно):
VIBE_KEY="$VIBE_KEY" APP_NAME=ai-price-import \
  SOURCE_URL="https://codeload.github.com/bx-shef/ai-price-import/tar.gz/$(git rev-parse HEAD)" \
  ENV_JSON="$(cat app-env.json)" PRESTART_CMD="$(cat prestart.sh)" \
  bash deploy/vibecode-deploy.sh
```

В первые 20 минут смотри: `GET /:id/logs` (старт Nitro/падения), открой `appUrl` → лендинг,
`appUrl/api/health` → `ok`. **Ключевая проверка:** открой `appUrl/install` → блок «Обработчик событий»
должен показать **абсолютный** URL (`https://app-…/api/b24/events`). Пусто/ошибка ⇒ `NUXT_PUBLIC_SITE_URL`
не был задан **на сборке** → положи `appUrl` в `APP_ENV_JSON` и **передеплой** (скрипт запечёт его в
`pnpm build`). Сделай снимок диска (`POST /:id/backups`).

### Коды гейта зоны (`POST /infra/servers` вернул ошибку)

| Код | Значит |
|---|---|
| `MARKETPLACE_REQUIRED` (402) | нет подписки BitrixGPT + Маркетплейс |
| `COMMERCIAL_PLAN_REQUIRED` (402) | бесплатный тариф без подписки |
| `TRIAL_PORTAL_LIMIT` (402) | demo RU/BY: 1 сервер на портал |
| `PLAN_NOT_ALLOWED_ON_TRIAL` (402) | на demo разрешён только `bc-micro` |
| `REGION_NOT_SUPPORTED` (403) | подписка недоступна в регионе портала |

## Уровень доступа = «Публичный» (обязательно)

`PATCH /v1/infra/servers/:id/access-policy` → `{"accessPolicy":"PUBLIC"}` (скрипт делает сам, но вызов
**мягкий** — точную сигнатуру эндпоинта проверить на первом живом прогоне; если упал — выставить руками
в кабинете). Нашему приложению нужен **Публичный**: оно принимает вебхук `POST /api/b24/events` (Bitrix
стучится извне) и открывается iframe'ом из чужого портала; первые 5 уровней проверяют личность через
Gateway Вайбкода (`X-Vibe-*`), которого мы не используем, — с ними вебхук/iframe срежутся.

⚠ «Публичный» открывает **сетевой доступ ко всем HTTP-эндпоинтам**. У нас служебная зона **fail-closed**
(см. «Что теряется без nginx»), CRM-данные — за фрейм-токеном/OAuth, диагностика — за
`B24_APPLICATION_TOKEN`. То есть PUBLIC открывает сеть, но не данные. Остаточная экспозиция под PUBLIC —
именно CSP/security-заголовки/login-rate-limit (их нет в Nitro), а не операторская зона.

## Связка с обслуживаемым порталом

Задеплоил → получил `appUrl` → в B24-приложении (в обслуживаемом портале) прописал обработчик и
redirect на `appUrl`, вебхук на `appUrl/api/b24/events` → переустановил приложение в портале
(прилетит `ONAPPINSTALL` с `application_token`).

## Когда это уместно (и когда нет)

- **Уместно**: клиент на облачном ru-Битрикс24 с подпиской, нужен in-portal сервис с **нулём
  администрирования** (нет SSH/обновлений ОС, HTTPS/встраивание/бэкапы из коробки, офбординг ключа).
- **Компромисс для нас**: stateful (pg+redis) **плюс тяжёлый OCR/LLM-тулчейн** → выделенный Black Hole
  VM (БД+тулчейн ставим сами, плотности Галактик нет); VPS-класс дешевле и без вайб-биллинга; оплата —
  ₽ через РФ-контур, не BYN.
- Полноценный паритет с nginx-деплоем (CSP/security-заголовки/rate-limit) — follow-up (см. выше).

## Compose-режим (запасной)

VM — обычная Ubuntu; можно поставить Docker и поднять наш `docker-compose.prod.yml`, туннель навести на
фронт-контейнер :3000. Это «Black Hole как VPS» — сохраняет текущую сборку (и nginx с CSP/rate-limit!),
но теряет смысл дыры. Делать только если единый Nitro почему-то не подходит (у нас — подходит, см. выше),
либо если паритет CSP/заголовков критичен раньше, чем их успеют перенести в Nitro.

## Источники

- Платформа: `https://vibecode.bitrix24.tech/llms-full.txt`, `/pricing`, `/blackhole`, `/blackhole/galaxy`.
- Гайд Битрикс24 (16.07.2026): `https://www.bitrix24.ru/journal/vaybkod-bitrix24-gayd-novichkov/`.
