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

## Fixed after form-level and browser testing
- Orders could not be shipped 30 minutes after checkout (stock reservation expiry). Reservations now last 90 days and any active one can be shipped. If `reservations:expire --apply` is ever scheduled, it releases holds older than 90 days.
- Delivery through the vendor screens did not reduce stock. Cancelling an order left the vendor's part open.
- Checkout page printed raw JavaScript (missing script tags, present since v3.5.0). With the tags restored the OTP script runs; keep OTP mode off, as the live OTP path is not verified.
- Own-product cash on delivery orders could never be marked paid. New button on the admin order page for delivered COD orders without vendor items; it needs a receipt/remittance reference and is audit logged. The Payment Status dropdown in the edit form still refuses changes.
- Vendor product edit always failed and wiped image/descriptions; signed-in customers lost vendor variant products from the cart; new vendors had no store page until they saved their profile.
- Reseller order form no longer offers products with variants (reseller variant ordering is not built). Affiliate panel now shows success and error messages.

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
5. An order containing both our own and vendor products is not marked paid automatically: COD reconciliation covers only the vendor part.
6. Resellers cannot order products that have variants. Reseller deposits are disabled by design on MySQL.
7. The return window defaults to 0 days (Admin > Reseller Commerce > settings). Set it (e.g. 7) before releasing any money.
8. On narrow phones the admin order list and customer order history need sideways scrolling.

## Not verified
- MySQL 8.0, cPanel, the live site; restore rehearsal.
- Browser checks used local Chromium with CDN libraries served from local copies (charts library not loaded). Real phones and other browsers not checked.
- Not every admin form was submitted; password recovery was checked only with a local test mail server.
- Live SMS (only BulkSMSBD is implemented), Brevo delivery, full password recovery, live Pathao.

## Test evidence
682/682 tests, lint pass, 0 production dependency advisories, on MariaDB 10.11 locally. On a throwaway database the real forms were submitted for: vendor registration to withdrawal, reseller registration to withdrawal, affiliate link to withdrawal approval, customer account, COD order, cancellation and return, admin create forms and category-type edit popups. Desktop and 375 px mobile checkout passed in Chromium.

## Owner configuration after deploy
- Reseller Commerce: set the return window, and for every product resellers may sell, its eligibility and base (entitlement) price, own products included.
- Email: Admin > Email Settings (host, port, user, SMTP key, verified sender) > Save > Send test. Add Brevo's DNS records.
- SMS: Admin > SMS Gateway Configuration (BulkSMSBD only).
- Courier: Admin > Courier API.

## Deploy facts (owner supplied)
App root `/home/mrtumico/mrtumi`; startup `app.js`; Node 22; DB `mrtumico_Mrtumi`; rehearsal DB `mrtumico_rehearsal`; uploads `/home/mrtumico/uploads`; vendor docs `/home/mrtumico/vendor_docs`; restart `tmp/restart.txt`.
`deploy.sh` requires a signed approval ticket, an out-of-band trust anchor and separate rehearsal DB credentials. Run `npm ci` so nodemailer is installed. Back up database and uploads first.
