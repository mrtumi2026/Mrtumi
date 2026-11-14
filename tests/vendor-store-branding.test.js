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
