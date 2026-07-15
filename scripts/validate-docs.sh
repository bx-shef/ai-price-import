#!/usr/bin/env bash
# validate-docs.sh — оффлайн-валидация доков триажа и вынесенных скриптов.
# Не делает НИ ОДНОГО реального вызова GitHub API (curl замокан). Запуск:
#   bash scripts/validate-docs.sh
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
  if shellcheck -x "$SH" "$0"; then note "OK: shellcheck"; else note "FAIL: shellcheck"; fail=1; fi
else
  note "SKIP: shellcheck не найден (apt-get install shellcheck / brew install shellcheck)"
fi

note "== 3. Поведенческий прогон с моком curl (без сети): happy-path + guard'ы =="
# В отличие от простого стаба _api, здесь мокается САМ curl, а реальный _api
# (очистка mktemp, разбор http-кода, отсутствие протечки trap) прогоняется целиком —
# именно это ловит класс багов «функция падает при прямом вызове».
harness=$(mktemp); cap=$(mktemp); body=$(mktemp)
trap 'rm -f "$harness" "$cap" "$body"' EXIT
SCRIPT_ABS="$PWD/$SH"
cat > "$harness" <<HARNESS
CAP="$cap"; BODY="$body"; MOCK_CODE=\${MOCK_CODE:-200}
curl() {
  local out="" databin="" i; local -a a=("\$@")
  for ((i=0;i<\${#a[@]};i++)); do
    case "\${a[i]}" in
      -o) out="\${a[i+1]}";;
      --data-binary) databin="\${a[i+1]}";;
    esac
  done
  cat >/dev/null 2>&1 || true                        # drain -K - config (token) from stdin
  [ -n "\$out" ] && printf '{"html_url":"https://example/mock","private":true}' > "\$out"
  [ -n "\$databin" ] && [ "\${databin:0:1}" = "@" ] && cp "\${databin:1}" "\$CAP" 2>/dev/null
  printf '%s' "\$MOCK_CODE"
}
export GH_WRITE_TOKEN=mocktoken
export PROJECT_REPO="bx-shef/ai-price-import"
export GITHUB_FEEDBACK_REPO="bx-shef/feedback-private"
source "$SCRIPT_ABS"
rc=0; chk(){ if eval "\$2"; then :; else echo "SUBFAIL: \$1"; rc=1; fi; }
false; echo "sourced-safe (shell alive)"           # source не должен включать set -e
echo "## body" > "\$BODY"
chk "create_issue"        'create_issue "\$PROJECT_REPO" T "\$BODY" "bug, enhancement" >/dev/null'
chk "comment_issue"       'comment_issue "\$FEEDBACK_REPO" 43 "перенос"'
chk "close_transferred"   'close_transferred "\$FEEDBACK_REPO" 43'
chk "labels .strip()"     'grep -q "\"labels\": \[\"bug\", \"enhancement\"\]" "\$CAP"'
chk "no-token → fail"     '! ( unset GH_WRITE_TOKEN; create_issue "\$PROJECT_REPO" T "\$BODY" bug >/dev/null 2>&1 )'
chk "HTTP 404 → fail"     '! ( MOCK_CODE=404; close_transferred "\$FEEDBACK_REPO" 43 >/dev/null 2>&1 )'
chk "public target refused" '! comment_issue "\$PROJECT_REPO" 1 ctx >/dev/null 2>&1'
chk "bad repo → fail"     '! comment_issue "bad repo!" 1 x >/dev/null 2>&1'
chk "bad num → fail"      '! close_transferred "\$FEEDBACK_REPO" abc >/dev/null 2>&1'
chk "empty feedback → fail" '! ( unset FEEDBACK_REPO GITHUB_FEEDBACK_REPO; source "$SCRIPT_ABS"; comment_issue "\$FEEDBACK_REPO" 1 x >/dev/null 2>&1 )'
[ "\$rc" -eq 0 ] && echo BEHAVIOR_OK
HARNESS
if out=$(bash "$harness" 2>&1) && printf '%s' "$out" | grep -q BEHAVIOR_OK; then
  note "OK: поведенческий прогон (happy-path + 8 guard-кейсов)"
else
  note "FAIL: поведенческий прогон"; printf '%s\n' "$out"; fail=1
fi

note "== 4. Согласованность правила лимитов (CLAUDE.md <-> doc) =="
if grep -q "REST-core" "$CLAUDE_MD" && grep -q "GitHub API Rate Limits" "$DOC"; then
  note "OK: доки ссылаются на единое правило"
else
  note "FAIL: правило лимитов разошлось / нет ссылки"; fail=1
fi

note "== 5. Privacy-guard: содержательная формулировка (не одно слово) =="
# Якорим на конкретный блок, а не на любое вхождение «публичн» (иначе «публичные
# комментарии» в §9 давали бы ложный OK).
if grep -q "Privacy-guard" "$DOC" && grep -qiE "не копируй|УНП" "$DOC"; then
  note "OK: privacy-guard присутствует содержательно"
else
  note "FAIL: privacy-guard выродился в упоминание слова"; fail=1
fi

note "== 6. Конвенция CLAUDE.md: '> Last reviewed: YYYY-MM-DD' под H1 =="
if grep -qE '^> Last reviewed: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$DOC"; then
  note "OK: шапка Last reviewed есть"
else
  note "FAIL: нет шапки '> Last reviewed: YYYY-MM-DD'"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "== ИТОГ: OK =="; else note "== ИТОГ: ЕСТЬ ОШИБКИ =="; fi
exit "$fail"
