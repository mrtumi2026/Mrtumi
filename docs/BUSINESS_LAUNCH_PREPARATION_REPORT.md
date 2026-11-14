# Mr. Tumi — Business Launch Preparation: Product Catalog & Business Settings Audit

**Production Target:** `https://mrtumi.com`  
**Deployment Baseline:** Commit `bb5034a` (Verified Live)  
**Report Date:** 2026-11-14  
**Audit Purpose:** Pre-Soft Launch Product Catalog & Business Settings Audit  

---

## Executive Summary

Mr. Tumi's core commerce engine, multi-portal architecture, integer-paisa ledgers, security headers, and operational health checks are 100% operational on production.

Before opening the storefront to real customers for the **Soft Launch**, the underlying **business catalog and operational settings** must transition from prototype/test data to production-grade merchant data:

1. **Catalog Reality:** Only 2 active products are currently published on the storefront. One is misplaced in the wrong category ("দেশি লিচু ফ্রেশ প্যাক" in Snacks & Beverages instead of Fruits & Vegetables), and the other ("ফুড চপার") has an accidental lychee fruit image attached to it. The remaining 13 product categories currently have 0 items.
2. **Grocery Units:** All products in the legacy prototype were assigned `"৫০০ গ্রাম,১ কেজি,২ কেজি"`. A real grocery catalog requires specific, contextual units: `kg` for produce, `dozen/piece` for eggs, `litre` for oil, `sack/kg` for rice, and `piece/packet` for packaged goods.
3. **Business Settings:** Storefront displays `01973437395` in the header, while database settings contain placeholder `01711-000000`. WhatsApp button is absent. Store address is set to placeholder text. Dedicated public pages for `/terms` and `/refund-policy` returned 404.
4. **Third-Party Gateways:** Courier (Steadfast/Pathao), SMS (BulkSMSBD), and online payment gateways are code-complete but awaiting the owner's live production merchant API keys.

---

## PHASE 1 — Comprehensive Product Catalog Audit

### 1. Category & Subcategory Taxonomy (Live Inspection)

The live production database contains all **15 modern categories** and **74 subcategories** with bilingual (Bangla & English) titles and icons:

| # | Category Slug | Bengali Name | English Name | Subcategories Count & Examples | Storefront Status |
| :-: | :--- | :--- | :--- | :--- | :---: |
| 1 | `fruits-and-vegetables` | ফলমূল ও শাকসবজি | Fruits & Vegetables | 4 (Fresh Fruits, Fresh Vegetables, Leafy Greens, Organic) | **0 Products** |
| 2 | `meat-fish-and-eggs` | মাছ, মাংস ও ডিম | Meat, Fish & Eggs | 6 (Fresh Fish, Beef/Mutton, Chicken, Eggs, Dried Fish, Processed) | **0 Products** |
| 3 | `rice-dal-and-cooking` | চাল, ডাল ও রান্নার উপাদান | Rice, Dal & Cooking | 6 (Rice, Flour/Atta, Lentils, Oil & Ghee, Spices, Salt & Sugar) | **0 Products** |
| 4 | `dairy-and-breakfast` | দুধ ও সকালের নাস্তা | Dairy & Breakfast | 6 (Milk & Yogurt, Butter & Cheese, Bread, Cereals, Tea/Coffee, Honey) | **0 Products** |
| 5 | `snacks-and-beverages` | স্ন্যাক্স ও পানীয় | Snacks & Beverages | 5 (Chips, Biscuits, Chocolates, Noodles/Pasta, Cold Drinks/Juices) | **1 Product** (Misplaced) |
| 6 | `frozen-and-ready-to-eat`| ফ্রোজেন ও রেডি ফুড | Frozen & Ready to Eat | 4 (Frozen Paratha, Ice Cream, Canned Food, Ready Mix) | **0 Products** |
| 7 | `health-and-beauty` | স্বাস্থ্য ও রূপচর্চা | Health & Beauty | 5 (Skin Care, Hair Care, Makeup, Personal Care, Pharmacy) | **0 Products** |
| 8 | `baby-and-kids` | শিশু ও বাচ্চাদের সামগ্রী | Baby & Kids | 5 (Diapers & Wipes, Baby Food, Baby Skin Care, Toys, Clothing) | **0 Products** |
| 9 | `home-and-kitchen` | হোম ও কিচেন | Home & Kitchen | 5 (Home Appliances, Kitchenware, Furniture, Bedding, Decor) | **1 Product** |
| 10 | `household-and-others` | হাউসহোল্ড ও অন্যান্য | Household & Others | 6 (Cleaning, Laundry, Pest Control, Pets, Stationery, Fitness) | **0 Products** |
| 11 | `mobiles-and-tablets` | মোবাইল ও ট্যাবলেট | Mobiles & Tablets | 5 (Smartphones, Tablets, Covers, Chargers, Power Banks) | **0 Products** |
| 12 | `computers-and-electronics`| কম্পিউটার ও ইলেকট্রনিক্স | Computers & Electronics | 7 (Laptops, Monitors, TV/Audio, Cameras, Headphones, Speakers, Gaming)| **0 Products** |
| 13 | `womens-fashion` | নারীদের ফ্যাশন | Women's Fashion | 5 (Sarees, Kurtis, Western, Shoes, Bags) | **0 Products** |
| 14 | `mens-fashion` | পুরুষদের ফ্যাশন | Men's Fashion | 5 (Shirts, Pants/Jeans, Panjabi, Shoes, Watches) | **0 Products** |
| 15 | `watches-bags-and-jewellery`| ঘড়ি, ব্যাগ ও জুয়েলারি | Watches, Bags & Jewellery | 5 (Wrist Watches, Sunglasses, Backpacks, Jewellery, Wallets) | **0 Products** |

### 2. Live Storefront Products Detail

Currently, only **2 products** are visible on the production catalog:

#### Product A: "দেশি লিচু ফ্রেশ প্যাক"
- **Live URL:** `/product/product-5-v675ce0b6f0c36f53`
- **Slug Issue:** Contains an unreadable synthetic hash (`-v675ce0b6f0c36f53`) from old migration runs instead of an SEO-friendly slug.
- **Category Issue (Misplaced):** Displayed under **`স্ন্যাক্স ও পানীয়` (Snacks & Beverages)**. Fresh seasonal lychee must be placed under **`fruits-and-vegetables` -> `Fresh Fruits`**.
- **SKU:** `N/A`.
- **Units & Variants:** Description lists conflicting legacy unit keywords ("৫০০ গ্রাম,১ কেজি,২ কেজি", "প্যাকেট", "বক্স"). No active variant selector is wired.
- **Images:** 3 images loaded (all HTTP 200).

#### Product B: "ইউএসবি পোর্টেবল ফুড চপার"
- **Live URL:** `/product/food-chopper`
- **Title:** রান্নাঘরের সরঞ্জামের জন্য ইউএসবি পোর্টেবল ফুড চপার – রসুন বাটার যন্ত্র, ক্রাশার, মিট গ্রাইন্ডার ও সবজি কাটার মেশিন
- **Category:** `হোম ও কিচেন > রান্নাঘরের বাসন ও সরঞ্জাম` (Correct taxonomy).
- **SKU:** `N/A`.
- **Image Corruption Issue:** The product gallery contains `/uploads/product/lychee-fresh.jpg` (a fresh lychee fruit photo) alongside actual kitchen gadget photos!
- **Unit Issue:** It is a kitchen appliance, but description contains leftover fruit unit keywords ("কেজি", "গ্রাম"). A kitchen gadget should be sold as **`১ পিস` (1 Piece)**.

### 3. Inactive & Prototype Database Artifacts
- The prototype database contained **16 legacy products**, 14 of which were duplicated seasonal lychee entries with identical descriptions and prices.
- These legacy duplicate records should be archived so they do not pollute search results or inventory statistics.

---

## PHASE 2 — Business Settings Audit

### 1. Store Identity & Contact Channels

| Setting | Current Production Value | Status | Recommended Action |
| :--- | :--- | :---: | :--- |
| **Site Name** | `Mr. Tumi Grocery & Gift` / `মি. তুমি গ্রোসারি অ্যান্ড গিফট` | **OK** | Keep as official brand name. |
| **Site Tagline** | `নিত্যপ্রয়োজনীয় গ্রোসারি ও প্রিয়জনের উপহার — বিশ্বস্ত ডেলিভারিতে ঘরে বসেই` | **OK** | Professional and customer-focused. |
| **Customer Hotline** | Topbar: `01973437395`<br>Database: `01711-000000` | **Mismatch** | Update database setting `phone` to `01973437395` for consistent customer communication. |
| **WhatsApp Support** | Database: `8801711009988`<br>Storefront: **No WhatsApp button** | **Missing UI** | Update WhatsApp number to official line and enable floating WhatsApp chat button. |
| **Support Email** | `support@mrtumi.com` | **OK** | Professional branded email address. |
| **Store Physical Address** | `House 12, Road 5, Dhanmondi, Dhaka-1205` / `ঢাকা, বাংলাদেশ` | **Placeholder** | Update with actual warehouse / office address for courier pickups and customer trust. |
| **Brand Logos** | `/uploads/brand/mrtumi-placeholder-logo.svg` | **Placeholder** | Upload official high-resolution vector/PNG logo and favicon. |

### 2. Delivery & Fulfillment Charges

| Setting | Current Production Value | Status | Assessment |
| :--- | :--- | :---: | :--- |
| **Inside Dhaka Delivery** | **৳60** | **OK** | Competitive with standard Dhaka metropolitan courier rates. |
| **Outside Dhaka Delivery** | **৳120** | **OK** | Standard nation-wide courier rate in Bangladesh. |
| **Free Delivery Threshold** | **৳2,500** | **OK** | Healthy basket-size incentive for grocery shopping. |
| **Delivery Zones** | All 64 Districts and Upazilas | **OK** | Bangladesh geo-hierarchy active in checkout dropdowns. |

### 3. Payment Methods & Financial Policy

| Gateway / Method | Current Status | Customer Experience | Recommended Launch Action |
| :--- | :---: | :--- | :--- |
| **Cash on Delivery (COD)** | **Active** | Customer pays cash upon parcel arrival. | Primary launch payment method. Keep enabled. |
| **bKash Manual** | **Active** | Customer sends money and submits Sender Number & TrxID. | Ready for soft launch. Verify merchant receiving number. |
| **Nagad Manual** | **Active** | Customer sends money and submits Sender Number & TrxID. | Ready for soft launch. Verify merchant receiving number. |
| **Rocket Manual** | **Active** | Customer sends money and submits Sender Number & TrxID. | Ready for soft launch. Verify merchant receiving number. |
| **bKash Online Gateway** | **Code Ready** | Direct API popup (automated instant payment). | Provide bKash app key, secret, and credentials to activate. |

### 4. Partner Financial & Commission Rules

| Rule / Setting | Current Configuration | Validation / Safeguards |
| :--- | :--- | :--- |
| **Vendor Commission** | **10% (1,000 bps)** default | Configured in `commission_rules` with category-override support. |
| **Reseller Margin** | Wholesale vs. Customer Selling Price | Immutable price snapshots (`order_price_snapshots`) prevent price drift. |
| **Minimum Withdrawal** | **৳100** | Prevents micro-payout overhead; enforced at repository level. |
| **Withdrawal Reserve** | Immediate balance reservation | Prevents concurrent overdraft requests. |
| **Settlement Maturity** | Triggered upon courier delivery | Payouts only release after parcel confirmation and return window. |

### 5. Legal, Policy & CMS Pages

| Policy Route | Current HTTP Status | Finding & Correction |
| :--- | :---: | :--- |
| `/privacy-policy` | **200 OK** | Full privacy policy versioning and consent management active. |
| `/about` | **200 OK** | About page active; renders company story and mission. |
| `/contact` | **200 OK** | Contact form and customer support channels active. |
| `/faq` | **200 OK** | FAQ page active; renders delivery fees and ordering answers. |
| `/terms` | **404 Not Found** | **Action Required:** Mount dedicated `/terms` route displaying standard terms of service. |
| `/refund-policy` | **404 Not Found** | **Action Required:** Mount dedicated `/refund-policy` (or alias to return guidelines). |

---

## PHASE 3 — Actionable Launch Preparation Plan

### Priority 1: CRITICAL (Must Fix Before Accepting Real Orders)

1. **Correct Category Misplacement:**
   - **Current:** "দেশি লিচু ফ্রেশ প্যাক" is in `snacks-and-beverages`.
   - **Action:** Reassign to `fruits-and-vegetables` -> `Fresh Fruits`.
   - **Slug Update:** Update slug from `product-5-v675ce0b6f0c36f53` to `deshi-lychee-fresh-pack`.
2. **Remove Corrupted Image from Food Chopper:**
   - **Current:** Food chopper gallery displays `lychee-fresh.jpg`.
   - **Action:** Detach the lychee image; retain only genuine appliance product photos.
3. **Harmonize Customer Support Hotline:**
   - **Current:** Storefront displays `01973437395`; settings table has placeholder `01711-000000`.
   - **Action:** Update `phone` in `settings` to `01973437395`.
4. **Mount Dedicated Policy Pages (`/terms`, `/refund-policy`):**
   - Provide direct URL routes so payment gateways and customers can read terms and refund policies without encountering a 404.
5. **Update Physical Business Address:**
   - Replace generic `"ঢাকা, বাংলাদেশ"` with the exact warehouse / office address.

### Priority 2: HIGH (Should Complete Before Soft Launch)

1. **Populate Core Grocery Starter Inventory (20–30 Everyday Staples):**
   - Soft launch requires essential items so visitors can actually place realistic grocery orders:
     - **Rice (চাল):** Miniket Rice (৫ কেজি, ২৫ কেজি বস্তা), Nazirshail Rice (৫ কেজি).
     - **Cooking Oil (তেল):** Soyabean Oil (১ লিটার, ২ লিটার, ৫ লিটার বোতল), Mustard Oil (৫০০ মিলি, ১ লিটার).
     - **Lentils (ডাল):** Deshi Mosur Dal (১ কেজি), Mung Dal (৫০০ গ্রাম).
     - **Eggs (ডিম):** Farm Fresh Brown Eggs (১ ডজন / ১২ পিস), Duck Eggs (১ ডজন).
     - **Spices & Condiments (মসলা ও চিনি):** Turmeric Powder (২০০ গ্রাম প্যাকেট), Chili Powder (২০০ গ্রাম), Salt (১ কেজি প্যাকেট), Sugar (১ কেজি প্যাকেট).
     - **Dairy & Tea (দুধ ও চা):** Liquid Milk (১ লিটার প্যাক), Powder Milk (৫০০ গ্রাম), Tea Leaves (৪০০ গ্রাম).
     - **Potatoes & Onions (আলু ও পেঁয়াজ):** Deshi Potato (১ কেজি, ৫ কেজি), Deshi Onion (১ কেজি).
2. **Add Floating WhatsApp Support Widget:**
   - Connect floating icon in storefront bottom-right linking to `https://wa.me/8801973437395` for immediate customer inquiries.
3. **Upload Official Brand Assets:**
   - Replace placeholder SVGs (`mrtumi-placeholder-logo.svg`, `mrtumi-placeholder-favicon.svg`) with final brand logo and favicon.
4. **Configure Courier Production Credentials:**
   - Enter live Steadfast API Key & Secret in Admin Integrations so consignments book automatically upon order confirmation.

### Priority 3: MEDIUM (Can Complete During Launch Week)

1. **SMS Gateway Integration (BulkSMSBD):**
   - Enter BulkSMSBD API key and Sender ID in Admin Settings to enable automated SMS notifications upon order booking.
2. **Branded Email SMTP:**
   - Configure SMTP app password for `orders@mrtumi.com` so customers receive branded HTML order receipts.
3. **Archive Legacy Test Data:**
   - Soft-delete or archive the remaining 14 prototype lychee rows from the database.

### Priority 4: OPTIONAL (Post-Launch Growth)

1. **Tokenized Direct bKash Gateway:** Integrate direct bKash online payment popup once corporate merchant contract is completed.
2. **Tracking Pixels:** Add Facebook Pixel ID and TikTok Pixel ID in Admin Marketing Settings for ad performance tracking.

---

## PHASE 4 — Proposed Grocery Catalog Master Sheet

This standardized unit convention must be applied to all catalog items:

| Product Name (বাংলা) | Recommended Category | Base Unit (একক) | Allowed Variants / Packages | Pricing Basis |
| :--- | :--- | :--- | :--- | :--- |
| **মিনিকেট চাল (Miniket Rice)** | `rice-dal-and-cooking` | `kg` (কেজি) | ৫ কেজি ব্যাগ, ২৫ কেজি বস্তা | Per pack / sack |
| **সয়াবিন তেল (Soyabean Oil)** | `rice-dal-and-cooking` | `litre` (লিটার) | ১ লিটার, ২ লিটার, ৫ লিটার বোতল | Per bottle |
| **ফার্মের মুরগির ডিম (Brown Eggs)** | `meat-fish-and-eggs` | `piece` (পিস) | ১ হালি (৪ পিস), ১ ডজন (১২ পিস), ৩০ পিস কেস | Per dozen / case |
| **দেশি মসুর ডাল (Red Lentils)** | `rice-dal-and-cooking` | `kg` (কেজি) | ৫০০ গ্রাম, ১ কেজি | Per packet |
| **দেশি আলু (Fresh Potato)** | `fruits-and-vegetables` | `kg` (কেজি) | ১ কেজি, ৫ কেজি নেট ব্যাগ | Per weight |
| **দেশি পেঁয়াজ (Local Onion)** | `fruits-and-vegetables` | `kg` (কেজি) | ১ কেজি, ৫ কেজি ব্যাগ | Per weight |
| **আটা / ময়দা (Flour / Atta)** | `rice-dal-and-cooking` | `kg` (কেজি) | ২ কেজি প্যাকেট | Per packet |
| **লবণ (Iodized Salt)** | `rice-dal-and-cooking` | `kg` (কেজি) | ১ কেজি প্যাকেট | Per packet |
| **চিনি (Refined Sugar)** | `rice-dal-and-cooking` | `kg` (কেজি) | ১ কেজি প্যাকেট | Per packet |
| **খাঁটি সরিষার তেল (Mustard Oil)** | `rice-dal-and-cooking` | `ml` (মিলি) | ২৫০ মিলি, ৫০০ মিলি, ১ লিটার | Per bottle |
| **তরল দুধ (Pasteurized Milk)** | `dairy-and-breakfast` | `litre` (লিটার) | ৫০০ মিলি, ১ লিটার প্যাকেট | Per packet |
| **চা পাতা (Premium Tea Leaves)** | `dairy-and-breakfast` | `gram` (গ্রাম) | ২০০ গ্রাম, ৪০০ গ্রাম প্যাকেট | Per packet |
| **রসুন বাটার চপার (Food Chopper)** | `home-and-kitchen` | `piece` (পিস) | ১ পিস (হোয়াইট / গ্রিন) | Per item |

---

## Owner Decision & Action Checklist

Please review and confirm the following business decisions:

- [ ] **1. Category Correction Approval:** Move "দেশি লিচু ফ্রেশ প্যাক" to `ফলমূল ও শাকসবজি` (Fruits & Vegetables) and update slug to `deshi-lychee-fresh-pack`.
- [ ] **2. Image Cleanup Approval:** Remove the misplaced lychee image from the "ফুড চপার" gallery.
- [ ] **3. Hotline Confirmation:** Confirm `01973437395` as the primary public hotline across the site and database settings.
- [ ] **4. WhatsApp Number:** Confirm official WhatsApp number for the floating chat widget.
- [ ] **5. Physical Address:** Provide the exact office / warehouse address to publish in the footer and checkout.
- [ ] **6. Policy Routes:** Authorize mounting clean public routes for `/terms` and `/refund-policy`.
- [ ] **7. Starter Catalog Ingestion:** Approve seeding or uploading the 20–30 core grocery products listed in Phase 4.
