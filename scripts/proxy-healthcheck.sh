#!/bin/sh
# Post-deploy check that the SHARED front nginx-proxy per-vhost tuning is actually LIVE (GH #71).
#
# The tuning (deploy/vhost.d/<host>: client_max_body_size 25m + OCR timeouts) is applied by
# `make proxy-tune` and is SILENTLY LOST if the shared proxy's vhost.d volume / host is recreated —
# after which uploads >1MB return 413 and heavy OCR requests 504 "for no visible reason" (the exact
# pain in #63/#71). This is a one-command detector to run AFTER a deploy or whenever 413s reappear.
#
# What it probes (cheaply, read-only):
#   1. GET /api/health           → 200 (backend reachable through the proxy).
#   2. POST ~BODY_MB of body      → must NOT be 413. A 413 means the front proxy rejected the body
#      by size, i.e. client_max_body_size fell back to the 1m default → tuning lost. The upload
#      route needs frame auth, so an UNAUTHENTICATED big POST is refused by the APP (401/400) only
#      AFTER the proxy forwarded the body — no job is created, no side effect.
# NOT probed: proxy_read_timeout (504) — triggering a >60s upstream reliably needs real heavy OCR
# work, too costly for a health probe. The 413 path is the common, cheaply-testable failure.
#
# Usage:  sh scripts/proxy-healthcheck.sh [domain]        # default domain: price-import.bx-shef.by
#         DOMAIN=host BODY_MB=2 sh scripts/proxy-healthcheck.sh
set -eu

DOMAIN="${1:-${DOMAIN:-price-import.bx-shef.by}}"
BODY_MB="${BODY_MB:-2}"
BASE="https://${DOMAIN}"
fail=0

ok()  { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }

printf 'Proxy healthcheck -> %s\n' "$BASE"

# 1) Liveness through the proxy.
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${BASE}/api/health" 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then ok "/api/health -> 200"; else bad "/api/health -> ${code} (expected 200)"; fi

# 2) Front-proxy body cap: a ~BODY_MB POST must NOT be 413 (proves client_max_body_size tuning).
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT INT TERM
head -c "$((BODY_MB * 1024 * 1024))" /dev/zero | tr '\0' 'a' > "$tmp"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 \
  -X POST "${BASE}/api/import/upload" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@${tmp}" 2>/dev/null || echo 000)
if [ "$code" = "413" ]; then
  bad "POST ${BODY_MB}MB -> 413: front-proxy tuning LOST (client_max_body_size back to 1m). Run: make proxy-tune"
elif [ "$code" = "000" ]; then
  bad "POST ${BODY_MB}MB -> no response (timeout/network)"
else
  ok "POST ${BODY_MB}MB -> ${code} (not 413 — body accepted by the front proxy)"
fi

printf '\n'
if [ "$fail" = "0" ]; then printf '%s\n' 'OK: proxy tuning is live'; exit 0; fi
printf '%s\n' 'FAILED: see above'
exit 1
