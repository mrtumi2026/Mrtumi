# Mr. Tumi Grocery & Gift

বাংলা ও ইংরেজি মাল্টিভেন্ডর ই-কমার্স: নিজের পণ্য, ভেন্ডর, রিসেলার, এফিলিয়েট, রেফারেল ও POS (`mrtumi.com`, BDT, Asia/Dhaka)।

Node.js 22 + Express + EJS, MySQL, cPanel (Passenger)।

## আগে পড়ুন

| ফাইল | কী আছে |
|---|---|
| [HANDOVER.md](HANDOVER.md) | এখনকার অবস্থা, বাকি কাজ, কী যাচাই হয়নি |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | New developer start here: layout, setup, tests, money rules, how to change safely |
| [DEPLOYMENT.md](DEPLOYMENT.md) | cPanel release steps |
| [ব্যবহার নির্দেশিকা (A থেকে Z)](https://claude.ai/artifact/HRV9zskRFdi4BqBSvYcwaT) | Admin, customer, vendor, reseller, affiliate manual (private; ask the owner) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture background |
| [docs/OPERATIONAL_ROLLBACK_RUNBOOK.md](docs/OPERATIONAL_ROLLBACK_RUNBOOK.md) | Rollback |

`docs/internal/` holds older planning records that the automated checks still read. They are history, not current status.

## Quick start

```bash
npm ci
cp .env.example .env      # fill local values; never commit .env
npm run migrate:up        # local/test MySQL only
npm run lint && npm test
npm run dev               # http://localhost:3000
```

Portals: `/` store, `/admin/login`, `/vendor/login`, `/reseller/login`, `/affiliate/login`, `/customer/login`, `/health`.

## Rules

- `main` is the only long-lived branch. Work on a short branch, then merge when CI passes.
- Never commit secrets, `.env`, database dumps or customer files.
- Do not edit a migration that has already run. Add a new one.
- Production deploy needs the owner's approval and a signed release ticket.
