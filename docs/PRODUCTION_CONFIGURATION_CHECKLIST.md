# Mr. Tumi Grocery & Gift — Production Configuration & Handover Checklist

**Target Host:** BestWebHostBD (cPanel / CloudLinux / Phusion Passenger)  
**Target Domain:** `https://mrtumi.com`  
**Node.js Target:** Version 22.x LTS  
**Database Target:** MySQL 8.0 InnoDB (`utf8mb4_unicode_ci`)  
**Security Baseline:** Zero credentials in Git; least-privilege accounts; strict HTTPS; session-bound CSRF.

---

## 1. BestWebHostBD cPanel Deployment Setup

### A. Setup Node.js Application in cPanel
1. Log into your cPanel account on BestWebHostBD.
2. Under **Software**, click **Setup Node.js App**.
3. Click **Create Application** and configure:
   - **Node.js version:** Select `22.x` (or latest 22.x LTS available).
   - **Application mode:** `Production`.
   - **Application root:** `/home/username/mrtumi` (Recommended: keep application root outside `public_html`).
   - **Application URL:** `mrtumi.com` (maps to `public_html`).
   - **Application startup file:** `server.js`.
4. Click **Create**.
5. Once created, copy the virtual environment activation command displayed at the top of the cPanel page (e.g. `source /home/username/nodevenv/mrtumi/22/bin/activate && cd /home/username/mrtumi`).

### B. Deploy Code from Git
Connect via SSH or cPanel Terminal:
```bash
# Clone the verified launch branch into the application root
cd /home/username
git clone -b antigravity/final-launch-readiness https://github.com/mrtumi2026/Mrtumi.git mrtumi
cd mrtumi

# Enter virtual environment and install production dependencies
source /home/username/nodevenv/mrtumi/22/bin/activate
npm ci --omit=dev
```

---

## 2. Environment Variables Configuration (`.env`)

In the application root (`/home/username/mrtumi/.env`), create the production `.env` file.  
Set file permissions to `600` so only your cPanel user can read it:
```bash
touch .env && chmod 600 .env
```

Populate `.env` with the following configuration:

### A. Core Runtime & Origin
```ini
NODE_ENV=production
APP_NAME="Mr. Tumi Grocery & Gift"
APP_URL=https://mrtumi.com
PORT=3000
# BestWebHostBD Apache/Passenger proxy hop count:
TRUST_PROXY=1
TZ=Asia/Dhaka
DEFAULT_LOCALE=bn
SUPPORTED_LOCALES=bn,en
CURRENCY_CODE=BDT
CURRENCY_SYMBOL=৳
```

### B. Security Secrets (Generate using OpenSSL)
Generate cryptographically strong 32-character random keys:
```bash
# Generate in terminal:
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```
Add to `.env`:
```ini
# REQUIRED: Must be at least 32 characters and must NOT start with REPLACE_WITH_
SESSION_SECRET=paste_first_generated_hex_key_here
# REQUIRED: Must differ from SESSION_SECRET
CSRF_SECRET=paste_second_generated_hex_key_here
# Dedicated encryption key for vendor PII (trade licenses, NID)
VENDOR_PII_KEY=paste_third_generated_base64_key_here
```

### C. MySQL Database Connection
Create a database and database user in cPanel under **MySQL Databases**, and assign full permissions to the user for this database:
```ini
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=cpaneluser_mrtumi
DB_USER=cpaneluser_dbuser
DB_PASSWORD=YOUR_STRONG_DB_PASSWORD
DB_CHARSET=utf8mb4
DB_TIMEZONE=+00:00
DB_CONNECTION_LIMIT=10
```

### D. Persistent Storage Directories & Permissions
Storage directories must be outside the Git repository so application updates and Git pulls never overwrite uploaded customer or vendor files:
```bash
# Create durable storage folders in your cPanel home directory
mkdir -p /home/username/storage/uploads
mkdir -p /home/username/storage/vendor_docs
mkdir -p /home/username/storage/return_evidence
chmod 750 /home/username/storage/uploads
chmod 700 /home/username/storage/vendor_docs
chmod 700 /home/username/storage/return_evidence
```
Add to `.env`:
```ini
UPLOAD_DIR=/home/username/storage/uploads
VENDOR_DOCUMENT_DIR=/home/username/storage/vendor_docs
CUSTOMER_RETURN_EVIDENCE_DIR=/home/username/storage/return_evidence
```

---

## 3. Database Migrations Execution

Run the versioned migration runner across all 29 reversible migration pairs:
```bash
source /home/username/nodevenv/mrtumi/22/bin/activate
cd /home/username/mrtumi

# Check migration status (all should show PENDING before initial apply)
npm run migrate:status

# Execute all migrations
npm run migrate:up

# Verify all 29 migrations are APPLIED
npm run migrate:status
```

---

## 4. HTTPS, Secure Cookies & Session Hardening

1. **SSL/TLS Certificate:**
   - In cPanel, verify **SSL/TLS Status**. Ensure an AutoSSL or custom SSL certificate is active for `mrtumi.com` and `www.mrtumi.com`.
   - Enable **Force HTTPS Redirection** in cPanel **Domains**.
2. **Cookie Security:**
   - In production (`NODE_ENV=production`), the application automatically enforces:
     - `httpOnly: true` (prevents JavaScript access to cookies)
     - `sameSite: 'lax'` (CSRF protection)
     - `secure: true` (transmitted only over HTTPS)
     - Session ID rotation upon login/logout.

---

## 5. Courier, SMS & Payment Provider Credentials

Once commercial accounts are established, populate these sections in `/home/username/mrtumi/.env`:

### A. Courier Integrations
```ini
# Steadfast Courier (portal.packzy.com)
STEADFAST_BASE_URL=https://portal.packzy.com/api/v1
STEADFAST_API_KEY=your_steadfast_api_key
STEADFAST_SECRET_KEY=your_steadfast_secret_key

# Pathao Courier (api-hermes.pathao.com)
PATHAO_BASE_URL=https://api-hermes.pathao.com
PATHAO_CLIENT_ID=your_pathao_client_id
PATHAO_CLIENT_SECRET=your_pathao_client_secret
PATHAO_USERNAME=your_pathao_account_email
PATHAO_PASSWORD=your_pathao_account_password

# RedX Courier (openapi.redx.com.bd)
REDX_BASE_URL=https://openapi.redx.com.bd/v1.0.0-beta
REDX_ACCESS_TOKEN=your_redx_bearer_token
```

### B. BulkSMSBD Gateway
```ini
BULKSMSBD_BASE_URL=http://bulksmsbd.net/api
BULKSMSBD_API_KEY=your_bulksms_api_key
BULKSMSBD_SENDER_ID=your_registered_sender_id
# Set to true ONLY after account balance and sender ID are verified:
VENDOR_OTP_SMS_ENABLED=true
```

### C. Transactional Email / SMTP
```ini
SMTP_HOST=mail.mrtumi.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=no-reply@mrtumi.com
SMTP_PASSWORD=your_email_password
SMTP_FROM_EMAIL=no-reply@mrtumi.com
SMTP_FROM_NAME="Mr. Tumi Grocery & Gift"
```

---

## 6. Scheduled Tracking Synchronization Cron Job

To automatically synchronize courier delivery statuses, transition delivered/RTO packages, and reconcile COD collections, add a cron job in cPanel:
1. In cPanel, go to **Cron Jobs**.
2. Under **Add New Cron Job**:
   - **Common Settings:** Every 15 minutes (`*/15 * * * *`).
   - **Command:**
     ```bash
     cd /home/username/mrtumi && /home/username/nodevenv/mrtumi/22/bin/node scripts/sync-courier-tracking.js --limit=100 >> /home/username/logs/courier-sync.log 2>&1
     ```
3. Click **Add New Cron Job**.

---

## 7. Backup and Restore Procedures

### A. Daily Automated Database Backup
Create `/home/username/scripts/backup-db.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/home/username/backups/db"
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d_%H%M%S)
mysqldump -u cpaneluser_dbuser -p'YOUR_STRONG_DB_PASSWORD' --single-transaction --quick --default-character-set=utf8mb4 cpaneluser_mrtumi | gzip > "$BACKUP_DIR/mrtumi_$DATE.sql.gz"
# Keep backups for 30 days
find "$BACKUP_DIR" -type f -name "mrtumi_*.sql.gz" -mtime +30 -delete
```
Make executable: `chmod 700 /home/username/scripts/backup-db.sh`.  
Add to cPanel Cron Jobs to run daily at 2:00 AM: `0 2 * * * /home/username/scripts/backup-db.sh`.

### B. Database Restore Procedure
In case recovery is ever needed:
```bash
# Decompress and restore into database
gunzip -c /home/username/backups/db/mrtumi_YYYYMMDD_HHMMSS.sql.gz | mysql -u cpaneluser_dbuser -p'YOUR_STRONG_DB_PASSWORD' cpaneluser_mrtumi
```

### C. Persistent Storage Backup
```bash
# Archive customer and vendor files
tar -czf /home/username/backups/uploads_$(date +%Y%m%d).tar.gz -C /home/username/storage uploads vendor_docs return_evidence
```

---

## 8. Error Logs, Monitoring & Process Restart

1. **Application Health Check:**
   - URL: `https://mrtumi.com/health`
   - Response: `{"status":"ok","uptime":123.45,"timestamp":"2026-11-05T13:45:00.000Z"}`
2. **Passenger Application Logs:**
   - Look in `/home/username/mrtumi/logs/` or `/home/username/stderr.log`.
   - cPanel: **Metrics > Errors**.
3. **Application Restart (Zero-Downtime Reload):**
   ```bash
   touch /home/username/mrtumi/tmp/restart.txt
   ```
   Or in cPanel **Setup Node.js App**, click the **Restart** button.

---

## 9. Emergency Response & Rollback

If an operational anomaly occurs post-launch:
1. **Revert Application Code:**
   ```bash
   cd /home/username/mrtumi
   git checkout <PREVIOUS_COMMIT_SHA>
   touch tmp/restart.txt
   ```
2. **Reverse a Migration:**
   ```bash
   # Reverses the last applied migration pair
   npm run migrate:down -- 1
   touch tmp/restart.txt
   ```
3. **Safe Fail-Closed Design:**
   - All external provider failures fail closed without mutating financial ledgers or leaking customer PII.
