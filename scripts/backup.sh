#!/usr/bin/env bash
# PostgreSQL backup for Neo Bank (custom-format dump, compressed, with retention).
#   DATABASE_URL=postgresql://... scripts/backup.sh            (or reads .env)
#   BACKUP_DIR=/var/backups/neobank RETENTION_DAYS=30 scripts/backup.sh
# Cron example (daily 01:30 Cairo time, after EOD):
#   30 1 * * * cd /opt/neo-bank-system && BACKUP_DIR=/var/backups/neobank scripts/backup.sh >> /var/log/neobank-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
URL="${DATABASE_URL%%\?*}"   # pg_dump does not understand Prisma's ?schema= parameter
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/neobank-$STAMP.dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE" "$URL"
sha256sum "$FILE" > "$FILE.sha256"
chmod 600 "$FILE" "$FILE.sha256"
# Verify the archive is readable
pg_restore --list "$FILE" > /dev/null
find "$BACKUP_DIR" -name 'neobank-*.dump*' -mtime +"$RETENTION_DAYS" -delete
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
# Production: also copy off-site (encrypted object storage), e.g.
#   gpg --encrypt -r backup@bank "$FILE" && aws s3 cp "$FILE.gpg" s3://bank-backups/neobank/
