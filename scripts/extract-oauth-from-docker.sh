#!/usr/bin/env bash
# Extract a SPECIFIC portal's OAuth credentials from the running backend Docker (#191 SDK gate).
#
# Usage: bash scripts/extract-oauth-from-docker.sh <b24-domain>
#   e.g. bash scripts/extract-oauth-from-docker.sh bel.bitrix24.by
#
# Reads the `portal_tokens` row for the GIVEN portal domain from the Postgres container,
# decrypts its refresh token INSIDE the backend container (where B24_TOKEN_ENC_KEY /
# B24_CLIENT_ID / B24_CLIENT_SECRET live), refreshes it against Bitrix24 OAuth, and prints a
# ready-to-paste block of B24_OAUTH_* env vars for `.env.b24oauth` (pnpm sdk:smoke / live:crm).
#
# Run this ON THE SERVER where the backend runs (needs `docker`). The printed access/refresh
# come from a fresh OAuth refresh, so the CURRENT refresh token is ROTATED: the DB row is now
# one generation behind and the backend's next refresh of THAT row will fail once. On a TEST
# portal that's fine — reinstall the app (or re-run this) to re-sync. Do NOT run against a
# production portal you don't want to rotate.
#
# TEMPORARY dev tool: this exists only until the in-portal token-management page (#TBD) lands,
# which will expose credential health / re-auth WITHOUT shelling into the server. Remove then.
#
# Key format: hex-64 OR base64 → 32 bytes (server/utils/secretCrypto.ts). Blob: iv:tag:ciphertext,
# all base64 (AES-256-GCM, 12-byte IV). Mirrors client-bank-alfa-by's script; input is the domain.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "укажи домен портала Б24 первым аргументом, напр.:" >&2
  echo "  bash scripts/extract-oauth-from-docker.sh bel.bitrix24.by" >&2
  exit 2
fi
# Validate as a hostname before it reaches SQL — this is the only external input, and it is
# interpolated into the query below. Reject anything that isn't a plain host (no quotes/spaces).
if ! printf '%s' "$DOMAIN" | grep -qE '^[A-Za-z0-9.-]+$'; then
  echo "недопустимый домен: '$DOMAIN' (ожидается хост вида sub.bitrix24.by)" >&2
  exit 2
fi

# `|| true`: grep exits 1 on no match, which under `set -e`+`pipefail` would abort the
# assignment BEFORE the friendly check below could print. Keep the empty capture, drop the code.
DB=$(docker ps --format '{{.Names}}' | grep -iE 'procure-ai[-_]?db' | head -1) || true
BK=$(docker ps --format '{{.Names}}' | grep -iE 'procure-ai[-_]?backend' | head -1) || true
if [ -z "$DB" ] || [ -z "$BK" ]; then
  echo "не найден procure-ai db/backend контейнер: DB='$DB' BK='$BK'" >&2
  echo "проверь: docker ps --format '{{.Names}}'" >&2
  exit 1
fi

# `|| ROW=""`: a psql/connection error under `set -e` would abort here with no message;
# fall through to the friendly check instead (no matching row → psql exits 0 → empty ROW anyway).
ROW=$(docker exec -e DOMAIN="$DOMAIN" "$DB" sh -c \
  'psql -At -F"|" -U "${POSTGRES_USER:-app}" -d "${POSTGRES_DB:-${POSTGRES_USER:-app}}" \
     -c "SELECT domain, member_id, refresh_token_enc FROM portal_tokens WHERE domain = '"'"'$DOMAIN'"'"' LIMIT 1;"') || ROW=""
if [ -z "$ROW" ]; then
  echo "нет строки portal_tokens для домена '$DOMAIN' — приложение (OAuth) на этом портале не установлено," >&2
  echo "либо неверные POSTGRES_USER/DB. Проверь установку через /install и: docker exec $DB psql -U app -c 'SELECT domain FROM portal_tokens;'" >&2
  exit 1
fi

docker exec -e ROW="$ROW" "$BK" node -e '(async () => {
  const c = require("node:crypto")
  const [domain, memberId, enc] = process.env.ROW.split("|")
  const rawKey = (process.env.B24_TOKEN_ENC_KEY || "").trim()
  // Our key is hex-64 OR base64 → 32 bytes (server/utils/secretCrypto.ts).
  const key = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64")
  // Our blob is iv:tag:ciphertext, all base64 (AES-256-GCM, 12-byte IV).
  const [iv, tag, data] = enc.split(":")
  const dc = c.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
  dc.setAuthTag(Buffer.from(tag, "base64"))
  const refresh = Buffer.concat([dc.update(Buffer.from(data, "base64")), dc.final()]).toString("utf8")
  const p = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.B24_CLIENT_ID,
    client_secret: process.env.B24_CLIENT_SECRET,
    refresh_token: refresh
  })
  // POST form body (not GET query) — keeps client_secret/refresh_token OUT of the URL and
  // thus out of any access log, matching server/utils/b24Oauth.ts buildRefreshParams.
  const r = await fetch("https://oauth.bitrix.info/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p.toString()
  })
  const j = await r.json()
  if (!j.access_token) { console.error("REFRESH FAILED:", JSON.stringify(j)); process.exit(1) }
  console.log("\n===== COPY INTO .env.b24oauth =====\n" +
    "B24_OAUTH_DOMAIN=" + domain + "\n" +
    "B24_OAUTH_MEMBER_ID=" + memberId + "\n" +
    "B24_OAUTH_ACCESS_TOKEN=" + j.access_token + "\n" +
    "B24_OAUTH_REFRESH_TOKEN=" + j.refresh_token + "\n" +
    "B24_OAUTH_EXPIRES_IN=" + (j.expires_in || 3600) + "\n" +
    "B24_CLIENT_ID=" + process.env.B24_CLIENT_ID + "\n" +
    "B24_CLIENT_SECRET=" + process.env.B24_CLIENT_SECRET + "\n" +
    "===== END =====\n")
})()'
