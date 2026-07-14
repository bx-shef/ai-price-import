.PHONY: dev build-local check \
        prod-up prod-down prod-pull prod-redeploy logs ps \
        server-up server-down watchtower-up watchtower-down proxy-tune proxy-untune

# Обёртки над командами разработки и деплоя. Подробности — docs/redesign/09-deploy.md.
# Прод-цели читают переменные из ./.env (см. .env.example: NUXT_PUBLIC_SITE_URL,
# LETSENCRYPT_EMAIL, POSTGRES_PASSWORD, B24_TOKEN_ENC_KEY, ANTHROPIC_* …).

# ─── Локальная разработка ────────────────────────────────────────────

dev:
	pnpm dev

## Полный гейт перед пушем (lint + typecheck + test)
check:
	pnpm check

## Локальная сборка образов и запуск backend на :3000 (проверка перед деплоем)
build-local:
	docker compose up --build

# ─── Прод (на сервере, /home/bitrix/price-import) ────────────────────
# Требует общий nginx-proxy + acme-companion + Watchtower на хосте (ставятся ОДИН раз
# на сервер — см. server-up / watchtower-up ниже; на этом сервере уже подняты вместе с
# currency-converter) и docker-сеть proxy-net. Свой Watchtower в prod-стеке НЕ поднимаем —
# хостовый подхватывает контейнеры по метке com.centurylinklabs.watchtower.enable.

## Запустить / обновить весь prod-стек (app + backend + db + redis)
prod-up:
	docker compose -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.prod.yml down

## Скачать свежие образы (без перезапуска контейнеров)
prod-pull:
	docker compose -f docker-compose.prod.yml pull

## Принудительно обновить прямо сейчас (не дожидаясь Watchtower)
prod-redeploy:
	docker compose -f docker-compose.prod.yml pull && \
	docker compose -f docker-compose.prod.yml up -d && \
	docker image prune -f

logs:
	docker compose -f docker-compose.prod.yml logs -f app backend

ps:
	docker compose -f docker-compose.prod.yml ps

# ─── Общая инфраструктура сервера (ОДИН раз на ХОСТ) ─────────────────
# nginx-proxy+acme и Watchtower — одни на сервер, общие для ВСЕХ приложений
# (currency-converter, client-bank-alfa-by, procure-ai). На этом сервере они УЖЕ
# запущены (контейнеры `server`/`letsencrypt`/`…watchtower`) — эти цели нужны только
# при поднятии ЧИСТОГО хоста. Дублировать на живом сервере НЕЛЬЗЯ (конфликт портов 80/443
# и имён контейнеров). Подробности — docs/redesign/09-deploy.md.

## Поднять общий reverse-proxy + авто-TLS (создаёт сеть proxy-net)
server-up:
	docker compose -f docker-compose.server.yml up -d

server-down:
	docker compose -f docker-compose.server.yml down

## Поднять общий Watchtower (авто-обновление образов по метке)
watchtower-up:
	docker compose -f docker-compose.watchtower.yml up -d

watchtower-down:
	docker compose -f docker-compose.watchtower.yml down

## Применить per-vhost тюнинг к живому общему nginx-proxy (лимит тела + таймаут OCR).
## Безопасно для других приложений — файл скоупится только на наш vhost. См. GH #63, #71,
## docs/redesign/09-deploy.md.
## Имя контейнера прокси НЕ хардкодим: на этом сервере общий прокси поднят чужим стеком
## (currency-converter) и называется НЕ `nginx-proxy`. Определяем его автоматически как
## контейнер, публикующий :443; переопредели `PROXY_CONTAINER=<имя>` при нужде.
PROXY_CONTAINER ?= $(shell docker ps --filter publish=443 --format '{{.Names}}' | head -n1)
# Хост нашего vhost — от него зависят и имя файла vhost.d, и строка `include` в
# сгенерированном конфиге. Держим ОДНО определение (DRY) для tune/untune.
PROXY_VHOST ?= price-import.bx-shef.by
# КЛЮЧЕВОЙ момент (GH #71): docker-gen вставляет `include /etc/nginx/vhost.d/<host>;` в
# сгенерированный конфиг ТОЛЬКО если файл уже существует на момент генерации. При ПЕРВОМ
# применении файла ещё нет → include отсутствует → `nginx -s reload` перечитывает конфиг
# БЕЗ нашей строки (тюнинг «не виден», 413/504 держатся). Регенерацию запускает только
# docker-событие / рестарт. Поэтому: скопировали файл → проверили, есть ли уже include в
# рабочем конфиге. Есть → достаточно reload (без простоя чужих сайтов). Нет → форсим
# регенерацию рестартом прокси (кратковременный ~1–2с блип для ВСЕХ vhost на этом хосте —
# это осознанный компромисс, только на первом применении).
proxy-tune:
	@test -n "$(PROXY_CONTAINER)" || { echo "Не найден фронт-прокси (:443). Задай PROXY_CONTAINER=<имя> (см. docker ps)"; exit 1; }
	@echo "Front proxy: $(PROXY_CONTAINER)"
	docker cp deploy/vhost.d/$(PROXY_VHOST) "$(PROXY_CONTAINER)":/etc/nginx/vhost.d/$(PROXY_VHOST)
	@# Валидируем СОДЕРЖИМОЕ нового vhost.d-файла в server-контексте ДО reload/restart. Обычный
	@# `nginx -t` ниже проверяет действующий конфиг, где нашего include ещё нет (первое применение),
	@# т.е. синтаксис файла остаётся непроверенным — а битый файл уронил бы ОБЩИЙ прокси при рестарте.
	@# Собираем минимальный тест-конфиг, который include-ит наш файл в server{}, и гоняем `nginx -t -c`.
	docker exec "$(PROXY_CONTAINER)" sh -c 'printf "events{}\nhttp{server{\ninclude /etc/nginx/vhost.d/$(PROXY_VHOST);\n}}\n" > /tmp/procure-vhost-test.conf && nginx -t -c /tmp/procure-vhost-test.conf; rc=$$?; rm -f /tmp/procure-vhost-test.conf; exit $$rc'
	docker exec "$(PROXY_CONTAINER)" nginx -t
	@if docker exec "$(PROXY_CONTAINER)" grep -qsF "/etc/nginx/vhost.d/$(PROXY_VHOST)" /etc/nginx/conf.d/default.conf; then \
		echo "include уже в конфиге → reload (без простоя)"; \
		docker exec "$(PROXY_CONTAINER)" nginx -s reload; \
	else \
		echo "⚠ include отсутствует (первое применение) → РЕСТАРТ прокси для регенерации конфига."; \
		echo "⚠ Затронет ВСЕ vhost этого хоста (соседние проекты) на ~1–2с. Запускай в окно низкого трафика."; \
		docker restart "$(PROXY_CONTAINER)"; \
	fi

## Откат тюнинга: удалить per-vhost файл и перечитать конфиг (413/504 вернутся к дефолтам прокси).
proxy-untune:
	@test -n "$(PROXY_CONTAINER)" || { echo "Не найден фронт-прокси (:443). Задай PROXY_CONTAINER=<имя> (см. docker ps)"; exit 1; }
	docker exec "$(PROXY_CONTAINER)" rm -f /etc/nginx/vhost.d/$(PROXY_VHOST)
	@# Симметрично proxy-tune: пока файл существовал, docker-gen вставил `include …/$(PROXY_VHOST)`
	@# в конфиг. После rm этот include указывает на несуществующий файл → `nginx -t`/reload
	@# упадут. Если строка ещё в конфиге → форсим регенерацию рестартом (docker-gen уберёт
	@# include, т.к. файла больше нет). Если её уже нет → достаточно reload.
	@if docker exec "$(PROXY_CONTAINER)" grep -qsF "/etc/nginx/vhost.d/$(PROXY_VHOST)" /etc/nginx/conf.d/default.conf; then \
		echo "include ещё в конфиге → рестарт прокси для регенерации (уберёт ссылку на удалённый файл)"; \
		docker restart "$(PROXY_CONTAINER)"; \
	else \
		docker exec "$(PROXY_CONTAINER)" nginx -t && docker exec "$(PROXY_CONTAINER)" nginx -s reload; \
	fi
