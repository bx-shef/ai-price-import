# Деплой (редизайн procure-ai)

> Last reviewed: 2026-07-14

Как развернуть облачное приложение (лендинг + in-portal UI + backend-пайплайн) в проде.
Схема — как у эталона `client-bank-alfa-by`: **GHCR-образ + Watchtower за общим nginx-proxy**,
Postgres и Redis рядом. Один домен: nginx проксирует `/api/*` в backend.

## Состав

Один Nitro-образ (`Dockerfile`, target `backend`) отдаёт **и** пререндеренные страницы
(лендинг, `/app`, `/import`, `/settings`, `/login`, `/queues`) **и** API/пайплайн. Рядом:
- **Postgres** — токены порталов, задачи, извлечённый текст/структура, метрики (миграции идемпотентны, на старте).
- **Redis** — очереди BullMQ (`b24-events`/`file-extract`/`agent-run`/`crm-sync`). Без него пайплайн выключен, загрузка отдаёт 503.
- Бинарники извлечения — **в образе** (`poppler-utils`, `libreoffice`, `tesseract-ocr` + `rus/bel/kaz`).
- **Агент-экстрактор** (`AGENT_BIN=claude`) — CLI `@anthropic-ai/claude-code` **в образе** (глобально);
  гоняется против DeepSeek по `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`. Без него пайплайн падает
  «spawn claude ENOENT». `HOME` задан (`/root`) — Claude Code пишет конфиг в `$HOME/.claude`.

## Сборка и запуск

- **Локально:** `cp .env.example .env` → заполнить → `make build-local` (`docker compose up --build`).
  Backend на `:3000`. Гейт перед пушем — `make check`.
- **Прод:** домен **`price-import.bx-shef.by`** за общим `nginx-proxy` + `acme-companion` (сеть
  `proxy-net`, как `currency-converter`). CI `deploy.yml` (workflow_run после зелёного `ci`) собирает
  и пушит в **GHCR два образа** (matrix `backend`+`app`): `ghcr.io/bx-shef/procure-ai` (Nitro:
  страницы+API+пайплайн) и `ghcr.io/bx-shef/procure-ai-app` (фронт-nginx: proxy/limit_req/CSP).
  `docker-compose.prod.yml` поднимает `app`+`backend`+`db`+`redis` (воркеры пайплайна — in-process в
  backend; сети `dbnet`/`queuenet` `internal:true` изолируют БД/Redis); **Watchtower** авто-обновляет
  образы с меткой `com.centurylinklabs.watchtower.enable=true`. `ci.yml` валидирует сборку **обоих**
  образов на каждом PR (docker-build matrix; app-стадия гоняет `nginx -t`).

  **Файлы деплоя** (обёртки — `Makefile`, цели ниже):
  - `docker-compose.prod.yml` — стек приложения (`make prod-up` / `prod-redeploy` / `logs` / `ps`).
  - `docker-compose.server.yml` — **общий** reverse-proxy `nginx-proxy`+`acme-companion` (`make server-up`).
  - `docker-compose.watchtower.yml` — **общий** Watchtower авто-апдейта (`make watchtower-up`).
  - `docker-compose.yml` — локальная сборка/дев.

  ⚠️ `server.yml` и `watchtower.yml` — инфраструктура **одна на ХОСТ**, общая для всех приложений
  (currency-converter, client-bank-alfa-by, procure-ai). На текущем сервере **уже подняты** (контейнеры
  `server`/`letsencrypt`/`…watchtower` из стека currency-converter) — второй раз не запускаем (конфликт
  портов 80/443 и имён). Эти два файла нужны только при развёртывании **чистого** хоста.

  **Развёртывание на общем сервере** (инфра уже есть → шаги 1–5):
  1. A-запись `price-import.bx-shef.by → <IP>` (общий сервер).
  2. `.env` рядом с `docker-compose.prod.yml` (секреты; см. ниже; `DOMAIN`=`price-import.bx-shef.by`) — в git не коммитим.
  3. `make prod-up` (`docker compose -f docker-compose.prod.yml up -d`) → acme выпустит TLS автоматически.
  4. `make proxy-tune` — применить per-vhost тюнинг фронт-прокси (лимит тела + таймаут OCR; см. секцию nginx).
  5. Регистрация приложения в Bitrix24 (OAuth redirect + вебхук `https://price-import.bx-shef.by/api/b24/events`).

  **Чистый хост** (инфры ещё нет → сначала): `make server-up` → `make watchtower-up` → затем шаги 2–5.

## Env (полный список — `.env.example`)

Обязательные: `DATABASE_URL`, `REDIS_URL`, `B24_CLIENT_ID/SECRET`,
`B24_TOKEN_ENC_KEY` (base64 32 байта), `NUXT_PUBLIC_SITE_URL` (абсолютный — из него строится URL
хендлера событий Б24). LLM-провайдер (агент): `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` (DeepSeek).
Оператор (опц.): `OPERATOR_PASSWORD` + **`OPERATOR_SESSION_SECRET`** (свой, не фолбэк на enc-key).
`B24_APPLICATION_TOKEN` — **не заполняем**: `application_token` приходит в `ONAPPINSTALL` и
запоминается по порталу (B24 «Безопасность в обработчиках»); первая установка проверяется по
доставленному `access_token` (`server/utils/verifyInstallToken`), дальнейшие события — по
сохранённому токену. Значение задают только как доп. глобальный гейт первой установки (плейсхолдер
здесь = 403 на каждую установку). `envCheck` на старте валидирует и предупреждает (не роняет процесс).

## nginx (reverse-proxy, один домен)

- `location /api/ { proxy_pass http://backend:3000; }` — вебхук Б24 на `https://<DOMAIN>/api/b24/events` (без CORS).
- **Антибрутфорс входа оператора (обязательно):** `limit_req_zone` по IP (`real_ip` из `X-Forwarded-For`),
  `location = /api/auth/login { limit_req zone=login burst=5 nodelay; ... }` (~10 r/m → 429). App-layer
  задержка в роуте — только backstop (см. `docs/AUTH.md`).
- **Внутренние эндпоинты — `deny all` снаружи:** `/api/queues` (токен приложения, для консоли).
- **CSP для встройки в Б24:** `frame-ancestors`/`connect-src` разрешают облачные домены Bitrix24
  (iframe `/app`,`/settings`); backend — тот же origin (`'self'`).
- **Память:** контейнер backend с `mem_limit` (в compose — 2g): извлечение гоняет недоверенные файлы
  через libreoffice/tesseract — лимит памяти защищает от zip/XML/image-бомбы (таймаут ограничивает CPU, не RAM).

### Тюнинг общего фронт-`nginx-proxy` (обязательно для загрузок/OCR)

Есть **два** слоя nginx: app-level (`nginx.conf` в образе `app`) и **общий фронт-`nginx-proxy`**
(терминирует TLS, один на хост). App-level уже разрешает тело до 25m (demo-роут 6m) и таймаут 300s
на `/api/demo/extract`, **но фронт-прокси работает на nginx-дефолтах** (`client_max_body_size 1m`,
`proxy_read_timeout 60s`). Без тюнинга он отбивает загрузки >~1 МБ (**413**) и рвёт OCR-тяжёлые
разборы на 60s (**504**) — раньше, чем запрос дойдёт до app. Найдено на живом тесте (**GH #63**).

Фикс скоупится **только на наш vhost** (другие приложения на прокси не затрагиваются) — файл
`deploy/vhost.d/price-import.bx-shef.by` (`client_max_body_size 25m` + `proxy_read_timeout/send_timeout 300s`).
Применить в живой прокси:

```bash
make proxy-tune          # docker cp файла в nginx-proxy → nginx -t → nginx -s reload
# (PROXY_CONTAINER=<имя>, если контейнер прокси называется иначе)
```

⚠️ Файл лежит в **томе** `vhost` фронт-прокси и **переживает** рестарт/пере-деплой приложения, но
на **чистом** хосте (пересоздан том) шаг нужно повторить. Проверка: загрузка PDF >1 МБ не даёт 413,
тяжёлый скан — 200 вместо 504.

## Здоровье и миграции

- Liveness: `GET /api/health` → `{status,time,commit,commitUrl}` (на нём же docker `HEALTHCHECK`).
- Схема БД применяется идемпотентно плагином на старте (`server/plugins/migrate`); ретенция — TTL-свип
  ежечасно (`server/plugins/retention`) + полная очистка при `ONAPPUNINSTALL`.

## Дальше (масштаб)

Вынести воркеры пайплайна в отдельный контейнер (сейчас поднимаются in-process плагином `queue`),
Redis — на изолированной сети. Глубокая телеметрия очередей (Prometheus/Grafana) — по мере нагрузки.
