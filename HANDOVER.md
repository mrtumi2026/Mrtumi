# HANDOVER — Mr. Tumi (read this first)

Updated: 2026-11-26 (Asia/Dhaka). Branch: `fix/launch-blockers`, based on tag `v3.5.0` (`23e6045`).
**Release status: NO-GO. Nothing on this branch has been deployed.**
This file is the current status. Older status/report documents are history; do not rely on their "ready" claims.
Security details are intentionally brief because the repository is public. Ask the owner.

## Rules
- Do NOT deploy `main`: it is older than `v3.5.0` and includes a destructive payment-gateway migration.
- Owner launch scope: own products, vendors and resellers together; referral and affiliate must work.
- Keep every super admin option. Repair broken ones; do not remove them.
- No secrets in Git or chat. No production deploy, migration or deletion without the owner's approval.
- No database migration was added on this branch.

## Done on this branch
- Unused or unfinished payment-gateway and courier endpoints are disabled; manual bKash/Nagad/Rocket review works.
- SMTP email (e.g. Brevo) with admin settings and a test button. New dependency: nodemailer.
- Admin menu pages that failed in production now work, including create/approve/delete.
- Vendor money: admin buttons for vendor order delivery and COD reconciliation (Admin > Vendors > Vendor orders & settlement). Settlement release and vendor withdrawal verified.
- Referral/affiliate rewards are now credited when vendor delivery completes an order; quick orders keep affiliate attribution; affiliate withdrawal debit is atomic.
- New Admin > Affiliate & Referral page (withdrawal decisions, commission rates, referral settings).
- Broken legacy vendor split is no longer called (files kept; do not reconnect them).
- Vendor courier quote button no longer errors. Parcel weight is assumed to be 500 g per unit.
- Provenance note: part of the first payment/courier edit and `tests/launch-blockers.test.js` appeared in the workspace without a recorded step in the assistant's history. It was read and re-tested; an independent review is advised.

## Owner-approved rules now implemented
- Customer wallet at checkout: signed-in customers (order phone must match the account) may pay at most N% of the product price after coupon, delivery charge excluded, rounded down to whole taka. Default N=20; change it in Admin > Affiliate & Referral > Customer wallet payment (0 switches it off; 100 is not allowed). Main checkout only, not quick order or campaign pages.
  - The wallet part is stored inside `orders.discount_paisa`, so `total_paisa` is the cash still to be paid; sales and discount reports reflect that. `customer_wallet_transactions` records the wallet amount, and it returns to the wallet when the order is cancelled, failed or returned.
- Reseller orders for our own products: delivered, then admin presses "Money received" (Admin > Reseller Commerce > Wallets), then after the return window "Release all matured settlements". Only then can the reseller withdraw. An open return or refund holds the earning.
- A referral order placed with the referrer's own phone number earns nothing.

## Open items
1. Referral/affiliate rewards and reseller earnings already released are not reversed if the order is returned later. Affiliate commission is calculated on the cash total including delivery charge.
2. A partial return does not return any wallet money automatically; it comes back only when the whole order becomes cancelled, failed or returned.
3. Removing items from a wallet order in admin does not recalculate the wallet part. Cancel and reorder instead.
4. If the admin changes the PARENT order status of a vendor order directly, the vendor settlement is not created. Use the vendor orders screen.

## Not verified
- MySQL 8.0, cPanel, the live site; restore rehearsal.
- Portal GET pages were opened once with synthetic data; most vendor/reseller/customer forms were not submitted. Browser and mobile layout not checked.
- Live SMS (only BulkSMSBD is implemented), Brevo delivery, full password recovery, live Pathao.

## Test evidence
678/678 tests, lint pass, 0 production dependency advisories, on MariaDB 10.11 locally. Money and admin flows, including wallet checkout and own-product reseller release, were also driven over HTTP on a throwaway database.

## Owner configuration after deploy
- Email: Admin > Email Settings (host, port, user, SMTP key, verified sender) > Save > Send test. Add Brevo's DNS records.
- SMS: Admin > SMS Gateway Configuration (BulkSMSBD only).
- Courier: Admin > Courier API.

## Deploy facts (owner supplied)
App root `/home/mrtumico/mrtumi`; startup `app.js`; Node 22; DB `mrtumico_Mrtumi`; rehearsal DB `mrtumico_rehearsal`; uploads `/home/mrtumico/uploads`; vendor docs `/home/mrtumico/vendor_docs`; restart `tmp/restart.txt`.
`deploy.sh` requires a signed approval ticket, an out-of-band trust anchor and separate rehearsal DB credentials. Run `npm ci` so nodemailer is installed. Back up database and uploads first.
