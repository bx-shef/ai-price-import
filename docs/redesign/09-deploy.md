# Деплой (редизайн procure-ai)

> Last reviewed: 2026-07-08

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
- **Прод:** CI (`.github/workflows/redesign-ci.yml`) собирает образ; публикацию в **GHCR** + деплой
  через **Watchtower** добить по образцу `currency-converter`/`client-bank-alfa-by` (matrix build →
  `docker-compose.prod.yml` с GHCR-образами). CI уже валидирует, что образ **собирается** (docker-build job).

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
