#!/usr/bin/env bash
# vibecode-deploy.sh — deploy a Nuxt 4 / Nitro app to a Bitrix24 Vibecode Black Hole server.
#
# Idempotent: finds a server by APP_NAME, creates it if missing, waits until the tunnel
# is CONNECTED, then runs a full deploy (install → optional preStart → start on :3000).
# Pulls source straight from a public archive URL (the bx-shef repo is public), so no
# git token is needed on the VM.
#
# Requires (env):
#   VIBE_KEY     vibe_api_...  (personal key; owns the server + billing)
#   APP_NAME     server/app name, e.g. "ai-price-import"
#   SOURCE_URL   tar.gz of the exact commit, e.g.
#                https://codeload.github.com/bx-shef/ai-price-import/tar.gz/<sha>
#   ENV_JSON     JSON object of RUNTIME env for the app (secrets: B24_*, DATABASE_URL, ...)
# Optional (env, with defaults):
#   VIBE_BASE    default https://vibecode.bitrix24.tech/v1
#   VIBE_PLAN    default bc-micro   (only bc-micro is allowed on RU/BY demo access)
#   VIBE_REGION  default ru-central1-b
#   VIBE_RUNTIME default node22
#   INSTALL_CMD  default: cd /opt/app && corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build
#   PRESTART_CMD default: (empty) — put pg/redis provisioning + apt toolchain here
#   START_CMD    default: cd /opt/app && HOME=/root HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs
#   PORT         default 3000  (Black Hole always tunnels :3000 — don't change without reason)
#   ACCESS_POLICY  default PUBLIC — REQUIRED for self-OAuth B24 apps (webhook + cross-portal iframe)
#
# NOTE: written against the documented Deploy API (docs: /docs/infra, /docs/infra/deploy).
# Verify the FIRST run interactively (see docs/DEPLOY_VIBECODE.md) before trusting it in CI.

set -euo pipefail

: "${VIBE_KEY:?set VIBE_KEY (vibe_api_...)}"
: "${APP_NAME:?set APP_NAME}"
: "${SOURCE_URL:?set SOURCE_URL (public tar.gz of the build context)}"
: "${ENV_JSON:={}}"

BASE="${VIBE_BASE:-https://vibecode.bitrix24.tech/v1}"
PLAN="${VIBE_PLAN:-bc-micro}"
REGION="${VIBE_REGION:-ru-central1-b}"
RUNTIME="${VIBE_RUNTIME:-node22}"
# --prod=false: nuxt build loads build-only modules (@nuxt/eslint) that live in devDependencies —
# if the platform defaults NODE_ENV=production for `install`, a prod-only install drops them and
# `pnpm build` fails "Cannot find module '@nuxt/eslint'". Force devDeps in for the build.
INSTALL_CMD="${INSTALL_CMD:-cd /opt/app && corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build}"
PRESTART_CMD="${PRESTART_CMD:-}"
# HOME=/root: the extraction agent (Claude Code CLI) writes its config under $HOME/.claude on first
# run; set it explicitly so a scrubbed start env can't leave HOME unset (matches the Dockerfile).
START_CMD="${START_CMD:-cd /opt/app && HOME=/root HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs}"
PORT="${PORT:-3000}"
ACCESS_POLICY="${ACCESS_POLICY:-PUBLIC}"

# The deploy-body Python heredoc below reads these from os.environ. Plain shell vars are NOT
# inherited by a child process, so EXPORT them — without this the body build dies KeyError:'RUNTIME'.
export RUNTIME INSTALL_CMD START_CMD PORT ENV_JSON SOURCE_URL PRESTART_CMD

# --connect-timeout bounds a hung connect so the 90×10s wait loop can't stall forever (no --max-time:
# the deploy POST with ?stream=false blocks until install+build finish, which legitimately takes minutes).
api() { curl -fsS --connect-timeout 15 -H "X-Api-Key: $VIBE_KEY" "$@"; }

echo "==> Looking up server '$APP_NAME'"
sid="$(APP_NAME="$APP_NAME" api "$BASE/infra/servers" | python3 -c '
import sys, json, os
d = json.load(sys.stdin)
name = os.environ["APP_NAME"]
print(next((s["id"] for s in d.get("data", []) if s.get("name") == name), ""))
')"

if [ -z "$sid" ]; then
  echo "==> Not found. Creating (provider=bitrix-cloud plan=$PLAN region=$REGION)"
  sid="$(api -X POST "$BASE/infra/servers" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"bitrix-cloud\",\"name\":\"$APP_NAME\",\"plan\":\"$PLAN\",\"region\":\"$REGION\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"
fi
echo "    server id: $sid"

echo "==> Waiting for status=running AND blackholeStatus=CONNECTED"
st=""; bh=""
for _ in $(seq 1 90); do
  # Tolerate a transient poll error: `|| true` keeps a network/HTTP blip from tripping
  # `set -e`/`pipefail` and aborting the whole deploy mid-wait — we just retry next tick.
  line="$(api "$BASE/infra/servers/$sid" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("status"),d.get("blackholeStatus"))' 2>/dev/null || true)"
  read -r st bh <<<"$line" || true
  echo "    status=${st:-?} blackhole=${bh:-?}"
  [ "${st:-}" = "running" ] && [ "${bh:-}" = "CONNECTED" ] && break
  [ "${st:-}" = "error" ] && { echo "server entered error state"; exit 1; }
  sleep 10
done
# Timed out without CONNECTED → do NOT proceed to deploy against a not-ready server.
[ "${st:-}" = "running" ] && [ "${bh:-}" = "CONNECTED" ] || {
  echo "timed out waiting for running+CONNECTED (last: status=${st:-?} blackhole=${bh:-?})"; exit 1
}

echo "==> Setting accessPolicy=$ACCESS_POLICY"
# PUBLIC is REQUIRED for this app (webhook + cross-portal iframe), but this call is SOFT on
# purpose: the exact access-policy endpoint/shape must be confirmed on the first live run
# (docs/DEPLOY_VIBECODE.md). A failure here does NOT abort the deploy — VERIFY the policy is
# actually PUBLIC in the cabinet after the first deploy; otherwise the webhook/iframe break.
api -X PATCH "$BASE/infra/servers/$sid/access-policy" -H 'Content-Type: application/json' \
  -d "{\"accessPolicy\":\"$ACCESS_POLICY\"}" >/dev/null || \
  echo "    (access-policy call failed — set it MANUALLY in the cabinet; PUBLIC is required)"

echo "==> Deploying"
body="$(python3 - <<'PY'
import json, os, shlex
d = {
    "source":  {"url": os.environ["SOURCE_URL"]},
    "runtime": os.environ["RUNTIME"],
    "install": os.environ["INSTALL_CMD"],
    "start":   os.environ["START_CMD"],
    "port":    int(os.environ["PORT"]),
    "env":     json.loads(os.environ["ENV_JSON"]),
}
# NUXT_PUBLIC_SITE_URL is baked at BUILD time: /install is prerendered and reads
# config.public.siteUrl from the frozen payload, so a runtime-only env var does NOT re-inject it
# (the served install/index.html keeps siteUrl:"" and /install refuses to bind the B24 event
# handlers). Bake it into the build command when known — so a (re)deploy with the appUrl set in
# ENV_JSON produces an ABSOLUTE handler URL regardless of whether the platform passes the deploy
# `env` into the install step. See docs/DEPLOY_VIBECODE.md §NUXT_PUBLIC_SITE_URL.
site = d["env"].get("NUXT_PUBLIC_SITE_URL", "")
if site and "pnpm build" in d["install"]:
    d["install"] = d["install"].replace("pnpm build", "NUXT_PUBLIC_SITE_URL=" + shlex.quote(site) + " pnpm build", 1)
pre = os.environ.get("PRESTART_CMD", "")
if pre:
    d["preStart"] = pre
print(json.dumps(d))
PY
)"

api -X POST "$BASE/infra/servers/$sid/deploy?stream=false" \
  -H 'Content-Type: application/json' \
  -H 'X-Skip-Source-Snapshot: CI deploy from public archive' \
  -d "$body" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("==> appUrl:",d.get("data",{}).get("appUrl","<none>"))'

echo "==> Done. Health: curl https://app-${sid}.vibecode.bitrix24.tech/api/health  (URL is in appUrl above)"
echo "==> FIRST DEPLOY: open <appUrl>/install and confirm «Обработчик событий» shows an ABSOLUTE URL"
echo "    (empty ⇒ NUXT_PUBLIC_SITE_URL was not set in ENV_JSON before this build — set it and redeploy)."
