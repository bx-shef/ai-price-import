# Деплой (редизайн procure-ai)

> Last reviewed: 2026-07-18

Как развернуть облачное приложение (лендинг + in-portal UI + backend-пайплайн) в проде.
Схема — как у эталона `client-bank-alfa-by`: **GHCR-образ + Watchtower за общим nginx-proxy**,
Postgres и Redis рядом. Один домен: nginx проксирует `/api/*` в backend.

## Состав

Один Nitro-образ (`Dockerfile`, target `backend`) отдаёт **и** пререндеренные страницы
(лендинг, `/app`, `/import`, `/settings`, `/login`, `/queues`) **и** API/пайплайн. Рядом:
- **Postgres** — токены порталов, задачи, извлечённый текст/структура, метрики (миграции идемпотентны, на старте).
- **Redis** — очереди BullMQ (`b24-events`/`file-extract`/`agent-run`/`crm-sync`). Без него пайплайн выключен, загрузка отдаёт 503.
- Бинарники извлечения — **в образе** (`poppler-utils`, `libreoffice`, `tesseract-ocr` + явные
  языковые пакеты `eng/rus/bel/kaz`). **Fail-fast проверка наличия и запускаемости на сборке:** отдельный
  `RUN` в backend-стадии Dockerfile прогоняет `pdftotext`/`pdftoppm`/`libreoffice`/`tesseract`/`claude` и
  сверяет все 4 OCR-языка (`--list-langs`) — сломанный/переименованный пакет роняет `docker build`, а не
  рантайм. Нюансы: грепаем строку **версии** (имя+цифра, не голое имя — иначе «error loading shared
  libraries» прошло бы), poppler `-v` даёт 99 даже здоровый → пайп на `grep` (его exit-код и решает),
  `libreoffice --version` под `timeout` (страховка от зависшего first-run профиля).
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

  **Развёртывание на общем сервере** (инфра уже есть → шаги 1–4):
  1. A-запись `price-import.bx-shef.by → <IP>` (общий сервер).
  2. `.env` рядом с `docker-compose.prod.yml` (секреты; см. ниже; `DOMAIN`=`price-import.bx-shef.by`) — в git не коммитим.
  3. `make prod-up` (`docker compose -f docker-compose.prod.yml up -d`) → acme выпустит TLS автоматически
     **и авто-применит per-vhost тюнинг фронт-прокси** (GH #71: `prod-up`/`prod-redeploy` в конце гонят
     `proxy-tune`, best-effort — если прокси не найден, деплой не падает, только warn). Отдельный
     `make proxy-tune` больше вручную запускать не нужно; при желании — `make proxy-check` (см. секцию nginx).
  4. Регистрация приложения в Bitrix24 (OAuth redirect + вебхук `https://price-import.bx-shef.by/api/b24/events`).

  **Чистый хост** (инфры ещё нет → сначала): `make server-up` → `make watchtower-up` → затем шаги 2–4.

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

### REST-бюджет портала: лимитер `@bitrix24/b24jssdk` (#123)

**Свой дозатор REST не пишем** — у SDK встроен `RestrictionManager` (пер-инстанс leaky-bucket:
`drainRate` 2 req/s + `burstLimit` 50 на стандартном тарифе, `ParamsFactory.getDefault()`) +
operating-limit-адаптив (сервер сам сигналит перегрузку `operating`/`operating_reset_at` — две
параллельные джобы одного портала видят один сигнал и тормозят согласованно) + auto-retry на
`QUERY_LIMIT_EXCEEDED`/429/5xx. Задача была не строить своё, а **проверить дефолты нагрузкой и
подобрать настройки**.

**Живой нагруз-тест — `pnpm loadtest:123`** (`scripts/load-test-123.mjs`, dev-only; вебхук из env
`B24_HOOK` **или** git-ignored `.env.b24test`; читает реальные `crm.item.list`/`crm.vat.list`/
`crm.requisite.list`/`catalog.measure.list`/`crm.currency.list`, как crm-sync). Гейт зачётен, только
если троттл **реально сработал** (Scenario A `limitHits>0`) — иначе «0 QLE» ничего не доказывает. QLE
ловим по `AjaxError.code` (в `.message` — человеческий текст, регексп по нему не сматчил бы). Прогоны
вживую (портал `b24-*.bitrix24.com`, стандартный тариф):

| Сценарий | нагрузка | результат |
|---|---|---|
| `--jobs 6 --ops 20`: один лимитер, 60 чтений (OPS×3 > burst 50) | ~11.4 req/s | **`limitHits:55`** (троттл сработал), **0 QLE**, 0 ошибок |
| `--jobs 6 --ops 20`: scale-out ×6 (свой лимитер на джобу), 120 чтений | ~36 req/s агрегат | **0 QLE**, 0 ошибок |
| `--jobs 8 --ops 55`: один лимитер, 165 чтений | ~2.9 req/s (= drainRate 2) | **`limitHits:6672`** (жёсткий троттл до слива), **0 QLE** |
| `--jobs 8 --ops 55`: scale-out ×8, 440 чтений | ~46 req/s пик | **0 QLE**, 0 ошибок |

**Вывод: дефолтные `RestrictionParams` держат** — исчерпав burst-ведро инстанса, лимитер сам
садится ровно на `drainRate` (2 req/s, видно на `--ops 55`); даже 8 независимых ведёр параллельно
не выпускают ни одного `QUERY_LIMIT_EXCEEDED`. **Понижать `drainRate`/`burst` не нужно**, кастомный
`setRestrictionManagerParams` (кроме retry-off ниже) не требуется. ⚠ Тест меряет **rate-limit/burst**,
но **не** устойчивый 10-минутный operating-лимит (для него нужны тяжёлые методы в течение минут) — при
росте конкуренции/смене тарифа пере-прогнать `pnpm loadtest:123 --jobs N --ops M` и держать оба чека зелёными.

**Запас ещё больше из-за мемоизации клиента (#163):** резолвер `createPortalSdkResolver` держит
**один** `B24OAuth` (одно leaky-bucket-ведро) на портал на воркер (TTL 60с), поэтому **конкурентные
crm-sync-джобы одного портала на одном воркере делят ОДНО ведро**, а не по ведру на джобу. Реальное
число параллельных ведёр на портал = число воркеров, одновременно обрабатывающих этот портал (≤ число
реплик), а не `QUEUE_CRM_CONCURRENCY`. Тест же моделирует `--jobs` **независимых** ведёр — т.е.
**консервативнее** боевого сценария, где ведро делится.

**Правка транспорта — `maxRetries:1` + `retryOnNetworkError:false`** (`makePortalSdkCall`,
`server/utils/b24Sdk.ts`): **полностью выключаем in-SDK-ретрай**. crm-sync-джоба делает
**неидемпотентные** создания (`crm.item.add`/`crm.product.add`); любой in-SDK-ретрай одного из них —
после client-side network-таймаута **или серверного 504** (запрос мог уже **пройти** на сервере) —
молча создал бы **дубль** (Bitrix не гарантирует уникальность `originId`/`xmlId`). Вместо этого даём
упасть всей BullMQ-джобе и ретраим её — там создания идемпотентны (`findExisting`-перед-созданием по
маркеру #135 для сущности; `findProduct` перед `crm.product.add` для товара). **Остаётся включённым**
(всё это **независимо** от цикла ретраев — live-verified: при `maxRetries:1` `limitHits` продолжают
срабатывать): проактивный rate-limit-троттл (ждёт **до** отправки), operating-адаптив и реактивный
рефреш OAuth-токена (свой путь `abstract-http._isAuthError`). Размен: редкий `QUERY_LIMIT_EXCEEDED`/5xx
теперь стоит джоб-ретрая, а не in-SDK-ретрая — приемлемо для нашей низкой конкуренции, а проактивный
лимитер QLE и так предотвращает.

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

Применить в живой прокси (**авто-применяется** в `make prod-up`/`prod-redeploy`, GH #71 — вручную
нужно только для внепланового применения/отладки):

```bash
make proxy-tune     # авто-определяет контейнер прокси (публикует :443) → docker cp → nginx -t →
                    # reload ИЛИ рестарт (см. ниже про регенерацию конфига)
# на этом сервере прокси поднят чужим стеком (currency-converter) и зовётся НЕ `nginx-proxy`;
# авто-детект по :443 это решает. Переопределить вручную: PROXY_CONTAINER=<имя> make proxy-tune
make proxy-untune   # откат: удалить файл + reload/рестарт (413/504 вернутся к дефолтам прокси)
make proxy-check    # ПОСЛЕ деплоя: проверить, что тюнинг ЖИВ — >2МБ POST не 413 + health 200
                    # (scripts/proxy-healthcheck.sh; домен из PROXY_VHOST). Ловит «тюнинг
                    # молча потерялся при пересоздании тома → 413/504 без видимой причины».
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
на **чистом** хосте (пересоздан том) шаг нужно повторить.

### Как убрать ручной шаг и рестарт совсем (GH #71)

`make proxy-tune` — обходной путь (docker cp + рестарт при первом применении). Чтобы тюнинг
**переживал пересоздание тома** и не требовал ни рестарта, ни ручного шага, файл `vhost.d/<host>`
надо отдавать прокси **декларативно**, тогда include присутствует уже при первой генерации
docker-gen (рестарт не нужен). Три варианта по возрастанию инвазивности:

1. **Bind-mount нашего файла в том `vhost.d` прокси** (предпочтительно на **чистом** хосте, где
   прокси поднимаем мы через `docker-compose.server.yml`). В сервис `nginx-proxy` добавить:
   ```yaml
   volumes:
     - ./deploy/vhost.d/price-import.bx-shef.by:/etc/nginx/vhost.d/price-import.bx-shef.by:ro
   ```
   Файл есть до старта docker-gen → include генерируется сразу, `make proxy-tune` не нужен вообще.
   ⚠️ На **текущем** сервере прокси поднят **чужим стеком** (currency-converter) — правку его compose
   согласовать с владельцем хоста; вслепую не менять.
2. **Init/seed-контейнер** в нашем `docker-compose.prod.yml`, который на старте копирует файл в
   общий том `vhost.d` (если том прокси доступен по имени) — переживает пересоздание нашего стека,
   но не пересоздание тома прокси. Менее чисто, чем bind-mount. ⚠️ Нужно **узнать и зафиксировать
   у владельца стека точное имя тома** `vhost.d` прокси currency-converter — без него `external: true`
   в нашем compose не подключится (том не найдётся, контейнер не стартует).
3. **Оставить `make proxy-tune`** как есть (уже идемпотентен и сам решает reload/рестарт) — для
   текущего общего хоста это рабочий минимум; ручной шаг один раз после пересоздания тома.

**CI-валидация (сделано, вариант 3+):** синтаксис `deploy/vhost.d/*` теперь проверяет CI —
шаг `sh scripts/check-vhost.sh` в job `ci` (required-check). Скрипт включает каждый файл в
минимальный `server{}` и гоняет `nginx -t -c` в одноразовом контейнере nginx (тот же приём, что
в `make proxy-tune`), поэтому **битый vhost.d не пройдёт в прод** (иначе рискнули бы 413/504 или
уронить общий прокси при рестарте). Раньше файл проверялся только в момент применения на сервере.

**Решение:** на чистом хосте — вариант 1 (bind-mount, в `docker-compose.server.yml`); на текущем
общем — вариант 3 до согласования с владельцем стека currency-converter. Синтаксис уже под CI-гейтом
(выше); полная **декларативная** автоматизация (вариант 1 для текущего хоста, чтобы убрать и ручной
шаг, и рестарт) остаётся в GH #71 как задача, требующая доступа к чужому compose.

## Здоровье и миграции

- Liveness: `GET /api/health` → `{status,time,commit,commitUrl}` (на нём же docker `HEALTHCHECK`).
- Схема БД применяется идемпотентно плагином на старте (`server/plugins/migrate`); ретенция — TTL-свип
  ежечасно (`server/plugins/retention`) + полная очистка при `ONAPPUNINSTALL`.

## Альтернативный таргет — Битрикс24 Вайбкод Black Hole

Помимо основного пути (GHCR + Watchtower за nginx-proxy, выше) приложение можно выгрузить в
**закрытый Bitrix-Cloud VM** (Vibecode Black Hole) по REST, без SSH — **одним Nitro-процессом на
:3000** (тот же `pnpm build` → `node .output/server/index.mjs` отдаёт и лендинг, и in-portal, и
`/api/*`; pg/redis+OCR-тулчейн провижнятся на VM в `preStart`, миграции в процессе на старте).
Артефакты — `deploy/vibecode-deploy.sh` + `.github/workflows/deploy-vibecode.yml` (**opt-in**:
`VIBECODE_DEPLOY==true`, основной путь не трогает; в Docker-образ не попадают). ⚠ Без nginx нет
CSP/security-заголовков/login-rate-limit — паритет в Nitro — follow-up; служебная зона fail-closed
(nginx для неё не нужен). Полный runbook и env — [`docs/DEPLOY_VIBECODE.md`](../DEPLOY_VIBECODE.md).

## Дальше (масштаб)

Вынести воркеры пайплайна в отдельный контейнер (сейчас поднимаются in-process плагином `queue`),
Redis — на изолированной сети. Глубокая телеметрия очередей (Prometheus/Grafana) — по мере нагрузки.
