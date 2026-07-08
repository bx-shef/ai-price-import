# Авторизация оператора

> Last reviewed: 2026-07-08

Служебная зона (вход сотрудников в `/queues` и далее) — **отдельно** от B24-встройки
(iframe) и публичного лендинга. Модель портирована из `postroyka/purchase-ai-chat`.

## Модель

- **Общий пароль оператора** (`OPERATOR_PASSWORD`). Пусто ⇒ вход **выключен** (`/api/auth/login` → 503).
- **Cookie сессии** — HMAC-подпись (не хранимое состояние): `base64url(issuedAtMs).HMAC-SHA256`.
  Ключ — `OPERATOR_SESSION_SECRET` (фолбэк — `B24_TOKEN_ENC_KEY`). Флаги: `HttpOnly`,
  `Secure`, `SameSite=Lax`, `path=/`, `maxAge` = 8 ч (сервер — источник истины по сроку).
- Чистое ядро — `server/utils/session.ts` (`checkCredentials` constant-time; `signSession`/
  `verifySession` — подпись/проверка, fail-closed на пустом секрете; тесты). Guard роутов —
  `server/utils/operatorSession.ts` (`operatorAllowed`).

## Роуты

- `POST /api/auth/login` — проверка пароля (constant-time) → ставит cookie. Пусто ⇒ 503.
- `POST /api/auth/logout` — стирает cookie.
- `GET /api/auth/session` — `{ authenticated, enabled }`.
- `GET /api/ops/queues` — метрики очередей по **сессии оператора** (браузерный путь).
- `GET /api/queues` — те же метрики по **токену приложения** заголовком `X-Check-Token`
  (constant-time `opsTokenOk`, fail-closed) — для консоли/скриптов; наружу nginx `deny all`.

## Защита от подбора (важно)

1. **App-layer backstop:** `POST /api/auth/login` держит паузу `FAILURE_DELAY_MS` (400 мс)
   на каждый неверный ввод.
2. **Прод — обязательно edge rate-limiting:** nginx `limit_req` на `location = /api/auth/login`
   (напр. зона ~10 r/m по IP, `burst=5 nodelay` → 429). Фиксированная пауза (1) не спасает от
   параллельных соединений — основная защита именно на границе. Настраивается в конфиге nginx
   при деплое (этап 9).

## Открытые вопросы (hardening)

- **Ревокация:** сессия stateless (нет `jti`), `logout` только стирает cookie — захваченная
  cookie валидна до `issuedAt + 8 ч`. Смягчено `HttpOnly`+`Secure`+8-часовым потолком.
- **CSRF:** защита — `SameSite=Lax` (state-changing POST'ы). Доп. заголовок `X-*-Auth` (как в
  эталоне) — возможное усиление против logout-CSRF.
- **Секрет:** `envCheck` предупреждает, если вход включён, а секрет короткий/пустой; минимальная
  энтропия не форсится (warning, не fatal). Разделение ключей (свой `OPERATOR_SESSION_SECRET`,
  а не фолбэк на `B24_TOKEN_ENC_KEY`) — рекомендуется в проде.
