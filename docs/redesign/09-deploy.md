# Деплой (редизайн procure-ai)

> Last reviewed: 2026-07-09

Как развернуть облачное приложение (лендинг + in-portal UI + backend-пайплайн) в проде.
Схема — как у эталона `client-bank-alfa-by`: **GHCR-образ + Watchtower за общим nginx-proxy**,
Postgres и Redis рядом. Один домен: nginx проксирует `/api/*` в backend.

## Состав

Один Nitro-образ (`Dockerfile`, target `backend`) отдаёт **и** пререндеренные страницы
(лендинг, `/app`, `/import`, `/settings`, `/login`, `/queues`) **и** API/пайплайн. Рядом:
- **Postgres** — токены порталов, задачи, извлечённый текст/структура, метрики (миграции идемпотентны, на старте).
- **Redis** — очереди BullMQ (`b24-events`/`file-extract`/`agent-run`/`crm-sync`). Без него пайплайн выключен, загрузка отдаёт 503.
- Бинарники извлечения — **в образе** (`poppler-utils`, `libreoffice`, `tesseract-ocr` + `rus/bel/kaz`).

## Сборка и запуск

- **Локально:** `cp .env.example .env` → заполнить → `docker compose up --build`. Backend на `:3000`.
- **Прод:** домен **`price-import.bx-shef.by`** за общим `nginx-proxy` + `acme-companion` (сеть
  `proxy-net`, как `currency-converter`). CI `deploy.yml` (workflow_run после зелёного `ci`) собирает
  и пушит в **GHCR два образа** (matrix `backend`+`app`): `ghcr.io/bx-shef/procure-ai` (Nitro:
  страницы+API+пайплайн) и `ghcr.io/bx-shef/procure-ai-app` (фронт-nginx: proxy/limit_req/CSP).
  `docker-compose.prod.yml` поднимает `app`+`backend`+`db`+`redis`; **Watchtower** авто-обновляет
  образы с меткой `com.centurylinklabs.watchtower.enable=true`. `ci.yml` валидирует сборку **обоих**
  образов на каждом PR (docker-build matrix; app-стадия гоняет `nginx -t`).

  **Развёртывание на общем сервере:**
  1. A-запись `price-import.bx-shef.by → <IP>` (общий сервер).
  2. `.env` рядом с `docker-compose.prod.yml` (секреты; см. ниже) — в git не коммитим.
  3. `docker compose -f docker-compose.prod.yml up -d` → acme выпустит TLS автоматически.
  4. Регистрация приложения в Bitrix24 (OAuth redirect + вебхук `https://price-import.bx-shef.by/api/b24/events`).

## Env (полный список — `.env.example`)

Обязательные: `DATABASE_URL`, `REDIS_URL`, `B24_CLIENT_ID/SECRET`, `B24_APPLICATION_TOKEN`,
`B24_TOKEN_ENC_KEY` (base64 32 байта), `NUXT_PUBLIC_SITE_URL` (абсолютный — из него строится URL
хендлера событий Б24). LLM-провайдер (агент): `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` (DeepSeek).
Оператор (опц.): `OPERATOR_PASSWORD` + **`OPERATOR_SESSION_SECRET`** (свой, не фолбэк на enc-key).
`envCheck` на старте валидирует и предупреждает (не роняет процесс).

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

## Здоровье и миграции

- Liveness: `GET /api/health` → `{status,time,commit,commitUrl}` (на нём же docker `HEALTHCHECK`).
- Схема БД применяется идемпотентно плагином на старте (`server/plugins/migrate`); ретенция — TTL-свип
  ежечасно (`server/plugins/retention`) + полная очистка при `ONAPPUNINSTALL`.

## Дальше (масштаб)

Вынести воркеры пайплайна в отдельный контейнер (сейчас поднимаются in-process плагином `queue`),
Redis — на изолированной сети. Глубокая телеметрия очередей (Prometheus/Grafana) — по мере нагрузки.
