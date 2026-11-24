#!/usr/bin/env bash
# Deploys the latest code of the API (and optionally the web app) on the server.
#
#   deploy/scripts/deploy.sh                 # API only
#   WEB_DIR=/opt/school-erp/web deploy/scripts/deploy.sh   # API + web build
#
# Steps: pull → install production dependencies → create database indexes →
# zero-downtime PM2 reload → health check. Stops at the first error. (Run the tests before deploying.)
set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_DIR="${WEB_DIR:-}"
WEB_ROOT="${WEB_ROOT:-/var/www/school-erp}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/v1/health}"

log() { printf '\n==> %s\n' "$*"; }

log "API: updating $API_DIR ($BRANCH)"
cd "$API_DIR"
git fetch --quiet origin "$BRANCH"
PREVIOUS=$(git rev-parse HEAD)
git checkout --quiet "$BRANCH"
git pull --ff-only --quiet origin "$BRANCH"
echo "  $PREVIOUS -> $(git rev-parse HEAD)"

log "API: installing production dependencies"
npm ci --omit=dev --no-audit --no-fund

log "API: creating database indexes"
NODE_ENV=production JOBS_ENABLED=false npm run --silent db:indexes | tail -1

log "API: reloading PM2"
if pm2 describe school-erp-api > /dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --env production --update-env
else
  pm2 start deploy/ecosystem.config.cjs --env production
fi
pm2 save > /dev/null

log "API: health check"
for i in $(seq 1 20); do
  if curl -fsS "$HEALTH_URL" > /dev/null; then echo "  healthy"; break; fi
  if [ "$i" = 20 ]; then
    echo "  API did not become healthy. Roll back with: git checkout $PREVIOUS && npm ci --omit=dev && pm2 reload school-erp-api" >&2
    exit 1
  fi
  sleep 1
done

if [ -n "$WEB_DIR" ]; then
  log "Web: building $WEB_DIR"
  cd "$WEB_DIR"
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet "$BRANCH"
  git pull --ff-only --quiet origin "$BRANCH"
  npm ci --no-audit --no-fund
  npm run build
  log "Web: publishing to $WEB_ROOT"
  # Copy new hashed assets first, then index.html, so open pages keep working during the switch.
  mkdir -p "$WEB_ROOT"
  rsync -a --exclude index.html dist/ "$WEB_ROOT/"
  cp dist/index.html "$WEB_ROOT/index.html"
fi

log "Done"
