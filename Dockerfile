# syntax=docker/dockerfile:1
# procure-ai (redesign) — single Nitro node image serving the prerendered pages
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
# nuxt build → .output: Nitro node server incl. prerendered static pages in public/.
RUN pnpm build

FROM node:22-slim AS backend
WORKDIR /app
# Text-extraction toolchain (file-extract worker): PDF text, office→text, OCR with
# Russian + Belarusian + Kazakh + English language packs (docs/redesign 06 §6).
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      libreoffice-calc libreoffice-writer \
      tesseract-ocr tesseract-ocr-rus tesseract-ocr-bel tesseract-ocr-kaz \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Headless extraction agent (AGENT_BIN=claude): the Claude Code CLI, spawned per job
# as a PURE text→JSON extractor against DeepSeek's Anthropic-compatible endpoint
# (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL). Without it the pipeline fails «spawn claude ENOENT».
RUN npm install -g @anthropic-ai/claude-code@2.1.207
ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads
# HOME must be defined + writable: the agent subprocess (secret-free env via agentSpawnEnv)
# passes HOME through, and Claude Code writes its config under $HOME/.claude on first run.
ENV HOME=/root
RUN mkdir -p /data/uploads /root/.claude
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
