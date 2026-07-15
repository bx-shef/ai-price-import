#!/usr/bin/env bash
# validate-docs.sh — оффлайн-валидация доков триажа и вынесенных скриптов.
# Не делает НИ ОДНОГО реального вызова GitHub API. Запуск: bash scripts/validate-docs.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DOC="docs/FEEDBACK_TRIAGE_AGENT.md"
CLAUDE_MD="CLAUDE.md"
SH="scripts/feedback-triage.sh"
fail=0
note() { printf '%s\n' "$*"; }

note "== 1. Синтаксис bash (bash -n) =="
if bash -n "$SH"; then note "OK: $SH"; else note "FAIL: синтаксис $SH"; fail=1; fi

note "== 2. shellcheck (если установлен) =="
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -x "$SH"; then note "OK: shellcheck"; else note "FAIL: shellcheck"; fail=1; fi
else
  note "SKIP: shellcheck не найден (apt-get install shellcheck / brew install shellcheck)"
fi

note "== 3. Dry-run функций с моком curl (без сети) =="
dry=$(mktemp); trap 'rm -f "$dry" /tmp/_ft_body.md' EXIT
{
  sed -n '/^set -euo pipefail/,$p' "$SH"
  # стаб сетевого слоя: перекрываем _api после определения (резолв функций — на этапе вызова),
  # чтобы прогнать реальную сборку payload (mktemp/umask/python/strip-лейблов) без сети.
  echo '_api() { printf "%s" "{\"html_url\":\"https://example/mock\"}"; }'
  echo 'GH_WRITE_TOKEN=mock'
  echo 'echo "## body" > /tmp/_ft_body.md'
  echo 'create_issue "o/r" "T" /tmp/_ft_body.md "bug, enhancement" >/dev/null'
  echo 'comment_issue "o/r" 1 "c"'
  echo 'close_transferred "o/r" 1'
  echo 'echo DRYRUN_OK'
} > "$dry"
if out=$(bash "$dry" 2>&1) && printf '%s' "$out" | grep -q DRYRUN_OK; then
  note "OK: dry-run функций"
else
  note "FAIL: dry-run"; printf '%s\n' "$out"; fail=1
fi

note "== 4. Согласованность правила лимитов (CLAUDE.md <-> doc) =="
if grep -q "REST-core" "$CLAUDE_MD" && grep -q "GitHub API Rate Limits" "$DOC"; then
  note "OK: доки ссылаются на единое правило"
else
  note "FAIL: правило лимитов разошлось / нет ссылки"; fail=1
fi

note "== 5. Приватность: в doc есть privacy-guard про публичный репо =="
if grep -qiE "публичн" "$DOC"; then note "OK: privacy-guard присутствует"; else note "FAIL: нет оговорки о приватности"; fail=1; fi

if [ "$fail" -eq 0 ]; then note "== ИТОГ: OK =="; else note "== ИТОГ: ЕСТЬ ОШИБКИ =="; fi
exit "$fail"
