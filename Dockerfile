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
ENV NODE_ENV=production
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads
COPY --from=build /app/.output ./.output
EXPOSE 3000
# Liveness is GET /api/health (docs/redesign 02).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
