# Mr. Tumi Grocery & Gift — Production Configuration Checklist

**Target Host:** BestWebHostBD (cPanel / CloudLinux / Phusion Passenger)  
**Target Domain:** `https://mrtumi.com`  
**Security Baseline:** Zero secrets in Git; least privilege accounts; strict HTTPS.

---

## 1. Environment Variables Configuration (`.env`)

Create `/home/username/.env` (or copy `.env.example` to `.env` in application root). Ensure permissions are set to `600` (`chmod 600 .env`):

### A. Core Runtime & Origin
- [ ] `NODE_ENV=production`
- [ ] `APP_NAME="Mr. Tumi Grocery & Gift"`
- [ ] `APP_URL=https://mrtumi.com` *(Must be the exact verified HTTPS origin)*
- [ ] `PORT=3000` *(Or assigned by Phusion Passenger)*
- [ ] `TRUST_PROXY=1` *(Set to the verified proxy-hop count behind CloudLinux/Apache)*

### B. Security Secrets (Generate using OpenSSL CLI)
- [ ] `SESSION_SECRET`: Minimum 32 random characters:
  ```bash
  openssl rand -hex 32
  ```
- [ ] `CSRF_SECRET`: Minimum 32 random characters *(MUST differ from `SESSION_SECRET`)*:
  ```bash
  openssl rand -hex 32
  ```
- [ ] `VENDOR_PII_KEY`: Minimum 32 random bytes (base64):
  ```bash
  openssl rand -base64 32
  ```

### C. BestWebHostBD MySQL Database
- [ ] `DB_CLIENT=mysql` *(Strictly required; SQLite is blocked in production)*
- [ ] `DB_HOST=127.0.0.1` *(or localhost)*
- [ ] `DB_PORT=3306`
- [ ] `DB_NAME=cpaneluser_mrtumi`
- [ ] `DB_USER=cpaneluser_dbuser`
- [ ] `DB_PASSWORD=YOUR_STRONG_DB_PASSWORD`
- [ ] `DB_CHARSET=utf8mb4`
- [ ] `DB_TIMEZONE=+00:00`
- [ ] `DB_CONNECTION_LIMIT=10`

### D. Persistent Storage Paths (Outside Application Root)
- [ ] `UPLOAD_DIR=/home/username/storage/uploads`
  *(Must be an absolute path outside app release directory to survive Git deployments)*
- [ ] `VENDOR_DOCUMENT_DIR=/home/username/storage/vendor_docs`
  *(Private directory for NID/trade licenses; never place inside public HTML)*
- [ ] `CUSTOMER_RETURN_EVIDENCE_DIR=/home/username/storage/return_evidence`
  *(Private directory for return photos; accessible only via authenticated handler)*

---

## 2. External Provider Integrations (When Supplied by Owner)

### A. Courier Integrations (Phase 10)
- [ ] **Steadfast Courier:**
  - `STEADFAST_BASE_URL=https://portal.packzy.com/api/v1`
  - `STEADFAST_API_KEY=your_api_key`
  - `STEADFAST_SECRET_KEY=your_secret_key`
- [ ] **Pathao Courier:**
  - `PATHAO_BASE_URL=https://api-hermes.pathao.com`
  - `PATHAO_CLIENT_ID=your_client_id`
  - `PATHAO_CLIENT_SECRET=your_client_secret`
  - `PATHAO_USERNAME=your_username`
  - `PATHAO_PASSWORD=your_password`
- [ ] **RedX Courier:**
  - `REDX_BASE_URL=https://openapi.redx.com.bd/v1.0.0-beta`
  - `REDX_ACCESS_TOKEN=your_access_token`

### B. SMS & Verification (Phase 13)
- [ ] **Bulk SMS BD:**
  - `BULKSMSBD_BASE_URL=http://bulksmsbd.net/api`
  - `BULKSMSBD_API_KEY=your_bulksms_api_key`
  - `BULKSMSBD_SENDER_ID=your_sender_id`
  - `VENDOR_OTP_SMS_ENABLED=true` *(Set to true only after validating account balance and sender ID)*

### C. Digital Marketing & Analytics (Phase 14)
- [ ] `ANALYTICS_ATTRIBUTION_ENABLED=false` *(Keep false until privacy policy approved by owner)*
- [ ] `GTM_CONTAINER_ID=GTM-XXXXXXX`
- [ ] `META_PIXEL_ID=XXXXXXXXXXXXXXX`

### D. Transactional Email (Phase 18)
- [ ] `SMTP_HOST=mail.mrtumi.com`
- [ ] `SMTP_PORT=465` (or 587)
- [ ] `SMTP_SECURE=true`
- [ ] `SMTP_USER=no-reply@mrtumi.com`
- [ ] `SMTP_PASSWORD=your_email_password`
- [ ] `SMTP_FROM_EMAIL=no-reply@mrtumi.com`
- [ ] `SMTP_FROM_NAME="Mr. Tumi Grocery & Gift"`

---

## 3. Server-Side Verification Steps

Before opening public traffic:
1. Run syntax and foundation check:
   ```bash
   node scripts/check-foundation.js
   ```
2. Verify MySQL migrations:
   ```bash
   npm run migrate:status
   ```
3. Test environment variables loading:
   ```bash
   node -e "require('./src/config/env'); console.log('Configuration Validated');"
   ```
4. Verify HTTPS and SSL certificate validity:
   ```bash
   curl -Iv https://mrtumi.com
   ```
