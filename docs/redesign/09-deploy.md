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

### Ресурсы воркера: минимум + стабильность (осознанный выбор)

**Проектная позиция: продукт рассчитан на СТАБИЛЬНУЮ работу на МИНИМАЛЬНЫХ ресурсах, а не на
скорость.** Мы намеренно НЕ вкладываемся в производительность общей инфраструктуры: облачное
приложение обслуживает всех арендаторов на скромном сервере с **ограниченным** параллелизмом (а в
идеале — почти по очереди). Кому нужны скорость/объём — предлагаем разворачивание на своём сервере
(см. маркетинг §2, блок про self-hosted).

> **Цифры ниже — ориентировочные (внутренний замер этой сессии на 4 vCPU, не строгий бенчмарк и НЕ
> SLA).** Приведены как порядок величин для сайзинга, а не как обещание клиенту.

Что реально ест ресурсы — **внешние процессы на один документ**, не Node:

| Этап | Бинарь | CPU | RAM (пик, оценочно) |
|------|--------|-----|-----------|
| office → CSV | `libreoffice` (headless) | 1 ядро, всплеск ~1–3с | ~150–300 МБ |
| PDF цифровой | `pdftotext` | лёгкий | ~20–50 МБ |
| скан/фото → текст | `tesseract` (rus+bel+kaz+eng) | **многопоточный, 4 языка — тяжело** | ~200–500 МБ (растёт с разрешением) |
| извлечение полей | LLM-агент | почти ноль локально (сеть) | — |

**Минимум:** **2 vCPU / 2 ГБ RAM** — достаточно для стабильной работы, просто медленно (ОК по дизайну).

**Конкуренция воркера конфигурируется env (GH #95).** `server/queue/worker.ts` читает
`QUEUE_EXTRACT_CONCURRENCY` / `QUEUE_AGENT_CONCURRENCY` / `QUEUE_CRM_CONCURRENCY` (дефолты 4/2/4 —
прежнее поведение). **На минимуме 2 vCPU снизьте до ≤ числа ядер** (`extract`/`agent` = 1) — иначе
переподписка (см. ниже). Настраивается в `.env.example`.

**Ключевая ловушка — конкуренция, а не объём.** Один `tesseract` сам разворачивает потоки на все
ядра (ориентировочный замер: ~2.3с wall при ~7с CPU-времени — т.е. ~4 потока). На 4 ядрах **три**
документа параллельно (2×OCR + libreoffice) устроили переподписку → каждый OCR перевалил за таймаут
`RUN_TIMEOUT_MS` (90с, `server/utils/extractRunners.ts`) и документ **ложно уехал в ошибку**, хотя
автономно шёл 2 секунды. Поэтому на минимальной инфраструктуре:

1. **`OMP_THREAD_LIMIT=1`** (или `2`) в env бэкенда — чтобы N процессов tesseract не дрались за ядра.
   Проброшено в субпроцессы через allow-list env (см. ниже) и задокументировано в `.env.example`.
2. **Конкуренция извлечения ≤ числу ядер** (`QUEUE_EXTRACT_CONCURRENCY`/`QUEUE_AGENT_CONCURRENCY`) —
   иначе тяжёлый OCR превысит 90с-таймаут.
3. **`mem_limit` обязателен** (2–4 ГБ) — OOM-защита от бомб (см. пункт «Память» выше, не повторяем).
4. Тяжёлые фото — либо поднять `RUN_TIMEOUT_MS`, либо даунскейлить изображение перед OCR
   (сейчас не делается — потенциальное улучшение, не блокер).
5. **Backpressure очереди:** при устойчивом превышении входящего потока над throughput очередь
   `waiting` растёт неограниченно — нужен алерт по её длине и/или лимит приёма (TODO).
6. **Секреты не видны бинарям извлечения (GH #99).** libreoffice/pdftotext/tesseract/pdftoppm
   гоняют недоверенные документы (макросы, битые PDF), поэтому запускаются с **урезанным env**
   (allow-list `subprocessEnv` в `server/utils/extractRunners.ts`: PATH/HOME/локаль/OMP/шрифты) —
   без `DATABASE_URL`/`B24_TOKEN_ENC_KEY`/`B24_CLIENT_SECRET`. Аналог `agentSpawnEnv` для агента.

**Комфортно (несколько документов параллельно):** 4–8 vCPU / 2–4 ГБ — по сути 1 ядро на один
одновременный тяжёлый документ. Но это уже про «быстро» → таких клиентов уводим в self-hosted, а не
масштабируем общий сервер.

### Тюнинг общего фронт-`nginx-proxy` (обязательно для загрузок/OCR)

Есть **два** слоя nginx: app-level (`nginx.conf` в образе `app`) и **общий фронт-`nginx-proxy`**
(терминирует TLS, один на хост). App-level разрешает тело до 25m (demo-роут 6m); таймаут на demo-роуте
поднят до 300s **этим же фиксом** (было 180s из `proxy_common.conf`). **Но фронт-прокси работает на
nginx-дефолтах** (`client_max_body_size 1m`, `proxy_read_timeout 60s`): без тюнинга он отбивает загрузки
>~1 МБ (**413**) и рвёт OCR-тяжёлые разборы на 60s (**504**) — раньше, чем запрос дойдёт до app. Найдено
на живом тесте (**GH #63**).

Фикс скоупится **только на наш vhost** (другие приложения на прокси не затрагиваются) — файл
`deploy/vhost.d/price-import.bx-shef.by` (`client_max_body_size 25m` + `proxy_read/send_timeout 300s` +
`client_body_timeout 60s` от медленной заливки). ⚠️ nginx-proxy включает файл в **весь** `server{}`
нашего vhost — таймаут 300s действует на все роуты домена (не только demo); это осознанный компромисс
(per-location гранулярности на этом слое нет), app-level держит не-demo роуты на 180s.

Применить в живой прокси:

```bash
make proxy-tune     # авто-определяет контейнер прокси (публикует :443) → docker cp → nginx -t →
                    # reload ИЛИ рестарт (см. ниже про регенерацию конфига)
# на этом сервере прокси поднят чужим стеком (currency-converter) и зовётся НЕ `nginx-proxy`;
# авто-детект по :443 это решает. Переопределить вручную: PROXY_CONTAINER=<имя> make proxy-tune
make proxy-untune   # откат: удалить файл + reload/рестарт (413/504 вернутся к дефолтам прокси)
```

⚠️ **reload ≠ регенерация конфига (GH #71).** docker-gen вставляет строку
`include /etc/nginx/vhost.d/<host>;` в сгенерированный конфиг **только если файл уже
существует на момент генерации**. При **первом** применении файла ещё нет → include
отсутствует → `nginx -s reload` перечитывает конфиг **без** нашего тюнинга (413/504
держатся, хотя файл скопирован). Регенерацию запускает docker-событие или рестарт прокси.
Поэтому `make proxy-tune` сам проверяет, есть ли уже `include` в рабочем конфиге: **есть** →
`reload` (без простоя соседей); **нет** (первое применение) → `docker restart` прокси
(кратковременный ~1–2с блип для ВСЕХ vhost хоста — осознанный компромисс, только на первом
применении). `proxy-untune` симметричен: после `rm` файла stale-`include` тоже требует
регенерации.

**Проверка после применения** (не по «работает же», а фактом):

```bash
docker exec "$(docker ps --filter publish=443 --format '{{.Names}}' | head -1)" \
  cat /etc/nginx/vhost.d/price-import.bx-shef.by            # файл на месте
curl -sS -o /dev/null -w '%{http_code}\n' -F file=@big-2mb.pdf \
  https://price-import.bx-shef.by/api/demo/extract          # НЕ 413
# тяжёлый скан (обработка 60–300s) → 200, НЕ 504
# smoke соседей: curl -I на 1–2 других домена того же прокси → без 5xx (общий reload)
```

⚠️ Файл лежит в **томе** `vhost` фронт-прокси и **переживает** рестарт/пере-деплой приложения, но
на **чистом** хосте (пересоздан том) шаг нужно повторить. Автоматизация (чтобы не терялось при
пересоздании тома) — вынесена в ISSUE.

## Здоровье и миграции

- Liveness: `GET /api/health` → `{status,time,commit,commitUrl}` (на нём же docker `HEALTHCHECK`).
- Схема БД применяется идемпотентно плагином на старте (`server/plugins/migrate`); ретенция — TTL-свип
  ежечасно (`server/plugins/retention`) + полная очистка при `ONAPPUNINSTALL`.

## Дальше (масштаб)

Вынести воркеры пайплайна в отдельный контейнер (сейчас поднимаются in-process плагином `queue`),
Redis — на изолированной сети. Глубокая телеметрия очередей (Prometheus/Grafana) — по мере нагрузки.
