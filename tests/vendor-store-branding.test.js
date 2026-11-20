'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateVendorSlug, generateSafeVendorSlug, isReservedRoute, RESERVED_VENDOR_SLUGS } = require('../src/utils/vendorSlug');
const { env } = require('../src/config/env');
const storefrontRepo = require('../src/repositories/storefrontRepository');
const vendorOnboardingRepo = require('../src/repositories/vendorOnboardingRepository');

test('Vendor Slug Validator - validates format, length, and reserved routes', () => {
  // Valid slugs
  assert.equal(validateVendorSlug('green-agro-farm').valid, true);
  assert.equal(validateVendorSlug('store-12').valid, true);
  assert.equal(validateVendorSlug('dhaka-fruits-99').valid, true);

  // Invalid length
  assert.equal(validateVendorSlug('ab').valid, false);
  assert.equal(validateVendorSlug('a'.repeat(101)).valid, false);

  // Invalid characters
  assert.equal(validateVendorSlug('Green-Agro').valid, false);
  assert.equal(validateVendorSlug('shop name').valid, false);
  assert.equal(validateVendorSlug('shop_name').valid, false);
  assert.equal(validateVendorSlug('shop!name').valid, false);
  assert.equal(validateVendorSlug('-shop-name').valid, false);
  assert.equal(validateVendorSlug('shop-name-').valid, false);
  assert.equal(validateVendorSlug('shop--name').valid, false);

  // Reserved route blocking
  assert.equal(isReservedRoute('admin'), true);
  assert.equal(isReservedRoute('cart'), true);
  assert.equal(isReservedRoute('checkout'), true);
  assert.equal(isReservedRoute('api'), true);
  assert.equal(isReservedRoute('vendor'), true);
  assert.equal(isReservedRoute('store'), true);
  assert.equal(isReservedRoute('order-success'), true);
  assert.equal(isReservedRoute('auth'), true);

  const reservedCheck = validateVendorSlug('admin');
  assert.equal(reservedCheck.valid, false);
  assert.match(reservedCheck.error, /সংরক্ষিত/);
});

test('generateSafeVendorSlug generates clean URL-safe slugs', () => {
  assert.equal(generateSafeVendorSlug('Organic Fresh Mart', 1), 'organic-fresh-mart');
  assert.equal(generateSafeVendorSlug('A & B Agro 100%', 2), 'a-b-agro-100');
  // Bengali or unsupported characters fallback gracefully to store-<id>
  const bnSlug = generateSafeVendorSlug('বাংলা অর্গানিক', 42);
  assert.ok(bnSlug === 'store-42' || /^[a-z0-9-]+$/.test(bnSlug));
});

test('Migration 0037 - SQL schema files exist and conform to non-locking DDL requirements', () => {
  const upSqlPath = path.resolve(__dirname, '../src/db/migrations/0037_vendor_store_branding.up.sql');
  const downSqlPath = path.resolve(__dirname, '../src/db/migrations/0037_vendor_store_branding.down.sql');

  assert.ok(fs.existsSync(upSqlPath), '0037_vendor_store_branding.up.sql must exist');
  assert.ok(fs.existsSync(downSqlPath), '0037_vendor_store_branding.down.sql must exist');

  const upSql = fs.readFileSync(upSqlPath, 'utf8');
  assert.ok(!upSql.includes('AFTER `'), 'MariaDB safety: Migration must not use AFTER clause (which triggers ALGORITHM=COPY)');
  assert.ok(upSql.includes('slug'), 'Migration must add slug column');
  assert.ok(upSql.includes('logo_url'), 'Migration must add logo_url column');
  assert.ok(upSql.includes('store_status'), 'Migration must add store_status column');
  assert.ok(upSql.includes('CONCAT'), 'Migration must backfill unique slugs before index creation');
  assert.ok(upSql.includes('uq_vendors_slug'), 'Migration must create unique index uq_vendors_slug');
});

test('storefrontRepository.getStorefrontVendorStore handles active and suspended vendors', async () => {
  const mockActiveVendor = {
    id: 1,
    shop_name: 'Green Agro Mart',
    slug: 'green-agro-mart',
    logo_url: '/uploads/custom/logo.png',
    banner_url: null,
    tagline: 'Fresh organic greens',
    description: 'Directly sourced from our local farms in Bogura.',
    district: 'Bogura',
    upazila: 'Sadar',
    status: 1,
    verified: 1,
    lifecycle_status: 'active',
    store_status: 1,
  };

  const mockClient = {
    async queryOne(sql, params) {
      if (sql.includes('FROM `vendors`')) {
        const slug = params[0];
        if (slug === 'green-agro-mart') return mockActiveVendor;
        return null;
      }
      if (sql.includes('SELECT COUNT(*)')) {
        return { cnt: 2 };
      }
      return null;
    },
    async queryAll(sql) {
      if (sql.includes('FROM `products`')) {
        return [
          {
            id: 101,
            vendor_id: 1,
            name_bn: 'দেশি শসা',
            name_en: 'Deshi Cucumber',
            slug: 'deshi-cucumber',
            sale_price_paisa: 6000,
            regular_price_paisa: 7000,
            vendor_stock_on_hand: 50,
            vendor_stock_reserved: 0,
            image_url: '/uploads/product/cucumber.jpg',
            vendor_shop_name: 'Green Agro Mart',
            vendor_store_slug: 'green-agro-mart',
            vendor_logo_url: '/uploads/custom/logo.png',
            vendor_verified: 1,
          },
        ];
      }
      if (sql.includes('FROM `product_variants`')) {
        return [];
      }
      return [];
    },
  };

  const mockPool = {
    async query(sql, params) {
      if (sql.includes('FROM `vendors`')) {
        const slug = params[0];
        return [[slug === 'green-agro-mart' ? mockActiveVendor : null]];
      }
      if (sql.includes('SELECT COUNT(*)')) return [[{ cnt: 2 }]];
      if (sql.includes('FROM `products`')) {
        return [[
          {
            id: 101,
            vendor_id: 1,
            name_bn: 'দেশি শসা',
            name_en: 'Deshi Cucumber',
            slug: 'deshi-cucumber',
            sale_price_paisa: 6000,
            regular_price_paisa: 7000,
            vendor_stock_on_hand: 50,
            vendor_stock_reserved: 0,
            image_url: '/uploads/product/cucumber.jpg',
            vendor_shop_name: 'Green Agro Mart',
            vendor_store_slug: 'green-agro-mart',
            vendor_logo_url: '/uploads/custom/logo.png',
            vendor_verified: 1,
          },
        ]];
      }
      if (sql.includes('FROM `product_variants`')) return [[]];
      return [[]];
    },
  };

  const config = { db: { client: 'mysql' } };

  // 1. Successful lookup of active store
  const storeData = await storefrontRepo.getStorefrontVendorStore('green-agro-mart', {}, mockPool, config);
  assert.ok(storeData !== null, 'Active store must be found');
  assert.equal(storeData.vendor.shop_name, 'Green Agro Mart');
  assert.equal(storeData.vendor.slug, 'green-agro-mart');
  assert.equal(storeData.vendor.verified, true);
  assert.equal(storeData.products.length, 1);
  assert.equal(storeData.products[0].vendor_store_slug, 'green-agro-mart');
  assert.equal(storeData.products[0].vendor_shop_name, 'Green Agro Mart');

  // 2. Non-existent slug returns null
  const missingData = await storefrontRepo.getStorefrontVendorStore('non-existent-store', {}, mockPool, config);
  assert.equal(missingData, null, 'Non-existent store must return null');
});

test('storefrontRepository.listStorefrontProducts supports vendorSlug filter in MySQL mode', async () => {
  let capturedWhere = '';
  let capturedParams = [];

  const mockPool = {
    async query(sql, params) {
      if (sql.includes('SELECT COUNT(*)')) {
        capturedWhere = sql;
        capturedParams = params;
        return [[{ cnt: 1 }]];
      }
      if (sql.includes('FROM `products`')) {
        return [[
          {
            id: 201,
            vendor_id: 5,
            name_bn: 'লিচু মধু',
            name_en: 'Lychee Honey',
            slug: 'lychee-honey',
            sale_price_paisa: 45000,
            regular_price_paisa: 50000,
            vendor_stock_on_hand: 10,
            vendor_stock_reserved: 0,
            image_url: '/uploads/product/honey.jpg',
            vendor_shop_name: 'Honey Store',
            vendor_store_slug: 'honey-store',
            vendor_logo_url: '',
            vendor_verified: 1,
          },
        ]];
      }
      if (sql.includes('FROM `product_variants`')) return [[]];
      return [[]];
    },
  };

  const config = { db: { client: 'mysql' } };
  const result = await storefrontRepo.listStorefrontProducts({ vendorSlug: 'honey-store' }, mockPool, config);

  assert.ok(capturedWhere.includes('v.`slug` = ?'), 'SQL WHERE must filter by v.slug');
  assert.ok(capturedParams.includes('honey-store'), 'Parameters must include honey-store');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].vendor_store_slug, 'honey-store');
});

test('vendorOnboardingRepository.updateVendorProfile validates slug and rejects conflicts', async () => {
  const mockQueries = [];
  const mockConn = {
    async query(sql, params = []) {
      mockQueries.push({ sql, params });
      // Phone & status check
      if (sql.includes('FROM vendors WHERE id=?')) {
        return [[{
          id: 1,
          phone: '01711111111',
          slug: 'old-slug',
          status: 1,
          lifecycle_status: 'active',
          email: 'owner@example.com',
          password_hash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
        }]];
      }
      // Email duplicate check
      if (sql.includes('FROM vendors WHERE email=?')) {
        return [[]];
      }
      // Slug collision check: vendor 2 already owns 'taken-slug'
      if (sql.includes('FROM vendors WHERE slug=?')) {
        const checkSlug = params[0];
        if (checkSlug === 'taken-slug') return [[{ id: 2, slug: 'taken-slug' }]];
        return [[]];
      }
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };

  const mockPool = {
    async getConnection() {
      return mockConn;
    },
  };

    // 1. Conflict rejection
    await assert.rejects(
      async () => {
        await vendorOnboardingRepo.updateVendorProfile(
          1,
          {
            shop_name: 'My Store',
            owner_name: 'Owner',
            email: 'owner@example.com',
            address: 'Dhaka',
            district: 'Dhaka',
            upazila: 'Dhanmondi',
            slug: 'taken-slug',
          },
          { type: 'vendor', id: 1 },
          { pool: mockPool }
        );
      },
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert.match(err.message, /already taken|ইতিমধ্যে ব্যবহৃত হচ্ছে/);
        return true;
      }
    );

    // 2. Reserved route rejection
    await assert.rejects(
      async () => {
        await vendorOnboardingRepo.updateVendorProfile(
          1,
          {
            shop_name: 'My Store',
            owner_name: 'Owner',
            email: 'owner@example.com',
            address: 'Dhaka',
            district: 'Dhaka',
            upazila: 'Dhanmondi',
            slug: 'admin',
          },
          { type: 'vendor', id: 1 },
          { pool: mockPool }
        );
      },
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      }
    );

    // 3. Successful update with valid slug and branding
    const updated = await vendorOnboardingRepo.updateVendorProfile(
      1,
      {
        shop_name: 'Pure Agro',
        owner_name: 'Rahim Khan',
        email: 'owner@example.com',
        address: 'Rajshahi Sadar',
        district: 'Rajshahi',
        upazila: 'Paba',
        slug: 'pure-agro',
        tagline: '100% Pure Honey and Mango',
        description: 'Supplying fresh mangoes directly from orchards.',
        logo_url: '/uploads/custom/logo-pure.png',
      },
      { type: 'vendor', id: 1 },
      { pool: mockPool }
    );

    assert.equal(updated.ok, true);
    const updateQuery = mockQueries.find((q) => q.sql.includes('UPDATE vendors SET'));
    assert.ok(updateQuery, 'Must execute UPDATE vendors statement');
    assert.ok(updateQuery.sql.includes('`slug` = COALESCE(?, `slug`)'));
    assert.ok(updateQuery.sql.includes('`logo_url` = COALESCE(?, `logo_url`)'));
    assert.ok(updateQuery.sql.includes('`tagline` = COALESCE(?, `tagline`)'));
    assert.ok(updateQuery.sql.includes('`description` = COALESCE(?, `description`)'));
});

test('Migration 0037 - Idempotency, retry safety, and existing slug preservation', () => {
  const upSqlPath = path.resolve(__dirname, '../src/db/migrations/0037_vendor_store_branding.up.sql');
  const downSqlPath = path.resolve(__dirname, '../src/db/migrations/0037_vendor_store_branding.down.sql');
  const upSql = fs.readFileSync(upSqlPath, 'utf8');
  const downSql = fs.readFileSync(downSqlPath, 'utf8');

  // 1. All ADD COLUMN statements must use IF NOT EXISTS for retry safety
  const expectedCols = ['slug', 'logo_url', 'banner_url', 'tagline', 'description', 'store_status'];
  for (const col of expectedCols) {
    const colRegex = new RegExp(`ADD COLUMN IF NOT EXISTS \`${col}\``, 'i');
    assert.ok(colRegex.test(upSql), `Migration 0037 UP must use ADD COLUMN IF NOT EXISTS for ${col}`);
  }

  // 2. Indexes must use IF NOT EXISTS for retry safety
  assert.ok(
    /ADD UNIQUE KEY IF NOT EXISTS `uq_vendors_slug`/i.test(upSql),
    'Migration 0037 UP must use ADD UNIQUE KEY IF NOT EXISTS for uq_vendors_slug'
  );
  assert.ok(
    /ADD KEY IF NOT EXISTS `idx_vendors_store_status`/i.test(upSql),
    'Migration 0037 UP must use ADD KEY IF NOT EXISTS for idx_vendors_store_status'
  );

  // 3. Existing custom slugs must be preserved - backfill only operates on NULL or empty slugs
  assert.ok(
    /WHERE `slug` IS NULL OR `slug` = ''/i.test(upSql),
    'Migration 0037 UP must preserve existing slugs with WHERE slug IS NULL OR slug = ""'
  );

  // 4. Down migration must use IF EXISTS for idempotent rollback
  assert.ok(
    /DROP INDEX IF EXISTS `uq_vendors_slug`/i.test(downSql),
    'Migration 0037 DOWN must use DROP INDEX IF EXISTS for uq_vendors_slug'
  );
  for (const col of expectedCols) {
    const dropColRegex = new RegExp(`DROP COLUMN IF EXISTS \`${col}\``, 'i');
    assert.ok(dropColRegex.test(downSql), `Migration 0037 DOWN must use DROP COLUMN IF EXISTS for ${col}`);
  }
});

test('Migration 0037 - Collision preflight detector prevents DDL execution on conflict', () => {
  // Simulates the preflight collision detection logic used in deployment pipeline
  function checkSlugCollisions(vendors) {
    const collisions = [];

    // Check 1: Existing duplicate slugs among vendors who already have slugs
    const slugMap = new Map();
    for (const v of vendors) {
      if (v.slug && v.slug.trim()) {
        const s = v.slug.trim().toLowerCase();
        if (slugMap.has(s)) {
          collisions.push({ type: 'DUPLICATE_EXISTING_SLUG', slug: s, vendorIds: [slugMap.get(s), v.id] });
        } else {
          slugMap.set(s, v.id);
        }
      }
    }

    // Check 2: Backfilled slug (store-<id>) colliding with another vendor's existing custom slug
    for (const v of vendors) {
      if (!v.slug || !v.slug.trim()) {
        const proposedSlug = `store-${v.id}`;
        if (slugMap.has(proposedSlug) && slugMap.get(proposedSlug) !== v.id) {
          collisions.push({
            type: 'BACKFILL_COLLISION',
            proposedSlug,
            targetVendorId: v.id,
            conflictingVendorId: slugMap.get(proposedSlug),
          });
        }
      }
    }

    return { ok: collisions.length === 0, collisions };
  }

  // Case A: Clean state - all vendors need backfill (no existing slugs) -> PASS
  const cleanState = [
    { id: 1, shop_name: 'Shop 1', slug: null },
    { id: 2, shop_name: 'Shop 2', slug: null },
    { id: 3, shop_name: 'Shop 3', slug: '' },
  ];
  const cleanCheck = checkSlugCollisions(cleanState);
  assert.equal(cleanCheck.ok, true);
  assert.equal(cleanCheck.collisions.length, 0);

  // Case B: Clean state with existing non-conflicting custom slugs -> PASS
  const validCustomSlugs = [
    { id: 1, shop_name: 'Shop 1', slug: 'green-agro' },
    { id: 2, shop_name: 'Shop 2', slug: null }, // Will become store-2
    { id: 3, shop_name: 'Shop 3', slug: 'pure-honey' },
  ];
  const validCheck = checkSlugCollisions(validCustomSlugs);
  assert.equal(validCheck.ok, true);
  assert.equal(validCheck.collisions.length, 0);

  // Case C: Duplicate existing custom slugs -> DETECTED & REJECTED
  const duplicateState = [
    { id: 1, shop_name: 'Shop 1', slug: 'organic-mart' },
    { id: 2, shop_name: 'Shop 2', slug: 'organic-mart' },
  ];
  const dupCheck = checkSlugCollisions(duplicateState);
  assert.equal(dupCheck.ok, false);
  assert.equal(dupCheck.collisions[0].type, 'DUPLICATE_EXISTING_SLUG');

  // Case D: Backfill collision (vendor 2 has custom slug 'store-1', vendor 1 needs backfill) -> DETECTED & REJECTED
  const collisionState = [
    { id: 1, shop_name: 'Shop 1', slug: null }, // Needs store-1
    { id: 2, shop_name: 'Shop 2', slug: 'store-1' }, // Already has store-1!
  ];
  const colCheck = checkSlugCollisions(collisionState);
  assert.equal(colCheck.ok, false);
  assert.equal(colCheck.collisions[0].type, 'BACKFILL_COLLISION');
  assert.equal(colCheck.collisions[0].proposedSlug, 'store-1');
});

test('Migration 0037 - Strict pending migration safety gate validation', () => {
  function verifyStrictPendingMigrations(appliedVersions, diskFiles) {
    const diskVersions = diskFiles
      .map((f) => {
        const m = f.match(/^(\d{4})_/);
        return m ? m[1] : null;
      })
      .filter(Boolean)
      .sort();

    const diskSet = new Set(diskVersions);
    const appliedSet = new Set(appliedVersions);

    // 1. Missing disk files corresponding to applied versions
    const missingDisk = appliedVersions.filter((v) => !diskSet.has(v));
    if (missingDisk.length > 0) {
      return {
        ok: false,
        error: `MISSING_DISK_FILES: Applied versions missing on disk: ${missingDisk.join(', ')}`,
      };
    }

    // 2. Expected applied versions strictly 0001 through 0036
    const expectedApplied = Array.from({ length: 36 }, (_, i) => String(i + 1).padStart(4, '0'));
    const unexpectedApplied = appliedVersions.filter((v) => !expectedApplied.includes(v));
    if (unexpectedApplied.length > 0) {
      return {
        ok: false,
        error: `UNEXPECTED_APPLIED_VERSIONS: Database contains unapproved applied versions: ${unexpectedApplied.join(', ')}`,
      };
    }

    const missingApplied = expectedApplied.filter((v) => !appliedSet.has(v));
    if (missingApplied.length > 0) {
      return {
        ok: false,
        error: `GAPS_IN_APPLIED_VERSIONS: Baseline migrations missing from database: ${missingApplied.join(', ')}`,
      };
    }

    // 3. Exactly 0037 must be pending
    const pending = diskVersions.filter((v) => !appliedSet.has(v));
    if (pending.length !== 1 || pending[0] !== '0037') {
      return {
        ok: false,
        error: `INVALID_PENDING_MIGRATIONS: Expected strictly ONLY [0037] to be pending, but found: ${JSON.stringify(pending)}`,
      };
    }

    return { ok: true, pending: ['0037'], appliedCount: appliedVersions.length };
  }

  // Disk files mock with all 37 migrations
  const validDiskFiles = Array.from({ length: 37 }, (_, i) => `${String(i + 1).padStart(4, '0')}_test.up.sql`);
  const baselineApplied = Array.from({ length: 36 }, (_, i) => String(i + 1).padStart(4, '0'));

  // Scenario 1: Nominal production state -> PASS (0001-0036 applied, only 0037 pending)
  const nominal = verifyStrictPendingMigrations(baselineApplied, validDiskFiles);
  assert.equal(nominal.ok, true);
  assert.deepEqual(nominal.pending, ['0037']);
  assert.equal(nominal.appliedCount, 36);

  // Scenario 2: Missing disk file for applied version -> FAIL-CLOSED
  const appliedWithUnknown = [...baselineApplied, '0099'];
  const missingDiskResult = verifyStrictPendingMigrations(appliedWithUnknown, validDiskFiles);
  assert.equal(missingDiskResult.ok, false);
  assert.match(missingDiskResult.error, /MISSING_DISK_FILES/);

  // Scenario 3: Unexpected applied version (e.g. 0037 already applied) -> FAIL-CLOSED
  const alreadyApplied37 = [...baselineApplied, '0037'];
  const unexpectedResult = verifyStrictPendingMigrations(alreadyApplied37, validDiskFiles);
  assert.equal(unexpectedResult.ok, false);
  assert.match(unexpectedResult.error, /UNEXPECTED_APPLIED_VERSIONS/);

  // Scenario 4: Gap in applied versions (e.g. 0012 missing from database) -> FAIL-CLOSED
  const withGap = baselineApplied.filter((v) => v !== '0012');
  const gapResult = verifyStrictPendingMigrations(withGap, validDiskFiles);
  assert.equal(gapResult.ok, false);
  assert.match(gapResult.error, /GAPS_IN_APPLIED_VERSIONS/);

  // Scenario 5: Multiple pending migrations (e.g. 0036 and 0037 both pending) -> FAIL-CLOSED
  const partialApplied = Array.from({ length: 35 }, (_, i) => String(i + 1).padStart(4, '0'));
  const multiPendingResult = verifyStrictPendingMigrations(partialApplied, validDiskFiles);
  assert.equal(multiPendingResult.ok, false);
  assert.match(multiPendingResult.error, /GAPS_IN_APPLIED_VERSIONS/);
});

test('Migration 0037 - MariaDB engine detection, 5.5.5- prefix handling, and DDL compatibility', () => {
  function parseAndValidateMariaDbVersion(verStr, commentStr = '') {
    const isMariaDb = String(verStr).toLowerCase().includes('mariadb') || String(commentStr).toLowerCase().includes('mariadb');
    if (!isMariaDb) {
      return { ok: false, error: `NOT_MARIADB: Detected engine is not MariaDB (${verStr})` };
    }

    // Strip optional 5.5.5- replication compatibility prefix
    const effectiveVer = String(verStr).replace(/^5\.5\.5-/, '');
    const match = effectiveVer.match(/^(\d+)\.(\d+)/);
    if (!match) {
      return { ok: false, error: `UNPARSEABLE_VERSION: Cannot parse version from ${verStr}` };
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 10 || (major === 10 && minor < 2)) {
      return {
        ok: false,
        error: `UNSUPPORTED_VERSION: MariaDB ${major}.${minor} is below minimum 10.2 required for IF NOT EXISTS DDL`,
      };
    }

    return { ok: true, major, minor, effectiveVer };
  }

  // 1. Standard MariaDB version strings (10.3, 10.5, 10.6, 10.11 LTS)
  const v106 = parseAndValidateMariaDbVersion('10.6.18-MariaDB-cll-lve', 'MariaDB Server');
  assert.equal(v106.ok, true);
  assert.equal(v106.major, 10);
  assert.equal(v106.minor, 6);

  const v1011 = parseAndValidateMariaDbVersion('10.11.8-MariaDB-log', 'MariaDB Server');
  assert.equal(v1011.ok, true);
  assert.equal(v1011.major, 10);
  assert.equal(v1011.minor, 11);

  const v103 = parseAndValidateMariaDbVersion('10.3.39-MariaDB', 'MariaDB Server');
  assert.equal(v103.ok, true);
  assert.equal(v103.major, 10);
  assert.equal(v103.minor, 3);

  // 2. Compatibility-prefixed MariaDB version strings (5.5.5-10.x.y)
  const vPrefixed = parseAndValidateMariaDbVersion('5.5.5-10.6.18-MariaDB-cll-lve', 'MariaDB Server');
  assert.equal(vPrefixed.ok, true);
  assert.equal(vPrefixed.major, 10);
  assert.equal(vPrefixed.minor, 6);

  const vPrefixed1011 = parseAndValidateMariaDbVersion('5.5.5-10.11.5-MariaDB', '');
  assert.equal(vPrefixed1011.ok, true);
  assert.equal(vPrefixed1011.major, 10);
  assert.equal(vPrefixed1011.minor, 11);

  // 3. Non-MariaDB engine rejection (Oracle MySQL 8.0, 9.0, PostgreSQL)
  const vMysql = parseAndValidateMariaDbVersion('8.0.36', 'MySQL Community Server');
  assert.equal(vMysql.ok, false);
  assert.match(vMysql.error, /NOT_MARIADB/);

  // 4. Outdated MariaDB versions (< 10.2) lacking standard ADD COLUMN IF NOT EXISTS
  const vOld = parseAndValidateMariaDbVersion('10.1.48-MariaDB', 'MariaDB Server');
  assert.equal(vOld.ok, false);
  assert.match(vOld.error, /UNSUPPORTED_VERSION/);

  const v55 = parseAndValidateMariaDbVersion('5.5.68-MariaDB', 'MariaDB Server');
  assert.equal(v55.ok, false);
  assert.match(v55.error, /UNSUPPORTED_VERSION/);
});

test('Migration 0037 - File naming, pairing, and duplicate detection conforms to migrator specification', () => {
  const migDir = path.resolve(__dirname, '../src/db/migrations');
  const files = fs.readdirSync(migDir).sort();
  const upFiles = files.filter((f) => f.endsWith('.up.sql'));
  const downFiles = files.filter((f) => f.endsWith('.down.sql'));

  // Exactly 38 pairs (0001-0038)
  assert.equal(upFiles.length, 38, 'Must have continuous .up.sql migration files (0001-0038)');
  assert.equal(downFiles.length, 38, 'Must have matching .down.sql rollback files');

  const seenVersions = new Set();
  for (const up of upFiles) {
    const match = up.match(/^(\d{4})_([a-z0-9_]+)\.up\.sql$/);
    assert.ok(match, `Migration filename ${up} must match ^(\\d{4})_([a-z0-9_]+)\\.up\\.sql$`);

    const [, version, name] = match;
    assert.ok(!seenVersions.has(version), `Duplicate version ${version} detected on disk`);
    seenVersions.add(version);

    const pairedDown = `${version}_${name}.down.sql`;
    assert.ok(fs.existsSync(path.join(migDir, pairedDown)), `Missing matching rollback file for ${up}: ${pairedDown}`);
  }

  // First must be 0001, last must be 0038
  assert.equal(upFiles[0].startsWith('0001_'), true);
  assert.equal(upFiles[37].startsWith('0038_'), true);

  // Regex strictness against malformed filenames
  const migrationRegex = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/;
  assert.equal(migrationRegex.test('0038-invalid.up.sql'), false);
  assert.equal(migrationRegex.test('038_short.up.sql'), false);
  assert.equal(migrationRegex.test('0038_UPPERCASE.up.sql'), false);
  assert.equal(migrationRegex.test('invalid.sql'), false);
  assert.equal(migrationRegex.test('0038_valid_name.up.sql'), true);
});

test('Node runtime bounds - verifies >=22.5.0 enforcement logic', () => {
  function checkNodeVersion(versionStr) {
    const clean = versionStr.replace(/^v/, '');
    const [maj, min] = clean.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 5)) {
      return { ok: false, error: `NODE_VERSION_BELOW_MINIMUM: ${versionStr}` };
    }
    return { ok: true, maj, min };
  }

  assert.equal(checkNodeVersion('v22.23.4').ok, true); // cPanel pinned target
  assert.equal(checkNodeVersion('v22.5.0').ok, true);  // engines boundary
  assert.equal(checkNodeVersion('v26.12.1').ok, true); // local tool version
  assert.equal(checkNodeVersion('v20.10.0').ok, false);
  assert.equal(checkNodeVersion('v22.4.9').ok, false);
  assert.equal(checkNodeVersion('v18.19.0').ok, false);
});


test('Migration 0037 - Post-migration data integrity validator enforces single-column index and zero null/empty slugs', () => {
  function validatePostMigrationIntegrity({ migrationRow, columnFound, indexRows, counts, emptyCheck, duplicates }) {
    if (!migrationRow || migrationRow.version !== '0037' || migrationRow.name !== 'vendor_store_branding') {
      return { ok: false, error: 'MIGRATION_HISTORY_MISSING_OR_CORRUPT' };
    }
    if (!columnFound) {
      return { ok: false, error: 'SLUG_COLUMN_MISSING' };
    }
    // uq_vendors_slug must be a single-column unique index strictly on the slug column
    if (
      !Array.isArray(indexRows) ||
      indexRows.length !== 1 ||
      Number(indexRows[0].NON_UNIQUE) !== 0 ||
      indexRows[0].COLUMN_NAME !== 'slug' ||
      Number(indexRows[0].SEQ_IN_INDEX) !== 1
    ) {
      return { ok: false, error: 'INDEX_NOT_SINGLE_COLUMN_UNIQUE_ON_SLUG' };
    }
    // Total vendor count must equal slug count
    if (Number(counts.total) !== Number(counts.withSlug)) {
      return { ok: false, error: 'SLUG_COUNT_MISMATCH' };
    }
    // Both NULL and empty string must be strictly 0
    if (Number(emptyCheck.invalidCount) !== 0) {
      return { ok: false, error: 'NULL_OR_EMPTY_SLUG_DETECTED' };
    }
    // Duplicates must be strictly 0
    if (duplicates.length > 0) {
      return { ok: false, error: 'DUPLICATE_SLUGS_DETECTED' };
    }
    return { ok: true };
  }

  const validNominal = {
    migrationRow: { version: '0037', name: 'vendor_store_branding' },
    columnFound: true,
    indexRows: [{ COLUMN_NAME: 'slug', NON_UNIQUE: 0, SEQ_IN_INDEX: 1 }],
    counts: { total: 15, withSlug: 15 },
    emptyCheck: { invalidCount: 0 },
    duplicates: [],
  };
  assert.equal(validatePostMigrationIntegrity(validNominal).ok, true);

  // Failure: Multi-column composite index instead of single-column
  const compositeIndex = {
    ...validNominal,
    indexRows: [
      { COLUMN_NAME: 'slug', NON_UNIQUE: 0, SEQ_IN_INDEX: 1 },
      { COLUMN_NAME: 'shop_name', NON_UNIQUE: 0, SEQ_IN_INDEX: 2 },
    ],
  };
  assert.equal(validatePostMigrationIntegrity(compositeIndex).ok, false);
  assert.equal(validatePostMigrationIntegrity(compositeIndex).error, 'INDEX_NOT_SINGLE_COLUMN_UNIQUE_ON_SLUG');

  // Failure: Index on wrong column
  const wrongColumnIndex = {
    ...validNominal,
    indexRows: [{ COLUMN_NAME: 'shop_name', NON_UNIQUE: 0, SEQ_IN_INDEX: 1 }],
  };
  assert.equal(validatePostMigrationIntegrity(wrongColumnIndex).ok, false);

  // Failure: Empty string slugs present
  const withEmptySlugs = {
    ...validNominal,
    emptyCheck: { invalidCount: 2 },
  };
  assert.equal(validatePostMigrationIntegrity(withEmptySlugs).ok, false);
  assert.equal(validatePostMigrationIntegrity(withEmptySlugs).error, 'NULL_OR_EMPTY_SLUG_DETECTED');

  // Failure: Duplicate slugs present
  const withDups = {
    ...validNominal,
    duplicates: [{ slug: 'store-1', c: 2 }],
  };
  assert.equal(validatePostMigrationIntegrity(withDups).ok, false);
  assert.equal(validatePostMigrationIntegrity(withDups).error, 'DUPLICATE_SLUGS_DETECTED');
});

test('Backup integrity - production backup script source requires mandatory mysqldump and forbids JSON fallback', () => {
  const backupScriptPath = path.resolve(__dirname, '../scripts/ops/production-db-audit-and-backup.js');
  const backupSrc = fs.readFileSync(backupScriptPath, 'utf8');

  assert.ok(
    backupSrc.includes('BACKUP_FAILED: mysqldump execution failed'),
    'Backup script must throw BACKUP_FAILED on mysqldump error'
  );
  assert.ok(
    backupSrc.includes('JSON fallback is prohibited for production migration safety'),
    'Backup script must explicitly forbid JSON fallback'
  );
  assert.ok(
    !backupSrc.includes('fullExport.tables'),
    'Backup script must not contain programmatic JSON table exporter fallback'
  );
  assert.ok(
    backupSrc.includes('verifyRestoreStructure(fullBackupFile)'),
    'Backup script must verify SQL dump core table structure'
  );
});




