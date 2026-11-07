#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Automated Database Backup Script for Mr. Tumi Multi-Vendor Marketplace
# ==============================================================================
# Performs transactional, non-locking MySQL dumps, compresses with gzip,
# logs output, and prunes historical backups older than 7 days.
#
# Recommended cron setup (Runs daily at 03:00 AM BD time):
#   0 3 * * * /path/to/Mrtumi/scripts/backup-db.sh >> /var/log/mrtumi-db-backup.log 2>&1
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(dirname "$SCRIPT_DIR")"

# Load environment file if available
if [[ -f "${APP_ROOT}/.env" ]]; then
  # Export non-comment lines
  set -a
  # shellcheck disable=SC1091
  source <(grep -v '^\s*#' "${APP_ROOT}/.env" | grep -v '^\s*$')
  set +a
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-mrtumi_production}"
BACKUP_DIR="${BACKUP_DIR:-${APP_ROOT}/backups/mysql}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"
BACKUP_FILE="${BACKUP_DIR}/mrtumi_${DB_NAME}_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "=========================================================="
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting MySQL database backup..."
echo "Host: ${DB_HOST}:${DB_PORT} | Database: ${DB_NAME} | User: ${DB_USER}"
echo "Destination: ${BACKUP_FILE}"
echo "=========================================================="

export MYSQL_PWD="${DB_PASSWORD}"

# Dump with transactional safety (InnoDB) and routine/trigger preservation
mysqldump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --user="${DB_USER}" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  "${DB_NAME}" | gzip -9 > "${BACKUP_FILE}"

unset MYSQL_PWD

# Verify backup archive exists and is non-empty
if [[ ! -s "${BACKUP_FILE}" ]]; then
  echo "[ERROR] Database backup failed! Generated file is empty or missing: ${BACKUP_FILE}" >&2
  exit 1
fi

FILE_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
echo "[SUCCESS] Database backup completed successfully: ${BACKUP_FILE} (${FILE_SIZE})"

# Retention policy: Prune dumps older than retention period
echo "Pruning database backups older than ${RETENTION_DAYS} days in ${BACKUP_DIR}..."
PRUNED_COUNT=$(find "${BACKUP_DIR}" -type f -name "mrtumi_${DB_NAME}_*.sql.gz" -mtime +"${RETENTION_DAYS}" | wc -l)
find "${BACKUP_DIR}" -type f -name "mrtumi_${DB_NAME}_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
echo "[CLEANUP] Pruned ${PRUNED_COUNT} old backup archive(s)."
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup workflow finished."
