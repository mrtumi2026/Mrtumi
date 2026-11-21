# COD-FIRST STAGING READINESS KIT (rev 2)

Operator runbook for staging the COD-first launch build. **Documentation only** — every
command below is executed by the owner/DBA on staging infrastructure, never by the
repository automation, and never against production.

| Item | Value |
|---|---|
| Branch | `arena/b73fcbd6-mrtumi` |
| Build SHA | `647c9a5957d270fb39067b83834e30665fd3f239` |
| Previous SHA | `48edc358df29731330e0c419386de40ae3ddbbe7` |
| Pull request | #5 (open, **must not be merged** during staging) |
| Deployment target | staging only |
| Production access | prohibited in this exercise |
| Revision | 2 (supersedes the chat-only rev 1, which described `48edc35`) |

## 0. What changed since rev 1 — and why it matters for staging

Commit `647c9a5` (`fix(checkout): only offer payment methods that are enabled and configured`)
is included in this build. It does not touch migrations (`git diff 48edc35..647c9a5` shows 0
migration files), but it changes what the runway must verify:

1. Storefront checkout renders **only** payment methods that are explicitly enabled and fully
   configured in `payment_gateways`. The synthesized bKash/Nagad/Rocket fallbacks, the
   `fallbackPhone` lookup and the hard-coded `01973437395` are gone from the checkout page,
   the quick-order widget and `listCheckoutMethods()`.
2. Display and order creation now share one rule
   (`src/services/paymentMethodEligibility.js`), so a forged or incomplete method is rejected
   server-side with `409 CONFLICT` before any order row is written.
3. A row is offered only when `status = 1` **and** `is_active` is `1` or `NULL`. A row that is
   enabled but still holds the seeded placeholder wallet `01711-000000` (or any malformed
   number) or has empty instructions is **hidden and rejected**. Do not work around this by
   editing code or inventing wallet numbers — leave manual MFS disabled until the owner
   supplies real values.
4. Automated/API gateway codes (`bkash_api`, `nagad_api`, `rocket_api`) are not offered by the
   storefront checkout in this build. Keep them disabled for the COD-first launch.

Expected COD-first checkout state after Phase 4: exactly one payment method, `cod`.

---

## 1. Phase 0 — pre-flight on the staging host

Run as the deploy user, in the application directory.

```bash
git rev-parse HEAD                     # expect 647c9a5957d270fb39067b83834e30665fd3f239
git status --porcelain                 # expect: empty
node -v                                # expect: >= 22.5.0 (CI: 22.23.4)
mysql --version                        # record engine + version
ls -l "$HOME/.mrtumi_maintenance.lock" 2>/dev/null   # expect: no such file
```

Record the host facts the runbook cannot know: domain + TLS certificate source, application
root, Node binary path, process manager, proxy-hop count, MySQL host/port, storage paths, cron
availability, backup destination.

**Stop if:** SHA differs, the tree is dirty, a maintenance lock exists, or the database host is
production.

---

## 2. Migration status & checksum requirements for `647c9a5`

Staging must run with `NODE_ENV=production` — the configuration layer accepts only
`development`, `test` or `production` (`src/config/env.js`), so:

* full production validation applies (secrets, HTTPS `APP_URL`, absolute `UPLOAD_DIR`, `TRUST_PROXY`);
* every migration command needs `CONFIRM_PRODUCTION_MIGRATION=true`;
* `npm run migrate:up` can exit **0** while doing nothing if a maintenance lock exists. Always
  assert the printed line `Migrations applied: N`.

### 2.1 Checksums on disk at this SHA

`0030`–`0033` differ from `origin/main`; `0034`–`0038` are byte-identical. None of the
on-disk hashes is present in `KNOWN_CHECKSUM_ALIASES`, so a staging database seeded from
`main`'s bytes hard-fails with `MIGRATION_CHECKSUM_MISMATCH`.

| Version | This build (`647c9a5`, sha256) | `origin/main` (sha256) | Nature of difference |
|---|---|---|---|
| `0030` | `5553eccd11d8815866ded7d6f17ac1a9c701fd3234add6f78ab64e104207ec08` | `86941f4e456c3828620dee883810692f541958ab02c80b61bac6d0b6fe90d216` | comments only |
| `0031` | `0b16399bf1434067b7dda20147c09fae899632277b4aba1a23199debe523c595` | `943aaae204db011f06347fbe3121ff666e8ef1e32abda13cc40b90931a22b4c9` | comments only |
| `0032` | `ad0bc53e5aea7e7d1761559186fde9a9664eb136d481c08ab999720847e5e458` | `cdb8b5e939d8fb5d35ddead6bb6cbcded847f64f31b81ad8bbbe4b439bbc4c0c` | comments only |
| `0033` | `0c0a3f9daf43c93bc5ed3c97ca5559b87efa74f784e5eb138fc6554f2b84e391` | `5fae1e8f79c6c3973a2936d5f9f20955dbe9603438b5f078be145bab7f4e72fe` | **semantic**: deactivates retired channels instead of deleting them |

Migration inventory at this SHA: 38 paired migrations, `0001`–`0038`.

### 2.2 Detection (read-only SQL on staging)

```sql
SELECT `version`,`checksum`,`applied_at`
FROM `schema_migrations`
WHERE `version` BETWEEN '0030' AND '0038'
ORDER BY `version`;
```

Compare `0030`–`0033` against the table above. `0034`–`0038` must match `origin/main`.

### 2.3 Safe rebuild (never patch checksums)

Required when a staging database was created from `main`'s migration bytes, or after a failed
migration. Staging data is disposable by definition.

1. Take a backup first (§6.1) and confirm the dump file is non-empty.
2. Record `schema_migrations` and row counts for the evidence pack.
3. Drop and recreate the **staging** schema (owner/DBA ticket; verify the target name twice).
4. `CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:up` → expect `Migrations applied: 38`.
5. Re-apply Phase 4 (migrations re-enable all seven gateway channels — see §4.1).
6. Re-run Phases 5–7.

**Never** hand-edit `schema_migrations`, and never rebase `0033`. Its `down` migration only
deactivates channels and drops columns — it is not a data rollback.

---

## 3. Phase 1 — environment validation

```bash
git clone <STAGING_REPO_URL> mrtumi-staging && cd mrtumi-staging
git checkout --detach 647c9a5957d270fb39067b83834e30665fd3f239
npm ci --omit=dev
mkdir -p <UPLOAD_DIR> <VENDOR_DOCUMENT_DIR> <CUSTOMER_RETURN_EVIDENCE_DIR> <BACKUP_DIR>
cp .env.example .env && chmod 600 .env
```

Fill `.env` from §7 (owner-supplied values only — placeholders below are not values):

```
NODE_ENV=production
APP_URL=https://<STAGING_DOMAIN>
TRUST_PROXY=<PROXY_HOP_COUNT>
SESSION_SECRET=<32+ RANDOM>
CSRF_SECRET=<32+ RANDOM, DIFFERENT>
UPLOAD_DIR=<ABSOLUTE PATH OUTSIDE APP ROOT>
VENDOR_PII_KEY=<RANDOM>
VENDOR_DOCUMENT_DIR=<ABSOLUTE PATH>
CUSTOMER_RETURN_EVIDENCE_DIR=<ABSOLUTE PATH>
DB_CLIENT=mysql
DB_HOST=<STAGING_DB_HOST>
DB_PORT=3306
DB_NAME=<STAGING_DB_NAME>
DB_USER=<RUNTIME_DB_USER>
DB_PASSWORD=<RUNTIME_DB_PASSWORD>
DB_CHARSET=utf8mb4
DB_TIMEZONE=+00:00
TZ=Asia/Dhaka
DEFAULT_LOCALE=bn
SUPPORTED_LOCALES=bn,en
ALLOW_PRODUCTION_DEMO_SEED=false
```

Validate without starting the server (prints no secrets):

```bash
NODE_ENV=production node -e "const{env}=require('./src/config/env');console.log('env ok',env.nodeEnv,env.db.client,env.db.host,env.db.name,env.appUrl)"
```

Expected: `env ok production mysql <host> <db> https://<domain>`.
Stop if it throws — the message names the missing variable only.

Payment/SMS/courier provider variables stay unset. `CONFIRM_PRODUCTION_MIGRATION=true` is used
only inline for migration commands.

---

## 4. Phase 2 — database privileges

DBA creates the staging schema and a least-privilege runtime account. `npm run db:privileges:check`
accepts only `SELECT, INSERT, UPDATE, DELETE` on the application schema and rejects global or
DDL privileges on the runtime account:

```sql
-- illustrative; DBA adapts host/name placeholders
CREATE USER '<RUNTIME_DB_USER>'@'<APP_HOST>' IDENTIFIED BY '<RUNTIME_DB_PASSWORD>';
GRANT SELECT, INSERT, UPDATE, DELETE ON `<STAGING_DB_NAME>`.* TO '<RUNTIME_DB_USER>'@'<APP_HOST>';
```

```bash
DB_PRIVILEGE_ROLE=app-runtime npm run db:privileges:check
```

Expected: no violations. Migration and backup principals are separate and reviewed by the DBA.
Stop if the runtime account holds DDL/global rights.

---

## 5. Phase 3 — apply and verify migrations

```bash
CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:status   # before
CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:up
CONFIRM_PRODUCTION_MIGRATION=true npm run migrate:status   # after
```

Expected sequence:

1. Before: 38 rows, all `applied=false` (fresh staging schema).
2. `Migrations applied: 38`.
3. After: 38 rows, all `applied=true`, no checksum or ordering errors.

Stop conditions: `PAUSED` (maintenance lock), `MIGRATION_CHECKSUM_MISMATCH`,
`OUT_OF_ORDER_MIGRATION`, `MISSING_APPLIED_MIGRATION_FILE`. Recover per §2.3.

---

## 6. Phase 4 — payment channel lock-down (COD only)

**Order matters:** migration `0033` re-activates all seven channels on (re)application, so
lock-down always follows the migration.

Safest supported method: sign in as the platform administrator and use
`/admin/payment-gateways`, toggling each automated channel off. The toggle writes both
`status` and `is_active` in one transaction and records an audit entry.

| Code | Required state |
|---|---|
| `cod` | `status=1`, `is_active=1` |
| `bkash_api`, `nagad_api`, `rocket_api` | `0 / 0` |
| `bkash_manual`, `nagad_manual`, `rocket_manual` | `0 / 0` — owner has not supplied wallet numbers/instructions |

Read-only verification (staging):

```sql
SELECT `code`,`mode`,`gateway_type`,`status`,`is_active`,
       CASE WHEN `account_number` IN ('', '01711-000000') THEN 'not configured' ELSE 'configured' END AS wallet_state
FROM `payment_gateways`
ORDER BY `code`;
```

Do **not** enable manual MFS, and do not replace the seeded placeholder with a fabricated
number. A row that is enabled but unconfigured is now hidden by design.

### 6.1 Assertion — `/api/checkout/payment-methods` returns COD only

```bash
curl -s "$APP_URL/api/checkout/payment-methods" | tee payment-methods.json
```

Expected JSON body (single method):

```json
{"success":true,"methods":[{"code":"cod","name":"Cash on Delivery (COD)","gateway_type":"auto","account_number":"","instructions":"..."}]}
```

Pass criteria, all required:

1. `methods` has exactly one element and `methods[0].code === "cod"`;
2. `account_number` is empty for COD;
3. the response contains no `bkash`, `nagad` or `rocket` entry and no wallet number:
   ```bash
   grep -Eo 'bkash|nagad|rocket|01[3-9][0-9]{8}' payment-methods.json && echo FAIL || echo PASS
   ```
4. the checkout page (`/customer/checkout` with a cart) renders exactly one `.pay-option`
   whose radio value is `cod`;
5. the storefront quick-order `<select id="qoPaymentMethod">` ends up with exactly one option,
   value `cod`, no `data-account` values (options are replaced from the API response).

If any manual brand or a wallet number appears: **stop** — do not open the store to customers.

---

## 7. Phase 5 — Super Admin provisioning (single account, by ticket)

No MySQL bootstrap exists; `BOOTSTRAP_ADMIN_*` only affect the SQLite development path. The
first administrator is a controlled DBA action.

1. Generate the hash off-host; the password never enters shell history:
   ```bash
   read -rs ADMIN_PW && printf '%s' "$ADMIN_PW" | node -e "const b=require('bcryptjs');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(b.hashSync(d.trim(),12)))"; unset ADMIN_PW
   ```
2. DBA executes, in one transaction, on **staging only** (placeholders, never plaintext):
   ```sql
   START TRANSACTION;
   INSERT INTO `roles` (`name`,`slug`,`permissions_json`,`status`)
   VALUES ('Super Admin','super_admin','["all"]',1)
   ON DUPLICATE KEY UPDATE `status`=1;

   INSERT INTO `users` (`role_id`,`name`,`email`,`phone`,`password_hash`,`role_label`,`status`)
   VALUES (
     (SELECT `id` FROM `roles` WHERE `slug`='super_admin' LIMIT 1),
     '<OWNER_NAME>','<OWNER_EMAIL>','<OWNER_PHONE>','<BCRYPT_HASH>','Super Admin',1
   );
   COMMIT;
   ```
3. Verify: `SELECT id,email,status,role_label FROM users;` → exactly one row; login at
   `/admin/login` → `/admin/dashboard`; `/admin/payment-gateways` renders the channel list.
4. Record the action (who/when/ticket) in the evidence pack. Password delivered out of band;
   changed immediately after first login.
5. Create no staff accounts and no role grants (D1 deferred; the gateway routes are guarded by
   `requireAdmin` only, so more accounts means more people who can toggle payment channels).

Schema notes verified for this SHA: `uq_users_email` unique, `uq_roles_slug` unique,
`role_id` FK `ON DELETE SET NULL`, `role_label` defaults to `Staff` and is display-only,
authorization uses the role slug (`super_admin` bypasses permission checks).

---

## 8. Phase 6 — health checks

```bash
curl -s "$APP_URL/health"        | tee health.json
curl -s "$APP_URL/api/v1/health" | python3 -m json.tool | head -20
node scripts/health-check.js "$APP_URL"
```

Expected:

* `/health` → HTTP 200, `status:"ok"`, `database.ok:true`, `database.client:"mysql"`;
* `/api/v1/health` → same payload;
* script → `Deployment Health Check: ALL CHECKS PASSED`, four 200s for `/`, `/customer/login`,
  `/customer/recovery`, `/customer/recovery/reset` plus security headers listed.

Always pass `$APP_URL` explicitly: the script defaults to `https://mrtumi.com` when no argument
is given (`scripts/health-check.js`).

Stop if any endpoint returns 5xx, `database.ok` is false, or a 503 appears on a GET route.

---

## 9. Phase 7 — COD checkout smoke (staging, disposable data)

Prerequisites: at least one approved, in-stock product and one active delivery location. Use
staging fixtures approved by the owner; delete them by rebuilding staging (§2.3), not by ad-hoc
`DELETE` statements across foreign keys.

1. **Guest COD order (browser):** add a product → `/customer/checkout` → COD selected by default
   → confirm → order success page shows an invoice number.
2. **Admin verification:** `/admin/orders` shows the order with `payment_method='cod'`,
   `payment_status` unpaid and the COD due equal to the order total.
3. **Quick order:** open the quick-order modal → payment select contains COD only → submit →
   order created.
4. **Assertion after both orders:** the payment-methods response is still COD-only (§6.1), and
   `payment_gateways` still has `0/0` for the three API and three manual MFS channels.
5. No SMS, no push, no provider call may fire.

Stop if COD is missing, if checkout is unavailable, or if any non-COD method appears.

### 9.1 Assertion — forged manual-MFS selection is rejected

With every MFS row disabled, post a checkout request that claims `payment_method=bkash`
(equivalent probe: `payment_method=bkash_manual`). Use staging fixtures and a synthetic test
phone `<TEST_SENDER_MSISDN>` supplied by the operator; no order or payment record may be
created.

```bash
# 1. session + CSRF token
curl -s -c cj -b cj "$APP_URL/customer/checkout" -o checkout.html
CSRF=$(grep -o 'name="_csrf" value="[^"]*"' checkout.html | head -1 | sed 's/.*value="//;s/"//')

# 2. forged quick-order request claiming a disabled MFS channel
curl -s -b cj -c cj -X POST "$APP_URL/order/quick-submit" \
  -H "Accept: application/json" -H "x-csrf-token: $CSRF" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "quick_order_request_key=<20-80 CHAR TEST KEY>" \
  --data "product_id=<STAGING_PRODUCT_ID>" \
  --data "delivery_location_id=<STAGING_LOCATION_ID>" \
  --data "qty=1" \
  --data "customer_name=<TEST NAME>" \
  --data "phone=<TEST_SENDER_MSISDN>" \
  --data "address=<TEST ADDRESS>" \
  --data "payment_method=bkash" \
  --data "trx_id=<SYNTHETIC TEST TRX>" \
  --data "sender_number=<TEST_SENDER_MSISDN>" \
  -w '\nHTTP %{http_code}\n'
```

Expected: **HTTP 409** with
`{"ok":false,"error":{"code":"CONFLICT","message":"This payment method is not active or is not supported at checkout."}}`.

Then prove nothing was written (read-only):

```sql
SELECT COUNT(*) AS orders_with_test_phone FROM `orders` WHERE `customer_phone` = '<TEST_SENDER_MSISDN>';
SELECT COUNT(*) AS pending_manual_payments FROM `order_payments` WHERE `status` = 'pending_verification';
```

Expected: `0` for the test phone, and no new `pending_verification` row from this probe. Take the
same counts before the probe so the comparison is unambiguous.

Stop immediately if the request succeeds, if an order row appears, or if the response is not a
4xx — that is a regression in the eligibility rule, not an environment problem.

If the staging catalog is not yet populated, defer this probe (and the COD smoke) until it is;
do not fabricate products, prices or delivery charges to unblock it.

---

## 10. Phase 8 — backup, restore rehearsal, evidence, teardown

### 10.1 Backup before migrations and before teardown

```bash
BACKUP_DIR=<BACKUP_DIR OUTSIDE APP ROOT> scripts/backup-db.sh
ls -lh <BACKUP_DIR>/mrtumi_*.sql.gz
gzip -t <BACKUP_DIR>/mrtumi_*.sql.gz && echo verified
```

The script sources `.env` through a shell parser — keep values free of unbalanced quotes/spaces,
or export credentials explicitly for the run. Default `BACKUP_DIR` is inside the app root, so
always override it.

### 10.2 Restore rehearsal

`npm run backup:restore:rehearsal` refuses remote hosts and any database name that is not a
disposable test name, so it cannot be pointed at a remote staging database by design.

* If staging MySQL is reachable only remotely: restore the dump into a throwaway schema on that
  same server with the `mysql` client, then verify `SELECT COUNT(*) FROM schema_migrations;`
  returns 38 and that key table counts match the source.
* If the operator runs a disposable local MySQL with a name matching `mrtumi_test` /
  `test_*`: `BACKUP_RESTORE_REHEARSAL=YES_I_AM_USING_A_DISPOSABLE_DATABASE npm run backup:restore:rehearsal`.

Record: dump file name, size, checksum, restore target, row counts before/after, and the
operator. A rehearsal is required before any production step; it is never run against production.

### 10.3 Evidence pack (store outside the repository)

* Build SHA `647c9a5` and `git status --porcelain` (empty);
* `migrate:status` before/after, and the `0030`–`0038` checksums read from `schema_migrations`;
* `db:privileges:check` output;
* `payment_gateways` state table (no wallet numbers in full);
* `payment-methods.json`, the COD-only grep result, and screenshots of the checkout page and
  quick-order select;
* `/health` JSON and the health-script output;
* COD order invoice numbers and their admin order screens;
* forged-probe request/response plus the before/after counts proving no order was written;
* backup + restore rehearsal evidence;
* Super Admin provisioning record (actor, timestamp, ticket) — never the password or hash.

### 10.4 Teardown

1. Take a final dump if the owner wants the environment preserved.
2. Stop the application process; remove the staging `.env` (it contains secrets).
3. Rotate or revoke every staging secret (`SESSION_SECRET`, `CSRF_SECRET`, `VENDOR_PII_KEY`, DB
   passwords) if the host is shared or will be reused.
4. Revoke the staging-only DB accounts, or drop the staging schema on the DBA's ticket.
5. Remove test records by rebuilding staging (§2.3); do not run ad-hoc deletes across foreign
   keys in a database that will be reused.
6. Record the teardown (who/when/what was destroyed) in the evidence pack.

---

## 11. Owner / DBA inputs required

| # | Input | Who | Notes |
|---|---|---|---|
| 1 | Staging domain + HTTPS certificate source | Owner/Host | `APP_URL` must be an HTTPS origin |
| 2 | Application root, Node binary, process manager, proxy-hop count | Host | Needed for `TRUST_PROXY` |
| 3 | Staging DB host/port/name; runtime, migration and backup accounts | DBA | Separate principals; runtime limited to DML |
| 4 | `SESSION_SECRET`, `CSRF_SECRET`, `VENDOR_PII_KEY` | Owner/DBA | Generate, never paste into tickets or chat |
| 5 | Absolute upload/vendor-document/return-evidence/backup paths | Owner/Host | Outside the app root, persistent |
| 6 | Super Admin name, email, phone, password delivery method | Owner | Hash generated by operator, cost 12 |
| 7 | Approved staging catalog: product(s), prices, stock, delivery locations | Owner | Required for COD smoke; do not invent |
| 8 | Confirmation of COD-only payment policy; manual MFS stays disabled | Owner | Wallet numbers/instructions are **not** being supplied now |
| 9 | Backup destination, retention, restore-rehearsal approval | Owner/DBA | Rehearsal is a go/no-go item |
| 10 | Privacy notice / customer-facing legal text for data collected in staging | Owner/Legal | No wording is invented here; staging customer accounts may be deferred |
| 11 | Whether staging customer accounts / vendor onboarding are exercised | Owner | Vendor-managed delivery drill needs an active vendor; otherwise platform-managed only |
| 12 | Approval ticket, tag/SHA record, window, launch sign-off name | Owner | D11/OD-15 |

---

## 12. Go / No-Go for staging execution

**Go requires all of the following**

- [ ] SHA is exactly `647c9a5957d270fb39067b83834e30665fd3f239`; tree clean
- [ ] `NODE_ENV=production` config validates on staging
- [ ] Runtime DB account passes `db:privileges:check`
- [ ] 38/38 migrations applied; `0030`–`0038` checksums match §2.1; no `PAUSED`
- [ ] `cod` enabled; `bkash_api`, `nagad_api`, `rocket_api`, `bkash_manual`, `nagad_manual`,
      `rocket_manual` all `status=0, is_active=0`
- [ ] `/api/checkout/payment-methods` returns COD only (§6.1)
- [ ] Forged `payment_method=bkash` probe → 409 and no order/payment row (§9.1)
- [ ] Exactly one Super Admin; login and `/admin/payment-gateways` verified
- [ ] `/health` 200 with `database.ok:true`; health script passes with explicit URL
- [ ] COD checkout smoke passed; quick-order shows COD only
- [ ] Backup taken; restore rehearsal recorded
- [ ] Evidence pack complete; teardown plan agreed

**No-Go if any of:** checksum/ordering failure, `PAUSED` migration run, COD missing from
checkout, any MFS/API method or wallet number visible, forged probe accepted, 5xx on health,
privilege violations, or a maintenance lock present.

**Out of scope for this runbook (unchanged by this build):** merging PR #5, production
deployment, production data, live provider calls, enabling manual MFS, refunds/settlements, and
Android release.
