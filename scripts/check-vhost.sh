#!/usr/bin/env sh
# Validate the per-vhost tuning files in deploy/vhost.d/ the way the shared front
# nginx-proxy will consume them: nginx-proxy `include`s each file INSIDE the vhost's
# server{} block, so we syntax-check every file included in a minimal server{} via
# `nginx -t -c`. This is the CI gate for GH #71 option 3 — until now the vhost.d syntax
# was only checked at apply time inside `make proxy-tune`, so a broken file could reach
# prod and 413/504 (or wedge the shared proxy on restart). Mirrors the `nginx -t -c`
# step in the Makefile `proxy-tune` target.
#
# Validates EVERY file and exits non-zero if ANY is invalid (all errors are printed).
# Prefers a LOCAL `nginx` binary (CI installs nginx via apt — so the required gate has no
# Docker Hub dependency to rate-limit) and falls back to a throwaway nginx container for
# local dev without nginx installed. Override the image with NGINX_IMAGE=… (pin it to the
# front proxy's nginx line — nginx-proxy:1.6-alpine ships nginx 1.27).
set -eu

DIR="deploy/vhost.d"
IMAGE="${NGINX_IMAGE:-nginx:1.27-alpine}"

if [ ! -d "$DIR" ]; then
  echo "no $DIR directory — nothing to validate"
  exit 0
fi

have_nginx=0
command -v nginx >/dev/null 2>&1 && have_nginx=1

found=0
rc=0
for f in "$DIR"/*; do
  [ -f "$f" ] || continue
  found=1
  abs="$(pwd)/$f"
  printf 'validating %s ... ' "$f"
  if [ "$have_nginx" = 1 ]; then
    # error_log/pid → /tmp and access_log off so `nginx -t` doesn't touch the default
    # /var/log/nginx/*.log paths (unwritable for a non-root CI user).
    tmp="$(mktemp)"
    printf 'error_log /tmp/vhost-err.log;\npid /tmp/vhost.pid;\nevents {}\nhttp { access_log off; server { include %s; } }\n' "$abs" > "$tmp"
    if nginx -t -c "$tmp" >/tmp/vhost-check.log 2>&1; then echo ok; else echo FAILED; cat /tmp/vhost-check.log; rc=1; fi
    rm -f "$tmp"
  else
    if docker run --rm --entrypoint sh \
        -v "$abs:/etc/nginx/vhost.d/candidate:ro" "$IMAGE" \
        -c 'printf "error_log /tmp/e.log;\npid /tmp/n.pid;\nevents{}\nhttp{ access_log off; server{ include /etc/nginx/vhost.d/candidate; }}\n" > /tmp/t.conf && nginx -t -c /tmp/t.conf' >/tmp/vhost-check.log 2>&1; then
      echo ok
    else
      echo FAILED; cat /tmp/vhost-check.log; rc=1
    fi
  fi
done

if [ "$found" = 0 ]; then
  echo "no files in $DIR — nothing to validate"
fi
exit "$rc"
