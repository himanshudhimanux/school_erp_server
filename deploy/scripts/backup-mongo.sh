#!/usr/bin/env bash
# Backs up the School ERP database with mongodump (compressed archive) and removes old backups.
#
#   deploy/scripts/backup-mongo.sh
#
# Settings (environment or the backend .env file):
#   MONGODB_URI          connection string (read from ../../.env if not set)
#   BACKUP_DIR           where archives are written      (default /var/backups/school-erp)
#   BACKUP_KEEP_DAYS     delete local archives older than this (default 14)
#   BACKUP_RCLONE_REMOTE optional rclone destination for an off-site copy, e.g. r2:erp-backups
#                        (Cloudflare R2 / S3 / Google Drive — configure with `rclone config`)
#
# Cron (daily at 02:30):  30 2 * * * /opt/school-erp/backend/deploy/scripts/backup-mongo.sh >> /var/log/school-erp-backup.log 2>&1
#
# A backup you have never restored is not a backup: test deploy/scripts/restore-mongo.sh regularly
# against a scratch database.
set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -z "${MONGODB_URI:-}" ] && [ -f "$API_DIR/.env" ]; then
  MONGODB_URI=$(grep -E '^MONGODB_URI=' "$API_DIR/.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
fi
: "${MONGODB_URI:?MONGODB_URI is not set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/school-erp}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

command -v mongodump > /dev/null || { echo "mongodump not found: install mongodb-database-tools" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DB_NAME=$(echo "$MONGODB_URI" | sed -E 's#^[a-z+]+://[^/]+/?([^?]*).*#\1#')
DB_NAME="${DB_NAME:-test}"   # no database in the URI = MongoDB default "test"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# The database name is part of the file name; restore-mongo.sh reads it from there.
FILE="$BACKUP_DIR/school-erp-$DB_NAME-$STAMP.archive.gz"
echo "$(date -u +%FT%TZ) backup -> $FILE"
# --oplog gives a consistent point-in-time snapshot on a replica set (not supported on Atlas shared tiers).
EXTRA=()
if [ "${BACKUP_OPLOG:-false}" = "true" ]; then EXTRA+=(--oplog); fi
mongodump --uri="$MONGODB_URI" --db="$DB_NAME" --gzip --archive="$FILE" "${EXTRA[@]}" --quiet
chmod 600 "$FILE"
SIZE=$(du -h "$FILE" | cut -f1)
echo "$(date -u +%FT%TZ) done ($SIZE)"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$FILE" "$BACKUP_RCLONE_REMOTE/" --quiet
  echo "$(date -u +%FT%TZ) copied to $BACKUP_RCLONE_REMOTE"
fi

find "$BACKUP_DIR" -name 'school-erp-*.archive.gz' -type f -mtime +"$BACKUP_KEEP_DAYS" -print -delete | sed 's/^/removed old backup: /'
