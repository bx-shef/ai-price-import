#!/usr/bin/env bash
# feedback-triage.sh — helper-функции для триажа обратной связи через GitHub REST API.
#
# Назначение: создание/комментирование/закрытие issue, когда путь MCP недоступен
# (см. docs/FEEDBACK_TRIAGE_AGENT.md §8). Это FALLBACK; основной путь — MCP/GraphQL.
#
# ИСПОЛЬЗОВАНИЕ: `source scripts/feedback-triage.sh` (файл — библиотека функций).
#   Строгий режим (set -euo pipefail) НЕ включается при source — иначе он протёк бы
#   в интерактивный шелл оператора. Функции устойчивы к ошибкам явными проверками.
#
# ТОКЕН: требуется GH_WRITE_TOKEN — fine-grained PAT, ограниченный ТОЛЬКО целевыми
#   репозиториями и правом Issues: Read and write (без Contents/кода).
#   GITHUB_TOKEN_INGEST для записи НЕ годится (read-only → 'Resource not accessible').
#
# БЕЗОПАСНОСТЬ:
#   - Токен передаётся в curl через `--config` из stdin (`-K -`), а НЕ через argv,
#     чтобы он не был виден в `ps`/`/proc/<pid>/cmdline` другим локальным юзерам.
#     Дополнительно: не включайте `set -x` при заданном токене; держите его вне
#     shell-history (HISTIGNORE / unset после).
#   - REST не поддерживает state_reason 'duplicate' (только completed/not_planned) —
#     для дубля используйте MCP с duplicate_of, либо not_planned + комментарий.
#   - ПРИВАТНОСТЬ (fail-closed): репо кода bx-shef/ai-price-import — ПУБЛИЧНЫЙ. Запись
#     в feedback-репо (comment_issue/close_transferred) проходит через guard
#     `_assert_feedback_target`, который ОТКАЗЫВАЕТ, если FEEDBACK_REPO не задан или
#     равен публичному PROJECT_REPO (защита от утечки jobId/УНП/№ сделки/компаний в
#     world-readable issue). Осознанный оверрайд — FEEDBACK_ALLOW_PUBLIC=1. Опционально
#     live-проверка приватности (GET /repos → private) — FEEDBACK_VERIFY_PRIVATE=1.

# Строгий режим — только при ПРЯМОМ запуске, не при source (см. шапку).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -euo pipefail
fi

API="https://api.github.com"

# Целевые репозитории — параметризованы (переопределяемы через env).
# PROJECT_REPO — публичный репо кода/задач (issue заводятся ОБЕЗЛИЧЕННО).
# FEEDBACK_REPO — приватный приёмник отзывов (тот же ENV GITHUB_FEEDBACK_REPO, что у
# ingestion-канала). Пусто, если явно не задан — тогда запись в feedback-репо упадёт
# на guard'е (fail-closed), а не уйдёт молча в публичный код-репо.
PROJECT_REPO="${PROJECT_REPO:-bx-shef/ai-price-import}"
FEEDBACK_REPO="${FEEDBACK_REPO:-${GITHUB_FEEDBACK_REPO:-}}"

# Формат slug owner/repo (как в backend/feedback.js — defence-in-depth от path-traversal).
_FT_SLUG_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

# Emit a `curl --config` snippet carrying the auth header (keeps the token out of argv).
# Reads GH_WRITE_TOKEN fail-closed.
_auth_config() {
  : "${GH_WRITE_TOKEN:?GH_WRITE_TOKEN не задан (fine-grained PAT, Issues:write)}"
  printf 'header = "Authorization: Bearer %s"\n' "$GH_WRITE_TOKEN"
}

# _validate_repo <owner/repo>
_validate_repo() {
  [[ "${1:-}" =~ $_FT_SLUG_RE ]] || { echo "repo '${1:-}' не в формате owner/repo" >&2; return 1; }
}

# _validate_num <n>
_validate_num() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || { echo "номер issue '${1:-}' не число" >&2; return 1; }
}

# _assert_feedback_target <repo> — guard приватности приёмника отзывов.
# Отказывает, если repo пуст / не slug / == публичному PROJECT_REPO (без FEEDBACK_ALLOW_PUBLIC=1).
# При FEEDBACK_VERIFY_PRIVATE=1 дополнительно проверяет приватность вживую (GET /repos).
_assert_feedback_target() {
  local repo="${1:-}"
  if [ -z "$repo" ]; then
    echo "FEEDBACK_REPO/GITHUB_FEEDBACK_REPO не задан — укажи ПРИВАТНЫЙ репо отзывов" >&2
    return 1
  fi
  _validate_repo "$repo" || return 1
  if [ "$repo" = "$PROJECT_REPO" ] && [ "${FEEDBACK_ALLOW_PUBLIC:-0}" != "1" ]; then
    echo "отказ: FEEDBACK_REPO == PROJECT_REPO ($repo) — это ПУБЛИЧНЫЙ код-репо;" >&2
    echo "клиентский контекст туда писать нельзя. Задай приватный FEEDBACK_REPO" >&2
    echo "(или FEEDBACK_ALLOW_PUBLIC=1, если делаешь это осознанно)." >&2
    return 1
  fi
  if [ "${FEEDBACK_VERIFY_PRIVATE:-0}" = "1" ]; then
    local priv
    priv=$(_api GET "/repos/$repo" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("private"))' 2>/dev/null) || {
      echo "не удалось проверить приватность $repo (GET /repos)" >&2; return 1; }
    if [ "$priv" != "True" ]; then
      echo "отказ: $repo не приватный (private=$priv) — возможна утечка контекста" >&2
      return 1
    fi
  fi
}

# _api <method> <path> [data] — печатает тело ответа; ненулевой код на HTTP>=300 или
# транспортной ошибке curl. Без trap RETURN (он глобален и стрелял бы повторно из
# вызывающих функций под set -u); очистка временного файла — явная, на всех путях.
_api() {
  local method="$1" path="$2" data="${3:-}"
  local out code rc=0 cfg
  cfg=$(_auth_config) || return 1
  out=$(mktemp)
  local -a args=(-sS --connect-timeout 10 --max-time 30
                 -o "$out" -w '%{http_code}' -X "$method"
                 -K - -H "Accept: application/vnd.github+json")
  [ -n "$data" ] && args+=(--data-binary "$data")
  if ! code=$(printf '%s' "$cfg" | curl "${args[@]}" "$API$path"); then
    rc=$?; echo "curl transport error ($rc) при $method $path" >&2
    rm -f "$out"; return "$rc"
  fi
  cat "$out"; rm -f "$out"
  if [ "$code" -ge 300 ]; then
    echo "HTTP $code при $method $path" >&2
    return 1
  fi
  return 0
}

# create_issue <owner/repo> <title> <body-file> <label[,label...]>
# Заводит issue в ПУБЛИЧНОМ project-репо (тело — обезличенное, см. §5.1 доки).
create_issue() {
  local repo="${1:?create_issue: нужен owner/repo}" title="${2:?create_issue: нужен заголовок}"
  local bodyfile="${3:?create_issue: нужен файл тела}" labels="${4:-}"
  _validate_repo "$repo" || return 1
  local payload; payload=$(mktemp)
  if ! python3 - "$title" "$bodyfile" "$labels" > "$payload" <<'PY'
import sys, json
title, bodyfile, labels = sys.argv[1], sys.argv[2], sys.argv[3]
labs = [x.strip() for x in labels.split(",") if x.strip()]
body = open(bodyfile, encoding="utf-8").read()
print(json.dumps({"title": title, "body": body, "labels": labs}))
PY
  then
    echo "create_issue: не удалось собрать payload (нет файла '$bodyfile'?)" >&2
    rm -f "$payload"; return 1
  fi
  local resp
  resp=$(_api POST "/repos/$repo/issues" "@$payload") || { rm -f "$payload"; return 1; }
  rm -f "$payload"
  printf '%s' "$resp" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("html_url") or d)'
}

# comment_issue <owner/repo> <number> <text> — комментарий в feedback-репо (guard приватности).
comment_issue() {
  local repo="${1:?comment_issue: нужен owner/repo}" num="${2:?comment_issue: нужен номер}"
  local text="${3:?comment_issue: нужен текст комментария}"
  _assert_feedback_target "$repo" || return 1
  _validate_num "$num" || return 1
  local payload
  payload=$(python3 -c 'import sys,json;print(json.dumps({"body":sys.argv[1]}))' "$text") \
    || { echo "comment_issue: не удалось собрать payload" >&2; return 1; }
  _api POST "/repos/$repo/issues/$num/comments" "$payload" >/dev/null
}

# close_transferred <owner/repo> <number>  (REST: not_planned; duplicate недоступен)
close_transferred() {
  local repo="${1:?close_transferred: нужен owner/repo}" num="${2:?close_transferred: нужен номер}"
  _assert_feedback_target "$repo" || return 1
  _validate_num "$num" || return 1
  _api PATCH "/repos/$repo/issues/$num" '{"state":"closed","state_reason":"not_planned"}' >/dev/null
}

# Пример (запускать только с реальным GH_WRITE_TOKEN и приватным FEEDBACK_REPO):
#   export GITHUB_FEEDBACK_REPO=bx-shef/<private-feedback-repo>
#   source scripts/feedback-triage.sh
#   cat > /tmp/body.md <<'EOF'
#   ## Проблема ...
#   ## Источник (обратная связь, приватный репо)
#   - ${FEEDBACK_REPO}#43
#   EOF
#   create_issue      "$PROJECT_REPO"  "Заголовок по сути корня" /tmp/body.md "bug"
#   comment_issue     "$FEEDBACK_REPO" 43 "Перенесено: $PROJECT_REPO#329. Закрываю."
#   close_transferred "$FEEDBACK_REPO" 43
