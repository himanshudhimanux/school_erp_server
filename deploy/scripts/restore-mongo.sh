#!/usr/bin/env bash
# Restores a backup made by backup-mongo.sh.
#
#   deploy/scripts/restore-mongo.sh <archive.gz> <target-uri> [--drop]
#
# Practise on a scratch database first, e.g.
#   restore-mongo.sh /var/backups/school-erp/school-erp-school_erp-20261124T023000Z.archive.gz \
#     "mongodb://127.0.0.1:27017/school_erp_restore_test"
# The archive keeps the original database name; --nsFrom/--nsTo below rename it to the
# database in <target-uri>. --drop replaces existing collections (needed for a real restore).
# Stop the API (pm2 stop school-erp-api) before restoring over the live database.
set -euo pipefail

ARCHIVE="${1:?usage: restore-mongo.sh <archive.gz> <target-uri> [--drop]}"
TARGET="${2:?usage: restore-mongo.sh <archive.gz> <target-uri> [--drop]}"
DROP="${3:-}"
[ -f "$ARCHIVE" ] || { echo "No such file: $ARCHIVE" >&2; exit 1; }

# Database name inside the archive (from the file name written by backup-mongo.sh, or SOURCE_DB=...).
BASE=$(basename "$ARCHIVE")
SOURCE_DB="${SOURCE_DB:-$(echo "$BASE" | sed -E 's/^school-erp-(.+)-[0-9]{8}T[0-9]{6}Z\.archive\.gz$/\1/')}"
[ "$SOURCE_DB" != "$BASE" ] || SOURCE_DB=""
TARGET_DB=$(echo "$TARGET" | sed -E 's#^[a-z+]+://[^/]+/([^?]*).*#\1#')
: "${SOURCE_DB:?Could not tell the source database from the file name; set SOURCE_DB=<name>}"
: "${TARGET_DB:?Put the database name in the target URI}"

echo "Restoring $SOURCE_DB from $ARCHIVE into $TARGET_DB ${DROP:+(dropping existing collections)}"
read -r -p "Type the target database name to continue: " CONFIRM
[ "$CONFIRM" = "$TARGET_DB" ] || { echo "Aborted"; exit 1; }

ARGS=(--uri="$TARGET" --gzip --archive="$ARCHIVE" --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*")
[ "$DROP" = "--drop" ] && ARGS+=(--drop)
mongorestore "${ARGS[@]}"
echo "Restore finished. Run 'npm run db:indexes' if you restored into a fresh database."
