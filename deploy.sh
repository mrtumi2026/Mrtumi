#!/usr/bin/env bash
# ==============================================================================
# MR. TUMI MARKETPLACE — AUTOMATED CPANEL / PRODUCTION DEPLOYMENT PIPELINE
# ==============================================================================
# Single-command zero-downtime deployment script for cPanel (BestwebhostBD)
# & Linux VPS environments.
#
# Usage:
#   chmod +x deploy.sh && ./deploy.sh
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================================================"
echo "   🚀 MR. TUMI MULTI-VENDOR — AUTOMATED PRODUCTION DEPLOYMENT"
echo "======================================================================"
echo "Started at: $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Working directory: $SCRIPT_DIR"

# ------------------------------------------------------------------------------
# STEP 1: Auto-Detect & Activate cPanel Node.js Virtual Environment (nodevenv)
# ------------------------------------------------------------------------------
echo ""
echo "🔍 [1/6] Detecting Node.js runtime environment..."

CPANEL_ACTIVATE=""
APP_BASENAME="$(basename "$SCRIPT_DIR")"

# Search in user's home directory if available
if [ -n "$HOME" ] && [ -d "$HOME/nodevenv" ]; then
  # Match nodevenv path specific to this app directory
  APP_MATCH=$(find "$HOME/nodevenv" -maxdepth 5 -type f -name "activate" 2>/dev/null | grep "/$APP_BASENAME/" | head -n 1 || true)
  if [ -n "$APP_MATCH" ] && [ -f "$APP_MATCH" ]; then
    CPANEL_ACTIVATE="$APP_MATCH"
  else
    # Fallback to any nodevenv activate script under $HOME/nodevenv
    CPANEL_ACTIVATE=$(find "$HOME/nodevenv" -maxdepth 5 -type f -name "activate" 2>/dev/null | head -n 1 || true)
  fi
fi

# Global wildcard fallback for CloudLinux / cPanel cagefs
if [ -z "$CPANEL_ACTIVATE" ]; then
  CPANEL_ACTIVATE=$(find /home/*/nodevenv -maxdepth 6 -type f -name "activate" 2>/dev/null | head -n 1 || true)
fi

if [ -n "$CPANEL_ACTIVATE" ] && [ -f "$CPANEL_ACTIVATE" ]; then
  echo "✔ Found cPanel Node.js virtual environment:"
  echo "  Source: $CPANEL_ACTIVATE"
  # shellcheck source=/dev/null
  source "$CPANEL_ACTIVATE"
else
  echo "ℹ No cPanel nodevenv found. Proceeding with system PATH."
fi

# Validate executables exist and are runnable
if ! command -v node >/dev/null 2>&1; then
  echo "❌ FATAL: 'node' executable not found in PATH."
  echo "   Please activate your cPanel Node.js app from the cPanel interface,"
  echo "   or check your environment PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ FATAL: 'npm' executable not found in PATH."
  echo "   Ensure npm is installed in your Node.js virtual environment."
  exit 1
fi

NODE_VERSION="$(node -v)"
NPM_VERSION="$(npm -v)"
echo "✔ Node.js executable: $(command -v node) ($NODE_VERSION)"
echo "✔ npm executable:     $(command -v npm) ($NPM_VERSION)"

# ------------------------------------------------------------------------------
# STEP 2: Repository & Branch Synchronization (Git)
# ------------------------------------------------------------------------------
echo ""
echo "📥 [2/6] Synchronizing repository with origin/main..."

if [ ! -d ".git" ]; then
  echo "❌ FATAL: No .git directory found in $SCRIPT_DIR."
  exit 1
fi

echo "  Fetching latest commits from origin/main..."
git fetch origin main

CURRENT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
echo "  Current commit: $CURRENT_COMMIT"

echo "  Resetting hard to origin/main to eliminate untracked or dirty local drifts..."
git reset --hard origin/main

NEW_COMMIT="$(git rev-parse --short HEAD)"
echo "✔ Synchronized cleanly to commit: $NEW_COMMIT"

# Ensure script itself and helpers remain executable after reset
chmod +x deploy.sh || true
chmod +x scripts/*.js 2>/dev/null || true

# ------------------------------------------------------------------------------
# STEP 3: Production Dependencies Installation
# ------------------------------------------------------------------------------
echo ""
echo "📦 [3/6] Installing production dependencies with npm ci..."

# Ensure clean production install strictly respecting package-lock.json
npm ci --only=production

echo "✔ Production dependencies installed successfully."

# ------------------------------------------------------------------------------
# STEP 4: Safe Database Migrations
# ------------------------------------------------------------------------------
echo ""
echo "🗄️  [4/6] Executing database migrations..."

# Migration status check
echo "  Current migration status:"
node scripts/migrate.js status || true

echo "  Applying pending migrations (up to 0029_dynamic_mfs_payment_gateways)..."
if ! CONFIRM_PRODUCTION_MIGRATION=true node scripts/migrate.js up; then
  echo ""
  echo "❌ FATAL: Database migration failed!"
  echo "   Aborting deployment pipeline to safeguard database integrity."
  exit 1
fi

echo "✔ Database migrations completed safely."

# ------------------------------------------------------------------------------
# STEP 5: Verification & Governance Harness
# ------------------------------------------------------------------------------
echo ""
echo "🧪 [5/6] Running End-to-End verification harness..."

if ! node scripts/test-e2e-order-flow.js; then
  echo ""
  echo "❌ FATAL: E2E verification test failed!"
  echo "   Please investigate the error above before serving traffic."
  exit 1
fi

echo "✔ E2E multi-vendor order flow, ledger balance, and courier checks verified."

# ------------------------------------------------------------------------------
# STEP 6: Process Reload (PM2 and Phusion Passenger / cPanel)
# ------------------------------------------------------------------------------
echo ""
echo "🔄 [6/6] Reloading application processes..."

RELOADED_VIA=""

# 6a. Check for PM2 process manager
if command -v pm2 >/dev/null 2>&1; then
  echo "  Detected PM2 in environment."
  if [ -f "ecosystem.config.js" ]; then
    echo "  Reloading PM2 cluster via ecosystem.config.js..."
    pm2 reload ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production
    pm2 save || true
    RELOADED_VIA="PM2 Cluster"
  fi
fi

# 6b. Always trigger Phusion Passenger reload (cPanel standard)
# cPanel Passenger monitors tmp/restart.txt to gracefully restart workers
mkdir -p tmp
touch tmp/restart.txt
chmod 666 tmp/restart.txt 2>/dev/null || true

if [ -n "$RELOADED_VIA" ]; then
  RELOADED_VIA="$RELOADED_VIA + Phusion Passenger (tmp/restart.txt)"
else
  RELOADED_VIA="Phusion Passenger (tmp/restart.txt)"
fi

echo "✔ Application reload signal sent via: $RELOADED_VIA"

# ------------------------------------------------------------------------------
# DEPLOYMENT SUMMARY
# ------------------------------------------------------------------------------
echo ""
echo "======================================================================"
echo "   ✅ DEPLOYMENT FINISHED SUCCESSFULLY!"
echo "======================================================================"
echo "Commit deployed:  $NEW_COMMIT"
echo "Completed at:     $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Process reloaded: $RELOADED_VIA"
echo "Platform:         Mr. Tumi Multi-Vendor Marketplace (100% Production Ready)"
echo "======================================================================"
exit 0
