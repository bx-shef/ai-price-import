.PHONY: dev build-local check \
        prod-up prod-down prod-pull prod-redeploy logs ps \
        server-up server-down watchtower-up watchtower-down

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
