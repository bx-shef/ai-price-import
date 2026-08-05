# syntax=docker/dockerfile:1
# AI-импорт прайсов (redesign) — single Nitro node image serving the prerendered pages
# (landing + in-portal UI) AND the backend API/pipeline. The extraction stage needs
# system binaries (pdftotext / libreoffice / tesseract) baked in. docs/redesign 02, 06, 09.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Bake the build commit into the footer/health (prerendered at build time).
ARG COMMIT_SHA=dev
ENV NUXT_PUBLIC_COMMIT_SHA=$COMMIT_SHA
# Deployment URL + build date must be baked too — the landing and /install are PRERENDERED, so their
# canonical/OG tags and the footer stamp are frozen into static HTML here; a runtime env can no longer
# change them. Both are optional: an unset SITE_URL falls back to the canonical landing home
# (utils/landing.siteBaseUrl) so og:image stays absolute, and an unset BUILD_DATE just omits <lastmod>.
ARG NUXT_PUBLIC_SITE_URL=""
ENV NUXT_PUBLIC_SITE_URL=$NUXT_PUBLIC_SITE_URL
ARG BUILD_DATE=""
ENV NUXT_PUBLIC_BUILD_DATE=$BUILD_DATE
# Счётчик Яндекс Метрики. ⚠ Читается в `nuxt.config.ts` на СБОРКЕ — сниппет впекается в статический
# HTML лендинга, поэтому рантайм-переменная его не включает (и выглядит это как «внёс, а не
# работает»). ⚠ Пустое значение = счётчика нет вовсе: так и должно быть на форке и на инсталляции
# клиента — иначе там поднялся бы счётчик издателя.
ARG NUXT_PUBLIC_METRIKA_ID=""
ENV NUXT_PUBLIC_METRIKA_ID=$NUXT_PUBLIC_METRIKA_ID
# nuxt build → .output: Nitro node server incl. prerendered static pages in public/.
RUN pnpm build
# Guard the defect this replaces: a RELATIVE og:image ships silently and is dropped by Facebook and
# LinkedIn, so the failure only shows up as "the shared link has no picture". Assert on the frozen
# prerendered HTML — the one place where it is too late to fix at runtime.
# Two separate assertions, and the tag is matched ATTRIBUTE-ORDER-INDEPENDENTLY: unhead serialises
# attributes in insertion order with no sort, and it already emits `data-hid` on keyed tags in this
# project — a single pattern pinning `property="og:image" content="` would start failing on an
# unrelated unhead change, with a message blaming the wrong thing.
# Braces, NOT parentheses: `exit 1` inside `( … )` leaves only the subshell, so the first assertion's
# status would be discarded and a missing file would print BOTH messages — the misleading one last.
RUN test -f .output/public/index.html \
    || { echo 'BUILD FAILED: .output/public/index.html missing — is "/" still in nitro.prerender.routes?' >&2; exit 1; }; \
    grep -oE '<meta[^>]*property="og:image"[^>]*>' .output/public/index.html | grep -q 'content="https\?://' \
    || { echo 'BUILD FAILED: og:image in the prerendered landing is not an absolute URL.' >&2; exit 1; }
# The same assertion for the OTHER half of the policy, on the RENDERED output rather than on source.
# The unit guard reads `app/pages/*.vue`, so it cannot see how a tag actually serialises, nor a page
# reaching the crawler through a mechanism other than a page file. Here every spelling question and
# every prerender mechanism collapses into one check: the shipped HTML either carries the tag or not.
RUN for p in app settings metrics install import login queues; do \
      grep -q '<meta name="robots"[^>]*content="[^"]*noindex' ".output/public/$p/index.html" \
      || { echo "BUILD FAILED: /$p is prerendered without robots:noindex — it would be indexed on the landing's domain." >&2; exit 1; }; \
    done

# Постоянные адреса редакций юридических документов (#415) — тот же класс проверки, но по другой
# причине: `nitropack` по умолчанию НЕ роняет сборку на ошибке пререндера (`failOnError: false`),
# поэтому пропавшие снимки дают exit 0 и образ, где страница архива ссылается на четыре 404 —
# «ссылка из договора ведёт в никуда», молча. Живой прогон это уже показал: `.dockerignore`
# исключает `docs` целиком, и снимков в контексте не оказалось. Гард в тестах сторожит строки
# `.dockerignore`, а здесь проверяется РЕЗУЛЬТАТ — файл на диске.
RUN for d in eula privacy site-terms site-privacy; do \
      test -f ".output/public/$d/archive/index.html" \
      || { echo "BUILD FAILED: /$d/archive not prerendered." >&2; exit 1; }; \
      ls .output/public/$d/archive/*/index.html >/dev/null 2>&1 \
      || { echo "BUILD FAILED: /$d/archive has no edition pages — docs/archive missing from the build context?" >&2; exit 1; }; \
    done

# Third guard of the same kind, for the no-nginx target's security headers (#185 п.1). The bug it
# replaces was invisible to every unit test: Nitro answers a prerendered page from the public-assets
# handler, which runs BEFORE server/middleware, so headers set there never reached any HTML — `/app`
# shipped with no CSP (hence no frame-ancestors, no clickjacking protection) while `/api/health`
# carried the full set. Only the RUNNING server can show that, so boot it here and ask it.
# `/app` and `/api/health` together are the point: one static, one dynamic — the original defect was
# precisely that the dynamic half passed while the static half did not.
# The probe is plain node, not curl/wget: neither is guaranteed in a slim base, and a guard that
# silently no-ops because its tool is missing is worse than no guard. `$!`, not `%1`: job control is
# off in a non-interactive RUN shell.
COPY docker/check-edge-headers.mjs /tmp/check-edge-headers.mjs
RUN APP_EDGE_SECURITY=1 NITRO_PORT=3999 node .output/server/index.mjs & \
    SRV=$!; node /tmp/check-edge-headers.mjs; RC=$?; kill $SRV 2>/dev/null; exit $RC

FROM node:22-slim AS backend
WORKDIR /app
# Text-extraction toolchain (file-extract worker): PDF text, office→text, OCR with
# Russian + Belarusian + Kazakh + English language packs (docs/redesign 06 §6).
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      libreoffice-calc libreoffice-writer \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus tesseract-ocr-bel tesseract-ocr-kaz \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Extraction is a pure OpenAI-compatible chat call (DeepSeek/BitrixGPT via the `openai` SDK,
# in-process) — no subprocess agent, so no CLI binary to install. Provider + key come from env
# (LLM_PROVIDER + DEEPSEEK_API_KEY / VIBE_API_KEY); see docs/redesign 03-stack.
ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads
ENV HOME=/root
# Bake the build commit into the RUNTIME too. `GET /api/health` (and any route rendered at runtime
# by Nitro rather than prerendered) reads `useRuntimeConfig().public.commitSha` at REQUEST time — the
# build-stage ENV only covered the prerendered HTML, so without this the server falls back to the
# nuxt.config default ('dev'). ARG must be re-declared after FROM to be in scope in this stage; the
# deploy passes COMMIT_SHA as a build-arg to every matrix target (see .github/workflows/deploy.yml).
ARG COMMIT_SHA=dev
ENV NUXT_PUBLIC_COMMIT_SHA=$COMMIT_SHA
# Same reason, same trap, two more values. `/robots.txt` and `/sitemap.xml` are RUNTIME routes (they
# must resolve the host per deploy, so they are not prerendered) — they read `siteUrl`/`buildDate` at
# REQUEST time. Set only in the build stage, both would stay at the nuxt.config defaults here and
# `<lastmod>` would never ship. Since #304 the baked canonical/og:url ignore the build-arg entirely
# (always the prod constant); SITE_URL on both stages still matters for the /install prerender and
# the runtime Sitemap:/<loc>. The runtime stage is what makes the repo variable the SINGLE source:
# the crawler routes read it from the container env, which the image provides — so a prod .env does
# not need the line at all. `env_file` still outranks image ENV, which is the escape hatch for a
# client deploy on its own domain (and the trap: a bare `KEY=` wipes the baked value).
ARG NUXT_PUBLIC_SITE_URL=""
ENV NUXT_PUBLIC_SITE_URL=$NUXT_PUBLIC_SITE_URL
ARG BUILD_DATE=""
ENV NUXT_PUBLIC_BUILD_DATE=$BUILD_DATE
RUN mkdir -p /data/uploads
# Fail the build FAST if the extraction toolchain is broken. A package rename / partial install
# would otherwise pass `docker build` and only surface at RUNTIME («fragile binary env» risk from the
# review). Assert every binary the file-extract worker spawns is present AND runnable, plus all four
# OCR languages (rus/bel/kaz/eng — docs/redesign 06 §6). NB: poppler's `pdftotext -v`/`pdftoppm -v`
# exit non-zero (99) even when healthy, so we grep the version line through a pipe — grep's status
# governs (no pipefail), which both ignores poppler's exit code and proves the binary actually ran.
# Each check greps the version LINE (tool name + a version digit), not the bare name: a present-but-
# unrunnable binary prints «<tool>: error while loading shared libraries…» which contains the name
# but no «<tool> <digit>», so it correctly fails. libreoffice --version is wrapped in `timeout` in
# case a broken profile-init hangs (a hang would otherwise stall the build).
RUN set -eu; \
    pdftotext -v 2>&1 | grep -qiE 'pdftotext version [0-9]'; \
    pdftoppm -v 2>&1 | grep -qiE 'pdftoppm version [0-9]'; \
    timeout 60 libreoffice --version 2>&1 | grep -qiE 'libreoffice [0-9]'; \
    tesseract --version 2>&1 | grep -qiE 'tesseract [0-9]'; \
    langs="$(tesseract --list-langs 2>&1)"; \
    for l in rus bel kaz eng; do echo "$langs" | grep -qx "$l" || { echo "missing tesseract lang: $l" >&2; exit 1; }; done
COPY --from=build /app/.output ./.output
# OTel bootstrap (телеметрия): loaded via NODE_OPTIONS=--import BEFORE the app so
# auto-instrumentation can hook http/pg/ioredis at module load. Its deps must live OUTSIDE the
# Nitro bundle (the bundler breaks OTel's require hooks), so install just this small set here.
# Fully INERT unless OTEL_EXPORTER_OTLP_ENDPOINT is set (the file no-ops) — the default deploy
# is unchanged. See docs/OBSERVABILITY.md.
COPY otel.instrument.mjs /app/otel.instrument.mjs
COPY otel-preload-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
# Absolute path: --import resolves relative to CWD, so an absolute path stays correct regardless
# of where node is launched from. Quote the value: the ENV KEY=VALUE form treats a space as a
# second var separator, so the `--import <path>` value MUST be quoted.
ENV NODE_OPTIONS="--import /app/otel.instrument.mjs"
EXPOSE 3000
# Liveness is GET /api/health (docs/redesign 02).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD NODE_OPTIONS= node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]

# ── app: the front reverse proxy (behind the shared nginx-proxy) ──────────────
# Non-root nginx (listens :8080). Adds login rate-limit, internal-endpoint deny,
# CSP/security headers for the B24 iframe, body-size caps. Proxies to backend:3000.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS app
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY proxy_common.conf /etc/nginx/proxy_common.conf
# Fail the build on a bad config (proxy_pass hostnames resolve at runtime, not here).
RUN nginx -t
EXPOSE 8080
