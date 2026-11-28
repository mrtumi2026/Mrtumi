# One-time upgrade: live v3.6.0 to v3.6.1

**Not authorized by this file.** Run only after the owner approves the live release.

## Why `deploy.sh` is not used this once

The script that runs is the copy already on the server (v3.6.0), and it uses the v3.6.0 helper files. Code review and a local sandbox run showed that the v3.6.0 pipeline:

1. reads a backup manifest field that does not exist, so the restore rehearsal always fails;
2. cannot restore a dump as a separate rehearsal user, because of `DEFINER` clauses;
3. writes the maintenance rules to `public/.htaccess` instead of the cPanel document root.

All three are fixed in v3.6.1, so `deploy.sh` is for releases after it. The fixed steps 3-8 passed in a local sandbox (MariaDB 10.11, without the signature preflight). They have **not** run on the cPanel server, and the 503 rules have not been tried on its web server.

## Scope check

v3.6.1 changes no database migration, `package.json` or `package-lock.json`. Confirm on the server; the command must print nothing:

```bash
git diff --stat HEAD <TARGET_SHA> -- src/db/migrations package.json package-lock.json
```

If it prints anything, stop.

## Steps

In `~/mrtumi`, with the Node environment active. Stop at the first failure.

```bash
git status --porcelain -uno          # must print nothing
git rev-parse HEAD                   # note it: this is the rollback commit
git fetch origin main --tags
DEPLOY_ENVIRONMENT=production DEPLOY_RELEASE_TAG=v3.6.1 \
  node scripts/ops/verify-release-approval.js <TARGET_SHA> ~/release-ticket-v3.6.1.json v3.6.1
node scripts/ops/production-db-audit-and-backup.js
git merge --ff-only <TARGET_SHA>
mkdir -p tmp && touch tmp/restart.txt
node scripts/health-check.js
```

Then place one test order and log in to each portal.

## Rollback

No schema change, so code rollback is enough:

```bash
git checkout --detach <ROLLBACK_SHA> && touch tmp/restart.txt && node scripts/health-check.js
```
