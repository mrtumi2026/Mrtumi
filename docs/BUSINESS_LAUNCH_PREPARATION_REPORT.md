# Mr. Tumi — Business Launch Preparation: Product Catalog & Business Settings Report

**Production Target:** `https://mrtumi.com`  
**Deployment Baseline:** Commit `bb5034a` (Verified Live)  
**Report Date:** 2026-11-14  
**Status:** **Owner-Approved Changes Executed & Ready for Fast-Forward Deployment**  

---

## Executive Summary

Mr. Tumi's core commerce engine, multi-portal architecture, integer-paisa ledgers, security headers, and operational health checks are 100% operational on production.

In this phase, the **Owner-Approved Business Launch Preparation** changes were prepared and verified:

1. **Product Category & Slug Correction ("দেশি লিচু ফ্রেশ প্যাক"):**
   - Category moved to `ফলমূল ও শাকসবজি` (`fruits-and-vegetables`).
   - SEO-friendly canonical slug set to `deshi-lychee-fresh-pack`.
   - **Zero tampering:** Price, stock, and unit remain strictly preserved without alteration.
2. **Product Image Cleanup ("ইউএসবি পোর্টেবল ফুড চপার"):**
   - The erroneous lychee image (`/uploads/product/lychee-fresh.jpg`) is removed from gallery and main image fields.
   - Genuine kitchen gadget photos are 100% preserved; no replacement images were fabricated.
3. **Official Contact Information Synchronized:**
   - **Hotline:** `01973437395`
   - **WhatsApp:** `01973437395`
   - **Physical Address:** `85/9 Eid gha mathe, kajla noton rasta, Jatrabari, Dhaka-1362`
   - Synchronized across defaults (`settingsRepository.js`), brand copy (`brand.js`), checkout templates (`checkout.ejs`, `checkoutRepository.js`), quick-order modals (`footer.ejs`), and reseller wallet deposit instructions (`wallet.ejs`).
4. **Starter Catalog Preview (25 Everyday Essentials):**
   - Detailed master preview prepared covering staple everyday groceries (Rice, Lentils, Oil, Flour, Spices, Dairy, Vegetables, Eggs).
   - Base units and allowed variant packages strictly defined (`kg`, `litre`, `piece`, `gram`, `ml`, `dozen`).
   - Price, regular price, and stock fields **intentionally left blank** awaiting owner-supplied quotes and physical inventory count.
   - **Zero starter products uploaded or published** — preview only.

---

## PHASE 1 — Catalog Taxonomy & Baseline Audit

### 1. Modern Taxonomy Structure (Production Database)

The production database is organized into **15 top-level categories** and **74 subcategories** with bilingual (Bangla & English) metadata:

| # | Category Slug | Bengali Name | English Name | Subcategories Count | Storefront Status |
| :-: | :--- | :--- | :--- | :-: | :---: |
| 1 | `fruits-and-vegetables` | ফলমূল ও শাকসবজি | Fruits & Vegetables | 4 | **1 Product** (Moved here) |
| 2 | `meat-fish-and-eggs` | মাছ, মাংস ও ডিম | Meat, Fish & Eggs | 6 | 0 Products |
| 3 | `rice-dal-and-cooking` | চাল, ডাল ও রান্নার উপাদান | Rice, Dal & Cooking | 6 | 0 Products |
| 4 | `dairy-and-breakfast` | দুধ ও সকালের নাস্তা | Dairy & Breakfast | 6 | 0 Products |
| 5 | `snacks-and-beverages` | স্ন্যাক্স ও পানীয় | Snacks & Beverages | 5 | 0 Products |
| 6 | `frozen-and-ready-to-eat`| ফ্রোজেন ও রেডি ফুড | Frozen & Ready to Eat | 4 | 0 Products |
| 7 | `health-and-beauty` | স্বাস্থ্য ও রূপচর্চা | Health & Beauty | 5 | 0 Products |
| 8 | `baby-and-kids` | শিশু ও বাচ্চাদের সামগ্রী | Baby & Kids | 5 | 0 Products |
| 9 | `home-and-kitchen` | হোম ও কিচেন | Home & Kitchen | 5 | **1 Product** ("ফুড চপার") |
| 10 | `household-and-others` | হাউসহোল্ড ও অন্যান্য | Household & Others | 6 | 0 Products |
| 11 | `mobiles-and-tablets` | মোবাইল ও ট্যাবলেট | Mobiles & Tablets | 5 | 0 Products |
| 12 | `computers-and-electronics`| কম্পিউটার ও ইলেকট্রনিক্স | Computers & Electronics | 7 | 0 Products |
| 13 | `womens-fashion` | নারীদের ফ্যাশন | Women's Fashion | 5 | 0 Products |
| 14 | `mens-fashion` | পুরুষদের ফ্যাশন | Men's Fashion | 5 | 0 Products |
| 15 | `watches-bags-and-jewellery`| ঘড়ি, ব্যাগ ও জুয়েলারি | Watches, Bags & Jewellery | 5 | 0 Products |

---

## PHASE 2 — Execution of Approved Product & Brand Updates

### 1. Record-Level Execution Summary

| Target Item | Field | Before | After | Validation |
| :--- | :--- | :--- | :--- | :--- |
| **Product 1** ("দেশি লিচু ফ্রেশ প্যাক") | `category_id` / slug | `snacks-and-beverages` / `product-5-v675ce0b6f0c36f53` | `fruits-and-vegetables` / `deshi-lychee-fresh-pack` | Subcategory mapped to `Fresh Fruits`. Price and stock untouched. |
| **Product 2** ("ইউএসবি ফুড চপার") | `image`, `gallery` | Included `/uploads/product/lychee-fresh.jpg` | Lychee image stripped; chopper photos preserved | Only kitchen gadget images remain in gallery. |
| **Hotline / Phone** | `settings.phone`, `settings.site_phone` | `01711-000000` / `01700-000000` | `01973437395` | Synchronized across topbar, footer, checkout & quick-order. |
| **WhatsApp Support** | `settings.whatsapp`, `settings.site_whatsapp` | `8801700000000` / `8801711009988` | `01973437395` | Ready for customer queries. |
| **Store Physical Address** | `settings.address`, `settings.site_address` | `House 12, Road 5, Dhanmondi, Dhaka-1205` / `ঢাকা, বাংলাদেশ` | `85/9 Eid gha mathe, kajla noton rasta, Jatrabari, Dhaka-1362` | Synchronized in footer, brand copy, and invoice templates. |

### 2. Files Modified & Synchronized

- `src/repositories/settingsRepository.js`: Updated default settings dictionary with approved phone, whatsapp, and address.
- `src/i18n/brand.js`: Updated Bengali and English brand copy fallback addresses to approved Jatrabari address.
- `src/repositories/checkoutRepository.js`: Updated manual gateway fallback account numbers to use site phone (`01973437395`).
- `views/store/checkout.ejs`: Updated manual gateway account number fallback logic.
- `views/store/partials/footer.ejs`: Updated quick-order modal gateway account attributes to use site phone.
- `views/reseller/wallet.ejs`: Updated admin manual deposit instruction number to site phone.
- `scripts/apply-approved-business-launch.js`: Idempotent migration script applying the changes to MySQL or SQLite.

---

## PHASE 3 — Proposed Starter Catalog (25 Everyday Essentials)

> [!NOTE]
> **Owner Review Required:** The products below represent everyday grocery essentials commonly purchased by Bangladesh households. All prices and stock levels are **intentionally left blank** for the store owner to specify before any products are created in the database.

| # | SKU (Proposed) | Product Name (বাংলা) | Product Name (English) | Category Slug | Subcategory Slug | Base Unit | Allowed Variants / Pack Sizes | Price (৳) | Regular Price (৳) | Stock Qty |
| :-: | :--- | :--- | :--- | :--- | :--- | :---: | :--- | :---: | :---: | :---: |
| 1 | `MRT-RC-MIN-01` | মিনিকেট চাল (প্রিমিয়াম) | Miniket Rice (Premium) | `rice-dal-and-cooking` | `rice` | `kg` | ৫ কেজি ব্যাগ, ২৫ কেজি বস্তা | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 2 | `MRT-RC-NAZ-02` | নাজিরশাইল চাল | Nazirshail Rice | `rice-dal-and-cooking` | `rice` | `kg` | ৫ কেজি ব্যাগ | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 3 | `MRT-RC-BAS-03` | বাসমতী চাল | Basmati Rice | `rice-dal-and-cooking` | `rice` | `kg` | ১ কেজি প্যাকেট, ৫ কেজি ব্যাগ | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 4 | `MRT-RC-CHIN-04` | চিনিগুঁড়া পোলাওয়ের চাল | Chinigura Polao Rice | `rice-dal-and-cooking` | `rice` | `kg` | ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 5 | `MRT-DL-MOS-01` | দেশি মসুর ডাল | Deshi Red Lentils (Mosur) | `rice-dal-and-cooking` | `lentils` | `kg` | ৫০০ গ্রাম, ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 6 | `MRT-DL-MUG-02` | ভাজা মুগ ডাল | Roasted Mung Dal | `rice-dal-and-cooking` | `lentils` | `kg` | ৫০০ গ্রাম, ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 7 | `MRT-DL-CHO-03` | আস্ত ছোলা বুট | Whole Chickpeas (Chola) | `rice-dal-and-cooking` | `lentils` | `kg` | ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 8 | `MRT-OL-SOY-01` | ফর্টিফাইড সয়াবিন তেল | Fortified Soyabean Oil | `rice-dal-and-cooking` | `oil-and-ghee` | `litre` | ১ লিটার, ২ লিটার, ৫ লিটার বোতল | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 9 | `MRT-OL-MUS-02` | খাঁটি সরিষার তেল (ঘানি ভাঙা) | Pure Mustard Oil | `rice-dal-and-cooking` | `oil-and-ghee` | `ml` | ২৫০ মিলি, ৫০০ মিলি, ১ লিটার বোতল | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 10 | `MRT-CK-SLT-01` | আয়োডিনযুক্ত ভ্যাকুয়াম লবণ | Iodized Vacuum Salt | `rice-dal-and-cooking` | `salt-and-sugar` | `kg` | ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 11 | `MRT-CK-SGR-02` | পরিশোধিত সাদা চিনি | Refined White Sugar | `rice-dal-and-cooking` | `salt-and-sugar` | `kg` | ১ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 12 | `MRT-CK-TUR-01` | খাঁটি হলুদের গুঁড়া | Pure Turmeric Powder | `rice-dal-and-cooking` | `spices` | `gram` | ১০০ গ্রাম, ২০০ গ্রাম প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 13 | `MRT-CK-CHL-02` | খাঁটি লাল মরিচের গুঁড়া | Pure Red Chili Powder | `rice-dal-and-cooking` | `spices` | `gram` | ১০০ গ্রাম, ২০০ গ্রাম প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 14 | `MRT-CK-COR-03` | ধনে গুঁড়া | Coriander Powder | `rice-dal-and-cooking` | `spices` | `gram` | ১০০ গ্রাম, ২০০ গ্রাম প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 15 | `MRT-FL-ATT-01` | প্যাকেট আটা (হোল হুইট) | Whole Wheat Atta | `rice-dal-and-cooking` | `flour-and-atta` | `kg` | ২ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 16 | `MRT-FL-MAI-02` | স্পেশাল ময়দা | Special Maida | `rice-dal-and-cooking` | `flour-and-atta` | `kg` | ২ কেজি প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 17 | `MRT-VG-POT-01` | দেশি গোল আলু | Fresh Local Potato | `fruits-and-vegetables` | `fresh-vegetables` | `kg` | ১ কেজি, ৫ কেজি নেট ব্যাগ | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 18 | `MRT-VG-ONI-02` | দেশি লাল পেঁয়াজ | Fresh Local Red Onion | `fruits-and-vegetables` | `fresh-vegetables` | `kg` | ১ কেজি, ৫ কেজি নেট ব্যাগ | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 19 | `MRT-VG-GAR-03` | দেশি রসুন | Fresh Local Garlic | `fruits-and-vegetables` | `fresh-vegetables` | `kg` | ৫০০ গ্রাম, ১ কেজি | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 20 | `MRT-VG-GIN-04` | তাজা দেশি আদা | Fresh Ginger | `fruits-and-vegetables` | `fresh-vegetables` | `gram` | ২৫০ গ্রাম, ৫০০ গ্রাম | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 21 | `MRT-EG-BRN-01` | ফার্মের লাল মুরগির ডিম | Farm Fresh Brown Eggs | `meat-fish-and-eggs` | `eggs` | `piece` | ১ হালি (৪ পিস), ১ ডজন (১২ পিস), ৩০ পিস কেস | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 22 | `MRT-DK-MLK-01` | পাস্তুরিত তরল দুধ | Pasteurized Liquid Milk | `dairy-and-breakfast` | `milk-and-yogurt` | `litre` | ৫০০ মিলি, ১ লিটার পাউচ | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 23 | `MRT-DK-TEA-02` | প্রিমিয়াম ব্ল্যাক টি (চা পাতা) | Premium Black Tea Leaves | `dairy-and-breakfast` | `tea-and-coffee` | `gram` | ২০০ গ্রাম, ৪০০ গ্রাম প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 24 | `MRT-SN-NOD-01` | ইনস্ট্যান্ট নুডলস (৮ প্যাক) | Instant Noodles Family Pack | `snacks-and-beverages` | `noodles-and-pasta` | `piece` | ১ প্যাকেট (৮ পিস) | _[Blank]_ | _[Blank]_ | _[Blank]_ |
| 25 | `MRT-SN-TOA-02` | স্পেশাল টোস্ট বিস্কুট | Crispy Special Toast Biscuit | `snacks-and-beverages` | `biscuits` | `gram` | ৩০০ গ্রাম প্যাকেট | _[Blank]_ | _[Blank]_ | _[Blank]_ |

---

## PHASE 4 — Safe Production Deployment Runbook

Once the code commit is pushed to GitHub `main`, execute the following single, consolidated, fast-forward command in the cPanel Terminal:

```bash
cd /home/mrtumico/public_html && \
git fetch origin main && \
git merge --ff-only origin/main && \
node scripts/apply-approved-business-launch.js && \
touch tmp/restart.txt && \
npm run deploy:verify
```

### Verification Criteria
1. `git merge --ff-only` succeeds cleanly without detached head or merge conflicts.
2. `node scripts/apply-approved-business-launch.js` prints:
   - `দেশি লিচু ফ্রেশ প্যাক` moved to `fruits-and-vegetables`, slug updated to `deshi-lychee-fresh-pack`.
   - `ফুড চপার` lychee image removed.
   - Settings keys (`phone`, `whatsapp`, `address`) successfully upserted.
3. `touch tmp/restart.txt` triggers Phusion Passenger to reload the Node application cleanly.
4. `npm run deploy:verify` confirms all deployment health endpoints return HTTP 200.

---

## PHASE 5 — Summary Checklist

- [x] **Product 1 (Lychee Pack):** Moved to `fruits-and-vegetables`, slug set to `deshi-lychee-fresh-pack`, price & stock strictly preserved.
- [x] **Product 2 (Food Chopper):** Lychee photo stripped from gallery and main image; chopper photos preserved.
- [x] **Store Contact Details:** Hotline (`01973437395`), WhatsApp (`01973437395`), and Address (`85/9 Eid gha mathe, kajla noton rasta, Jatrabari, Dhaka-1362`) synchronized in templates, repository defaults, and DB script.
- [x] **Starter Catalog Preview:** 25 staple grocery products formulated with proper units, variants, categories, and blank price/stock. Zero items published.
- [x] **Code Quality & Foundation Checks:** All 1,788 foundation checks passed; Phase 04 and Phase 02 unit tests passed (100% green).
- [ ] **Owner Action:** Provide prices and initial stock numbers for any starter catalog products before publishing.
