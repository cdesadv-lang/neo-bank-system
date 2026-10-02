#!/usr/bin/env bash
# Restore a backup produced by scripts/backup.sh into a TARGET database.
#   scripts/restore.sh backups/neobank-20261002-013000.dump postgresql://neobank:...@localhost:5432/neobank_restore
# Restore into a NEW/empty database first, verify (trial balance, reconciliation report), then switch over.
set -euo pipefail
FILE="${1:?usage: restore.sh <dump-file> <target-database-url>}"
TARGET="${2:?usage: restore.sh <dump-file> <target-database-url>}"
TARGET="${TARGET%%\?*}"
if [[ -f "$FILE.sha256" ]]; then sha256sum -c "$FILE.sha256"; fi
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$TARGET" "$FILE"
echo "Restored $FILE into $TARGET"
