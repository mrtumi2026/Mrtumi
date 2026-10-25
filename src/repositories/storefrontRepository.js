'use strict';

/**
 * PHASE 05: Storefront Catalogue, Content & Support Repository
 *
 * Production target: MySQL (`InnoDB`, `utf8mb4_unicode_ci`, integer `paisa` columns).
 * Local prototype fallback: Non-production SQLite bridge (`src/db/database.js`),
 * automatically guarded by `assertSqliteAllowed()` in production or when `DB_CLIENT=mysql`.
 */

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { bdtToPaisa, paisaToBdtString } = require('../utils/money');
const { replaceLegacyBrandTokens } = require('../i18n/brand');

const ALLOWED_SORTS = new Set(['newest', 'price_asc', 'price_desc', 'best_selling', 'name_asc']);
const DEFAULT_PER_PAGE = 12;
const MAX_PER_PAGE = 48;

function isMysqlMode(config = env) {
  return config.db.client === 'mysql';
}

function getClient(poolOverride = null) {
  return createQueryClient(poolOverride || getPool());
}

function pickLocalizedText(locale, bnVal, enVal, fallback = '') {
  const bn = replaceLegacyBrandTokens(String(bnVal || '').trim(), 'bn');
  const en = replaceLegacyBrandTokens(String(enVal || '').trim(), 'en');
  if (locale === 'en') {
    return en || bn || fallback;
  }
  return bn || en || fallback;
}

function sanitizeImagePath(rawPath, fallback = '/uploads/product/lychee-fresh.jpg') {
  const clean = String(rawPath || '').trim();
  if (!clean) return fallback;
  if (clean.startsWith('/') && !clean.startsWith('//') && !clean.includes('..')) {
    return clean;
  }
  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }
  return fallback;
}

function parseGalleryImages(primaryImage, rawGalleryJson) {
  const primary = sanitizeImagePath(primaryImage, '');
  const list = [];
  if (primary) list.push(primary);

  if (rawGalleryJson) {
    try {
      const parsed = typeof rawGalleryJson === 'string' ? JSON.parse(rawGalleryJson) : rawGalleryJson;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const candidate = sanitizeImagePath(
            typeof item === 'string' ? item : item && (item.url || item.image),
            ''
          );
          if (candidate && !list.includes(candidate)) {
            list.push(candidate);
          }
        }
      }
    } catch (_err) {
      // Ignore malformed gallery JSON; rely on primary image only.
    }
  }

  if (list.length === 0) {
    list.push('/uploads/product/lychee-fresh.jpg');
  }
  return list;
}

function parsePromoWindow(enabledFlag, rawEndIso, nowMs = Date.now()) {
  if (String(enabledFlag ?? '1') === '0' || enabledFlag === false) {
    return { active: false, countdownIso: null };
  }
  const trimmed = String(rawEndIso || '').trim();
  if (!trimmed) {
    return { active: true, countdownIso: null };
  }
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) {
    return { active: true, countdownIso: null };
  }
  if (parsedMs <= nowMs) {
    return { active: false, countdownIso: null };
  }
  return { active: true, countdownIso: new Date(parsedMs).toISOString() };
}

function normalizeVariantRow(row) {
  const pricePaisa = Number(row.price_paisa || 0);
  const availableStock = Math.max(0, Number(row.stock_on_hand || 0) - Number(row.stock_reserved || 0));
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    variant_sku: String(row.variant_sku || ''),
    size_label: String(row.size_label || '').trim(),
    color_label: String(row.color_label || '').trim(),
    price_paisa: pricePaisa,
    price: Number(paisaToBdtString(pricePaisa)),
    available_stock: availableStock,
    is_in_stock: availableStock > 0,
  };
}

function normalizeMysqlProduct(row, variants = [], locale = 'bn') {
  const salePricePaisa = Number(row.sale_price_paisa || 0);
  const regularPricePaisa = Number(row.regular_price_paisa || 0);
  const wholesalePricePaisa = Number(row.wholesale_price_paisa || 0);
  const wholesaleMinQty = Math.max(0, Number(row.wholesale_min_qty || 0));

  const isVendorProduct = row.vendor_id !== null && row.vendor_id !== undefined;
  const availableStock = isVendorProduct
    ? Math.max(0, Number(row.vendor_stock_on_hand || 0) - Number(row.vendor_stock_reserved || 0))
    : Math.max(0, Number(row.stock_on_hand || 0) - Number(row.stock_reserved || 0));

  const lowStockThreshold = Math.max(1, Number(row.low_stock_threshold || 10));
  const hasDiscount = regularPricePaisa > salePricePaisa && salePricePaisa > 0;
  const discountPct = hasDiscount
    ? Math.round(((regularPricePaisa - salePricePaisa) / regularPricePaisa) * 100)
    : 0;

  const normalizedVariants = variants.map(normalizeVariantRow);
  const sizeSet = new Set();
  const colorSet = new Set();
  for (const v of normalizedVariants) {
    if (v.size_label) sizeSet.add(v.size_label);
    if (v.color_label) colorSet.add(v.color_label);
  }
  const unitLabel = String(row.unit_label || '').trim();
  if (sizeSet.size === 0 && unitLabel) {
    sizeSet.add(unitLabel);
  }

  const sizeOptions = Array.from(sizeSet);
  const colorOptions = Array.from(colorSet);
  const galleryImages = parseGalleryImages(row.image_url, row.gallery_json);
  const approvalStatus = String(row.approval_status || 'approved');
  const hasValidWholesale =
    Boolean(Number(row.is_wholesale || 0)) &&
    approvalStatus === 'approved' &&
    wholesaleMinQty >= 2 &&
    wholesalePricePaisa > 0 &&
    wholesalePricePaisa < salePricePaisa;

  return {
    id: Number(row.id),
    sku: String(row.sku || ''),
    code: String(row.sku || ''),
    barcode: String(row.barcode || ''),
    slug: String(row.slug || ''),
    name_bn: replaceLegacyBrandTokens(row.name_bn || '', 'bn'),
    name_en: replaceLegacyBrandTokens(row.name_en || '', 'en'),
    name: pickLocalizedText(locale, row.name_bn, row.name_en, String(row.slug || '')),
    category_id: row.category_id ? Number(row.category_id) : null,
    category_name: pickLocalizedText(locale, row.category_name_bn, row.category_name_en, ''),
    category_slug: String(row.category_slug || ''),
    subcategory_id: row.subcategory_id ? Number(row.subcategory_id) : null,
    subcategory_name: pickLocalizedText(locale, row.subcategory_name_bn, row.subcategory_name_en, ''),
    subcategory_slug: String(row.subcategory_slug || ''),
    childcategory_id: row.childcategory_id ? Number(row.childcategory_id) : null,
    childcategory_name: pickLocalizedText(locale, row.childcategory_name_bn, row.childcategory_name_en, ''),
    childcategory_slug: String(row.childcategory_slug || ''),
    brand_id: row.brand_id ? Number(row.brand_id) : null,
    brand_name: pickLocalizedText(locale, row.brand_name_bn, row.brand_name_en, ''),
    brand_slug: String(row.brand_slug || ''),
    vendor_id: isVendorProduct ? Number(row.vendor_id) : null,
    vendor_shop_name: String(row.vendor_shop_name || ''),
    old_price_paisa: regularPricePaisa,
    new_price_paisa: salePricePaisa,
    wholesale_price_paisa: hasValidWholesale ? wholesalePricePaisa : 0,
    old_price: Number(paisaToBdtString(regularPricePaisa)),
    new_price: Number(paisaToBdtString(salePricePaisa)),
    wholesale_price: hasValidWholesale ? Number(paisaToBdtString(wholesalePricePaisa)) : 0,
    wholesale_min_qty: hasValidWholesale ? wholesaleMinQty : 0,
    has_discount: hasDiscount,
    discount_pct: discountPct,
    savings_paisa: hasDiscount ? regularPricePaisa - salePricePaisa : 0,
    available_stock: availableStock,
    stock: availableStock,
    low_stock_threshold: lowStockThreshold,
    is_in_stock: availableStock > 0,
    is_low_stock: availableStock > 0 && availableStock <= lowStockThreshold,
    sold_count: Number(row.sold_count || 0),
    unit: unitLabel,
    image: galleryImages[0],
    gallery_images: galleryImages,
    short_desc: pickLocalizedText(locale, row.short_desc_bn, row.short_desc_en, ''),
    description: pickLocalizedText(locale, row.description_bn, row.description_en, ''),
    variants: normalizedVariants,
    size_options: sizeOptions,
    color_options: colorOptions,
    sizes: sizeOptions.join(','),
    colors: colorOptions.join(','),
    has_required_options: normalizedVariants.length > 0 || sizeOptions.length > 1 || colorOptions.length > 0,
    is_flash_sale: Boolean(Number(row.is_flash_sale || 0)),
    is_hot_deal: Boolean(Number(row.is_hot_deal || 0)),
    is_wholesale: Boolean(Number(row.is_wholesale || 0)),
    has_valid_wholesale: hasValidWholesale,
    is_gift_eligible: Boolean(Number(row.is_gift_eligible || 0)),
    approval_status: approvalStatus,
  };
}

function normalizeSqliteProduct(row, locale = 'bn') {
  const newPriceBdt = Math.max(0, Number(row.new_price || 0));
  const oldPriceBdt = Math.max(0, Number(row.old_price || 0));
  const rawWholesaleBdt = Math.max(0, Number(row.wholesale_price || 0));
  const wholesaleMinQty = Math.max(0, Number(row.wholesale_min_qty || 0));

  const newPricePaisa = bdtToPaisa(newPriceBdt);
  const oldPricePaisa = bdtToPaisa(oldPriceBdt);
  const wholesalePricePaisa = bdtToPaisa(rawWholesaleBdt);
  const availableStock = Math.max(0, Number(row.stock || 0));
  const hasDiscount = oldPricePaisa > newPricePaisa && newPricePaisa > 0;
  const discountPct = hasDiscount
    ? Math.round(((oldPricePaisa - newPricePaisa) / oldPricePaisa) * 100)
    : 0;

  const sizeOptions = String(row.sizes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const colorOptions = String(row.colors || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const galleryImages = parseGalleryImages(row.image, row.gallery);
  const approvalStatus = String(row.approval_status || 'approved');
  const hasValidWholesale =
    Boolean(Number(row.is_wholesale || 0)) &&
    approvalStatus === 'approved' &&
    wholesaleMinQty >= 2 &&
    wholesalePricePaisa > 0 &&
    wholesalePricePaisa < newPricePaisa;

  return {
    id: Number(row.id),
    sku: String(row.code || ''),
    code: String(row.code || ''),
    barcode: String(row.barcode || ''),
    slug: String(row.slug || ''),
    name_bn: replaceLegacyBrandTokens(row.name || '', 'bn'),
    name_en: replaceLegacyBrandTokens(row.name_en || '', 'en'),
    name: pickLocalizedText(locale, row.name, row.name_en, String(row.slug || '')),
    category_id: row.category_id ? Number(row.category_id) : null,
    category_name: pickLocalizedText(locale, row.category_name, row.category_name_en, ''),
    category_slug: String(row.category_slug || ''),
    subcategory_id: row.subcategory_id ? Number(row.subcategory_id) : null,
    subcategory_name: pickLocalizedText(locale, row.subcategory_name, row.subcategory_name_en, ''),
    subcategory_slug: String(row.subcategory_slug || ''),
    childcategory_id: null,
    childcategory_name: '',
    childcategory_slug: '',
    brand_id: row.brand_id ? Number(row.brand_id) : null,
    brand_name: pickLocalizedText(locale, row.brand_name, row.brand_name_en, ''),
    brand_slug: String(row.brand_slug || ''),
    vendor_id: row.vendor_id ? Number(row.vendor_id) : null,
    vendor_shop_name: String(row.vendor_shop_name || ''),
    old_price_paisa: oldPricePaisa,
    new_price_paisa: newPricePaisa,
    wholesale_price_paisa: hasValidWholesale ? wholesalePricePaisa : 0,
    old_price: oldPriceBdt,
    new_price: newPriceBdt,
    wholesale_price: hasValidWholesale ? rawWholesaleBdt : 0,
    wholesale_min_qty: hasValidWholesale ? wholesaleMinQty : 0,
    has_discount: hasDiscount,
    discount_pct: discountPct,
    savings_paisa: hasDiscount ? oldPricePaisa - newPricePaisa : 0,
    available_stock: availableStock,
    stock: availableStock,
    low_stock_threshold: 10,
    is_in_stock: availableStock > 0,
    is_low_stock: availableStock > 0 && availableStock <= 10,
    sold_count: Number(row.sold_count || 0),
    unit: String(row.unit || '').trim(),
    image: galleryImages[0],
    gallery_images: galleryImages,
    short_desc: pickLocalizedText(locale, row.short_desc, row.short_desc_en, ''),
    description: pickLocalizedText(locale, row.description, row.description_en, ''),
    variants: [],
    size_options: sizeOptions,
    color_options: colorOptions,
    sizes: sizeOptions.join(','),
    colors: colorOptions.join(','),
    has_required_options: sizeOptions.length > 1 || colorOptions.length > 0,
    is_flash_sale: Boolean(Number(row.is_flash_sale || 0)),
    is_hot_deal: Boolean(Number(row.is_hot_deal || 0)),
    is_wholesale: Boolean(Number(row.is_wholesale || 0)),
    has_valid_wholesale: hasValidWholesale,
    is_gift_eligible: Boolean(Number(row.is_gift_eligible || 0)),
    approval_status: approvalStatus,
  };
}

const MYSQL_PRODUCT_SELECT = `
  SELECT
    p.*,
    c.\`name_bn\` AS category_name_bn,
    c.\`name_en\` AS category_name_en,
    c.\`slug\` AS category_slug,
    sc.\`name_bn\` AS subcategory_name_bn,
    sc.\`name_en\` AS subcategory_name_en,
    sc.\`slug\` AS subcategory_slug,
    cc.\`name_bn\` AS childcategory_name_bn,
    cc.\`name_en\` AS childcategory_name_en,
    cc.\`slug\` AS childcategory_slug,
    b.\`name_bn\` AS brand_name_bn,
    b.\`name_en\` AS brand_name_en,
    b.\`slug\` AS brand_slug,
    v.\`shop_name\` AS vendor_shop_name
  FROM \`products\` p
  LEFT JOIN \`categories\` c ON c.\`id\` = p.\`category_id\`
  LEFT JOIN \`subcategories\` sc ON sc.\`id\` = p.\`subcategory_id\`
  LEFT JOIN \`childcategories\` cc ON cc.\`id\` = p.\`childcategory_id\`
  LEFT JOIN \`brands\` b ON b.\`id\` = p.\`brand_id\`
  LEFT JOIN \`vendors\` v ON v.\`id\` = p.\`vendor_id\`
`;

const MYSQL_ACTIVE_PRODUCT_WHERE = `
  p.\`status\` = 1
  AND p.\`is_archived\` = 0
  AND p.\`approval_status\` = 'approved'
  AND (p.\`vendor_id\` IS NULL OR (v.\`status\` = 1 AND v.\`verified\` = 1))
`;

const SQLITE_PRODUCT_SELECT = `
  SELECT
    p.*,
    c.name AS category_name,
    c.slug AS category_slug,
    sc.name AS subcategory_name,
    sc.slug AS subcategory_slug,
    b.name AS brand_name,
    b.slug AS brand_slug,
    v.shop_name AS vendor_shop_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN vendors v ON v.id = p.vendor_id
`;

const SQLITE_ACTIVE_PRODUCT_WHERE = `
  p.status = 1
  AND COALESCE(p.approval_status, 'approved') = 'approved'
  AND (p.vendor_id IS NULL OR (COALESCE(v.status, 1) = 1 AND COALESCE(v.verified, 1) = 1))
`;

async function attachVariantsMysql(rows, client, locale) {
  if (!rows.length) return [];
  const productIds = rows.map((r) => Number(r.id));
  const placeholders = productIds.map(() => '?').join(',');
  const variantRows = await client.queryAll(
    `SELECT * FROM \`product_variants\`
     WHERE \`status\` = 1 AND \`product_id\` IN (${placeholders})
     ORDER BY \`id\` ASC`,
    productIds
  );
  const byProduct = new Map();
  for (const vr of variantRows) {
    const pid = Number(vr.product_id);
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(vr);
  }
  return rows.map((row) => normalizeMysqlProduct(row, byProduct.get(Number(row.id)) || [], locale));
}

function normalizeSortOption(sort) {
  const clean = String(sort || 'newest').trim().toLowerCase();
  return ALLOWED_SORTS.has(clean) ? clean : 'newest';
}

function sanitizePagination(pageInput, perPageInput) {
  const page = Math.max(1, parseInt(String(pageInput || '1'), 10) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, parseInt(String(perPageInput || DEFAULT_PER_PAGE), 10) || DEFAULT_PER_PAGE)
  );
  return { page, perPage, offset: (page - 1) * perPage };
}

async function getCatalogFacets(options = {}, poolOverride = null, config = env) {
  const locale = options.locale || 'bn';

  if (!isMysqlMode(config) && !poolOverride) {
    const rawCats = sqliteDb.all(
      `SELECT c.*,
              (SELECT COUNT(*) FROM products p
               WHERE p.category_id = c.id AND p.status = 1 AND COALESCE(p.approval_status, 'approved') = 'approved') AS product_count
       FROM categories c
       WHERE c.status = 1
       ORDER BY c.sort_order ASC, c.id ASC`
    );
    const rawSubcats = sqliteDb.all(
      'SELECT * FROM subcategories WHERE status = 1 ORDER BY id ASC'
    );
    const rawChildcats = sqliteDb.all(
      'SELECT * FROM childcategories WHERE status = 1 ORDER BY id ASC'
    );
    const rawBrands = sqliteDb.all(
      `SELECT b.*,
              (SELECT COUNT(*) FROM products p
               WHERE p.brand_id = b.id AND p.status = 1 AND COALESCE(p.approval_status, 'approved') = 'approved') AS product_count
       FROM brands b
       WHERE b.status = 1
       ORDER BY b.id ASC`
    );

    const childBySub = new Map();
    for (const cc of rawChildcats) {
      const sid = Number(cc.subcategory_id);
      if (!childBySub.has(sid)) childBySub.set(sid, []);
      childBySub.get(sid).push({
        id: Number(cc.id),
        subcategory_id: sid,
        slug: String(cc.slug || ''),
        name: pickLocalizedText(locale, cc.name, cc.name_en, ''),
      });
    }

    const subByCat = new Map();
    for (const sc of rawSubcats) {
      const cid = Number(sc.category_id);
      if (!subByCat.has(cid)) subByCat.set(cid, []);
      subByCat.get(cid).push({
        id: Number(sc.id),
        category_id: cid,
        slug: String(sc.slug || ''),
        name: pickLocalizedText(locale, sc.name, sc.name_en, ''),
        childcategories: childBySub.get(Number(sc.id)) || [],
      });
    }

    const categories = rawCats.map((c) => ({
      id: Number(c.id),
      slug: String(c.slug || ''),
      name: pickLocalizedText(locale, c.name, c.name_en, ''),
      icon: String(c.icon || '🛒'),
      image: sanitizeImagePath(c.image, '/uploads/product/lychee-fresh.jpg'),
      front_view: Boolean(Number(c.front_view ?? 1)),
      product_count: Number(c.product_count || 0),
      subcategories: subByCat.get(Number(c.id)) || [],
    }));

    const brands = rawBrands.map((b) => ({
      id: Number(b.id),
      slug: String(b.slug || ''),
      name: pickLocalizedText(locale, b.name, b.name_en, ''),
      product_count: Number(b.product_count || 0),
    }));

    return { categories, brands };
  }

  const client = getClient(poolOverride);
  const [rawCats, rawSubcats, rawChildcats, rawBrands] = await Promise.all([
    client.queryAll(
      `SELECT c.*,
              (SELECT COUNT(*) FROM \`products\` p
               WHERE p.\`category_id\` = c.\`id\` AND p.\`status\` = 1 AND p.\`is_archived\` = 0 AND p.\`approval_status\` = 'approved') AS product_count
       FROM \`categories\` c
       WHERE c.\`status\` = 1
       ORDER BY c.\`sort_order\` ASC, c.\`id\` ASC`
    ),
    client.queryAll(
      'SELECT * FROM `subcategories` WHERE `status` = 1 ORDER BY `id` ASC'
    ),
    client.queryAll(
      'SELECT * FROM `childcategories` WHERE `status` = 1 ORDER BY `id` ASC'
    ),
    client.queryAll(
      `SELECT b.*,
              (SELECT COUNT(*) FROM \`products\` p
               WHERE p.\`brand_id\` = b.\`id\` AND p.\`status\` = 1 AND p.\`is_archived\` = 0 AND p.\`approval_status\` = 'approved') AS product_count
       FROM \`brands\` b
       WHERE b.\`status\` = 1
       ORDER BY b.\`id\` ASC`
    ),
  ]);

  const childBySub = new Map();
  for (const cc of rawChildcats) {
    const sid = Number(cc.subcategory_id);
    if (!childBySub.has(sid)) childBySub.set(sid, []);
    childBySub.get(sid).push({
      id: Number(cc.id),
      subcategory_id: sid,
      slug: String(cc.slug || ''),
      name: pickLocalizedText(locale, cc.name_bn, cc.name_en, ''),
    });
  }

  const subByCat = new Map();
  for (const sc of rawSubcats) {
    const cid = Number(sc.category_id);
    if (!subByCat.has(cid)) subByCat.set(cid, []);
    subByCat.get(cid).push({
      id: Number(sc.id),
      category_id: cid,
      slug: String(sc.slug || ''),
      name: pickLocalizedText(locale, sc.name_bn, sc.name_en, ''),
      childcategories: childBySub.get(Number(sc.id)) || [],
    });
  }

  const categories = rawCats.map((c) => ({
    id: Number(c.id),
    slug: String(c.slug || ''),
    name: pickLocalizedText(locale, c.name_bn, c.name_en, ''),
    icon: String(c.icon || '🛒'),
    image: sanitizeImagePath(c.image_url, '/uploads/product/lychee-fresh.jpg'),
    front_view: Boolean(Number(c.front_view ?? 1)),
    product_count: Number(c.product_count || 0),
    subcategories: subByCat.get(Number(c.id)) || [],
  }));

  const brands = rawBrands.map((b) => ({
    id: Number(b.id),
    slug: String(b.slug || ''),
    name: pickLocalizedText(locale, b.name_bn, b.name_en, ''),
    product_count: Number(b.product_count || 0),
  }));

  return { categories, brands };
}

async function listStorefrontProducts(filters = {}, poolOverride = null, config = env) {
  const locale = filters.locale || 'bn';
  const q = String(filters.q || '').trim().slice(0, 120);
  const categorySlug = String(filters.categorySlug || '').trim();
  const subcategorySlug = String(filters.subcategorySlug || '').trim();
  const childcategorySlug = String(filters.childcategorySlug || '').trim();
  const brandSlug = String(filters.brandSlug || '').trim();
  const dealType = String(filters.dealType || '').trim().toLowerCase();
  const inStockOnly =
    filters.inStockOnly === true ||
    filters.inStockOnly === '1' ||
    filters.inStockOnly === 'true';

  const minPriceRaw = filters.minPrice !== undefined && filters.minPrice !== '' ? Number(filters.minPrice) : null;
  const maxPriceRaw = filters.maxPrice !== undefined && filters.maxPrice !== '' ? Number(filters.maxPrice) : null;
  const minPrice = minPriceRaw !== null && Number.isFinite(minPriceRaw) && minPriceRaw >= 0 ? minPriceRaw : null;
  const maxPrice = maxPriceRaw !== null && Number.isFinite(maxPriceRaw) && maxPriceRaw >= 0 ? maxPriceRaw : null;

  const sort = normalizeSortOption(filters.sort);
  const { page, perPage, offset } = sanitizePagination(filters.page, filters.perPage);

  if (!isMysqlMode(config) && !poolOverride) {
    const clauses = [SQLITE_ACTIVE_PRODUCT_WHERE];
    const params = [];

    if (q) {
      const like = `%${q}%`;
      clauses.push('(p.name LIKE ? OR p.code LIKE ? OR p.short_desc LIKE ? OR c.name LIKE ? OR b.name LIKE ?)');
      params.push(like, like, like, like, like);
    }
    if (categorySlug) {
      clauses.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (subcategorySlug) {
      clauses.push('sc.slug = ?');
      params.push(subcategorySlug);
    }
    if (childcategorySlug) {
      const cc = sqliteDb.get(
        'SELECT subcategory_id FROM childcategories WHERE slug = ? AND status = 1',
        childcategorySlug
      );
      if (!cc) {
        return { items: [], total: 0, page, perPage, totalPages: 0, sort };
      }
      clauses.push('p.subcategory_id = ?');
      params.push(Number(cc.subcategory_id));
    }
    if (brandSlug) {
      clauses.push('b.slug = ?');
      params.push(brandSlug);
    }
    if (minPrice !== null) {
      clauses.push('p.new_price >= ?');
      params.push(minPrice);
    }
    if (maxPrice !== null) {
      clauses.push('p.new_price <= ?');
      params.push(maxPrice);
    }
    if (inStockOnly) {
      clauses.push('p.stock > 0');
    }
    if (dealType === 'flash') {
      clauses.push('p.is_flash_sale = 1');
    } else if (dealType === 'hot') {
      clauses.push('p.is_hot_deal = 1');
    } else if (dealType === 'wholesale') {
      clauses.push('p.is_wholesale = 1 AND p.wholesale_price > 0 AND p.wholesale_price < p.new_price AND p.wholesale_min_qty >= 2');
    }

    const whereSql = clauses.join(' AND ');
    let orderBySql = 'ORDER BY p.id DESC';
    if (sort === 'price_asc') orderBySql = 'ORDER BY p.new_price ASC, p.id DESC';
    else if (sort === 'price_desc') orderBySql = 'ORDER BY p.new_price DESC, p.id DESC';
    else if (sort === 'best_selling') orderBySql = 'ORDER BY p.sold_count DESC, p.id DESC';
    else if (sort === 'name_asc') orderBySql = 'ORDER BY p.name ASC, p.id DESC';

    const countRow = sqliteDb.get(
      `SELECT COUNT(*) AS cnt
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE ${whereSql}`,
      ...params
    );
    const total = Number(countRow?.cnt || 0);
    const totalPages = total > 0 ? Math.ceil(total / perPage) : 0;

    const rows = sqliteDb.all(
      `${SQLITE_PRODUCT_SELECT}
       WHERE ${whereSql}
       ${orderBySql}
       LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      offset
    );

    return {
      items: rows.map((r) => normalizeSqliteProduct(r, locale)),
      total,
      page,
      perPage,
      totalPages,
      sort,
    };
  }

  const client = getClient(poolOverride);
  const clauses = [MYSQL_ACTIVE_PRODUCT_WHERE];
  const params = [];

  if (q) {
    const like = `%${q}%`;
    clauses.push(
      `(p.\`name_bn\` LIKE ? OR p.\`name_en\` LIKE ? OR p.\`sku\` LIKE ? OR COALESCE(p.\`barcode\`, '') LIKE ?
        OR COALESCE(p.\`short_desc_bn\`, '') LIKE ? OR COALESCE(p.\`short_desc_en\`, '') LIKE ?
        OR COALESCE(c.\`name_bn\`, '') LIKE ? OR COALESCE(c.\`name_en\`, '') LIKE ?
        OR COALESCE(b.\`name_bn\`, '') LIKE ? OR COALESCE(b.\`name_en\`, '') LIKE ?)`
    );
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  if (categorySlug) {
    clauses.push('c.`slug` = ?');
    params.push(categorySlug);
  }
  if (subcategorySlug) {
    clauses.push('sc.`slug` = ?');
    params.push(subcategorySlug);
  }
  if (childcategorySlug) {
    clauses.push('cc.`slug` = ?');
    params.push(childcategorySlug);
  }
  if (brandSlug) {
    clauses.push('b.`slug` = ?');
    params.push(brandSlug);
  }
  if (minPrice !== null) {
    clauses.push('p.`sale_price_paisa` >= ?');
    params.push(bdtToPaisa(minPrice));
  }
  if (maxPrice !== null) {
    clauses.push('p.`sale_price_paisa` <= ?');
    params.push(bdtToPaisa(maxPrice));
  }
  if (inStockOnly) {
    clauses.push(
      '((p.`vendor_id` IS NULL AND (p.`stock_on_hand` - p.`stock_reserved`) > 0) OR (p.`vendor_id` IS NOT NULL AND (p.`vendor_stock_on_hand` - p.`vendor_stock_reserved`) > 0))'
    );
  }
  if (dealType === 'flash') {
    clauses.push('p.`is_flash_sale` = 1');
  } else if (dealType === 'hot') {
    clauses.push('p.`is_hot_deal` = 1');
  } else if (dealType === 'gift') {
    clauses.push('p.`is_gift_eligible` = 1');
  } else if (dealType === 'wholesale') {
    clauses.push(
      'p.`is_wholesale` = 1 AND p.`wholesale_price_paisa` > 0 AND p.`wholesale_price_paisa` < p.`sale_price_paisa` AND p.`wholesale_min_qty` >= 2'
    );
  }

  const whereSql = clauses.join(' AND ');
  let orderBySql = 'ORDER BY p.`id` DESC';
  if (sort === 'price_asc') orderBySql = 'ORDER BY p.`sale_price_paisa` ASC, p.`id` DESC';
  else if (sort === 'price_desc') orderBySql = 'ORDER BY p.`sale_price_paisa` DESC, p.`id` DESC';
  else if (sort === 'best_selling') orderBySql = 'ORDER BY p.`sold_count` DESC, p.`id` DESC';
  else if (sort === 'name_asc') {
    orderBySql =
      locale === 'en'
        ? "ORDER BY COALESCE(NULLIF(p.`name_en`, ''), p.`name_bn`) ASC, p.`id` DESC"
        : 'ORDER BY p.`name_bn` ASC, p.`id` DESC';
  }

  const countRow = await client.queryOne(
    `SELECT COUNT(*) AS cnt
     FROM \`products\` p
     LEFT JOIN \`categories\` c ON c.\`id\` = p.\`category_id\`
     LEFT JOIN \`subcategories\` sc ON sc.\`id\` = p.\`subcategory_id\`
     LEFT JOIN \`childcategories\` cc ON cc.\`id\` = p.\`childcategory_id\`
     LEFT JOIN \`brands\` b ON b.\`id\` = p.\`brand_id\`
     LEFT JOIN \`vendors\` v ON v.\`id\` = p.\`vendor_id\`
     WHERE ${whereSql}`,
    params
  );
  const total = Number(countRow?.cnt || 0);
  const totalPages = total > 0 ? Math.ceil(total / perPage) : 0;

  const rows = await client.queryAll(
    `${MYSQL_PRODUCT_SELECT}
     WHERE ${whereSql}
     ${orderBySql}
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  const items = await attachVariantsMysql(rows, client, locale);

  return {
    items,
    total,
    page,
    perPage,
    totalPages,
    sort,
  };
}

async function getHomepageData(options = {}, poolOverride = null, config = env) {
  const locale = options.locale || 'bn';
  const siteSettings = options.siteSettings || {};
  const nowMs = options.nowMs || Date.now();

  const flashWindow = parsePromoWindow(
    siteSettings.flash_sale_enabled,
    siteSettings.flash_sale_end,
    nowMs
  );
  const hotWindow = parsePromoWindow(
    siteSettings.hot_deal_enabled,
    siteSettings.hot_deal_end,
    nowMs
  );

  if (!isMysqlMode(config) && !poolOverride) {
    const heroBanners = sqliteDb
      .all("SELECT * FROM banners WHERE position = 'hero' AND status = 1 ORDER BY sort_order ASC, id ASC")
      .map((b) => ({
        id: Number(b.id),
        title: replaceLegacyBrandTokens(b.title || '', locale),
        subtitle: replaceLegacyBrandTokens(b.subtitle || '', locale),
        image: sanitizeImagePath(b.image, '/uploads/banner/banner-1.jpg'),
        link: String(b.link || '/all-products'),
      }));

    const promoBanners = sqliteDb
      .all("SELECT * FROM banners WHERE position = 'promo_mid' AND status = 1 ORDER BY sort_order ASC, id ASC")
      .map((b) => ({
        id: Number(b.id),
        title: replaceLegacyBrandTokens(b.title || '', locale),
        subtitle: replaceLegacyBrandTokens(b.subtitle || '', locale),
        image: sanitizeImagePath(b.image, '/uploads/banner/banner-1.jpg'),
        link: String(b.link || '/all-products'),
      }));

    const flashProducts = flashWindow.active
      ? sqliteDb
          .all(
            `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.is_flash_sale = 1 ORDER BY p.id ASC LIMIT 8`
          )
          .map((r) => normalizeSqliteProduct(r, locale))
      : [];

    const hotProducts = hotWindow.active
      ? sqliteDb
          .all(
            `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.is_hot_deal = 1 ORDER BY p.id DESC LIMIT 8`
          )
          .map((r) => normalizeSqliteProduct(r, locale))
      : [];

    const allProducts = sqliteDb
      .all(`${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} ORDER BY p.id DESC LIMIT 12`)
      .map((r) => normalizeSqliteProduct(r, locale));

    const { categories } = await getCatalogFacets({ locale }, poolOverride, config);
    const featuredCategories = categories.filter((c) => c.front_view);

    const categorySections = featuredCategories
      .map((cat) => {
        const rows = sqliteDb.all(
          `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.category_id = ? ORDER BY p.id DESC LIMIT 4`,
          cat.id
        );
        return {
          category: cat,
          products: rows.map((r) => normalizeSqliteProduct(r, locale)),
        };
      })
      .filter((sec) => sec.products.length > 0);

    const recentBlogs = sqliteDb
      .all('SELECT * FROM blogs WHERE status = 1 ORDER BY id DESC LIMIT 3')
      .map((b) => normalizeBlogRow(b, locale));

    return {
      heroBanners,
      promoBanners,
      featuredCategories,
      flashProducts,
      flashCountdownIso: flashProducts.length > 0 ? flashWindow.countdownIso : null,
      hotProducts,
      hotCountdownIso: hotProducts.length > 0 ? hotWindow.countdownIso : null,
      giftProducts: [],
      categorySections,
      allProducts,
      recentBlogs,
    };
  }

  const client = getClient(poolOverride);
  const [
    rawHeroBanners,
    rawPromoBanners,
    rawFlashRows,
    rawHotRows,
    rawGiftRows,
    rawAllRows,
    facets,
    rawBlogs,
  ] = await Promise.all([
    client.queryAll(
      "SELECT * FROM `banners` WHERE `position` = 'hero' AND `status` = 1 ORDER BY `sort_order` ASC, `id` ASC"
    ),
    client.queryAll(
      "SELECT * FROM `banners` WHERE `position` = 'promo_mid' AND `status` = 1 ORDER BY `sort_order` ASC, `id` ASC"
    ),
    flashWindow.active
      ? client.queryAll(
          `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`is_flash_sale\` = 1 ORDER BY p.\`id\` ASC LIMIT 8`
        )
      : Promise.resolve([]),
    hotWindow.active
      ? client.queryAll(
          `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`is_hot_deal\` = 1 ORDER BY p.\`id\` DESC LIMIT 8`
        )
      : Promise.resolve([]),
    client.queryAll(
      `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`is_gift_eligible\` = 1 ORDER BY p.\`id\` DESC LIMIT 8`
    ),
    client.queryAll(
      `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} ORDER BY p.\`id\` DESC LIMIT 12`
    ),
    getCatalogFacets({ locale }, poolOverride, config),
    client.queryAll('SELECT * FROM `blogs` WHERE `status` = 1 ORDER BY `id` DESC LIMIT 3'),
  ]);

  const [flashProducts, hotProducts, giftProducts, allProducts] = await Promise.all([
    attachVariantsMysql(rawFlashRows, client, locale),
    attachVariantsMysql(rawHotRows, client, locale),
    attachVariantsMysql(rawGiftRows, client, locale),
    attachVariantsMysql(rawAllRows, client, locale),
  ]);

  const featuredCategories = facets.categories.filter((c) => c.front_view);
  const categorySections = [];
  for (const cat of featuredCategories) {
    if (cat.product_count <= 0) continue;
    const catRows = await client.queryAll(
      `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`category_id\` = ? ORDER BY p.\`id\` DESC LIMIT 4`,
      [cat.id]
    );
    const products = await attachVariantsMysql(catRows, client, locale);
    if (products.length > 0) {
      categorySections.push({ category: cat, products });
    }
  }

  return {
    heroBanners: rawHeroBanners.map((b) => ({
      id: Number(b.id),
      title: replaceLegacyBrandTokens(b.title || '', locale),
      subtitle: replaceLegacyBrandTokens(b.subtitle || '', locale),
      image: sanitizeImagePath(b.image_url, '/uploads/banner/banner-1.jpg'),
      link: String(b.link_url || '/all-products'),
    })),
    promoBanners: rawPromoBanners.map((b) => ({
      id: Number(b.id),
      title: replaceLegacyBrandTokens(b.title || '', locale),
      subtitle: replaceLegacyBrandTokens(b.subtitle || '', locale),
      image: sanitizeImagePath(b.image_url, '/uploads/banner/banner-1.jpg'),
      link: String(b.link_url || '/all-products'),
    })),
    featuredCategories,
    flashProducts,
    flashCountdownIso: flashProducts.length > 0 ? flashWindow.countdownIso : null,
    hotProducts,
    hotCountdownIso: hotProducts.length > 0 ? hotWindow.countdownIso : null,
    giftProducts,
    categorySections,
    allProducts,
    recentBlogs: rawBlogs.map((b) => normalizeBlogRow(b, locale)),
  };
}

function summarizeReviews(reviewRows) {
  const count = reviewRows.length;
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  if (count === 0) {
    return { count: 0, averageRating: 0, distribution };
  }
  let sum = 0;
  for (const r of reviewRows) {
    const stars = Math.min(5, Math.max(1, Number(r.rating || 5)));
    sum += stars;
    distribution[stars] = (distribution[stars] || 0) + 1;
  }
  return {
    count,
    averageRating: Number((sum / count).toFixed(1)),
    distribution,
  };
}

async function getStorefrontProductDetail(slugOrId, options = {}, poolOverride = null, config = env) {
  const locale = options.locale || 'bn';
  const lookup = String(slugOrId || '').trim();
  if (!lookup) return null;
  const numericId = /^\d+$/.test(lookup) ? Number(lookup) : null;

  if (!isMysqlMode(config) && !poolOverride) {
    const row = numericId
      ? sqliteDb.get(
          `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND (p.slug = ? OR p.id = ?)`,
          lookup,
          numericId
        )
      : sqliteDb.get(
          `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.slug = ?`,
          lookup
        );
    if (!row) return null;

    const product = normalizeSqliteProduct(row, locale);
    const reviews = sqliteDb.all(
      "SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY id DESC",
      product.id
    );
    const relatedRows = product.category_id
      ? sqliteDb.all(
          `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.category_id = ? AND p.id != ? ORDER BY p.id DESC LIMIT 4`,
          product.category_id,
          product.id
        )
      : [];

    return {
      product,
      reviews,
      reviewStats: summarizeReviews(reviews),
      relatedProducts: relatedRows.map((r) => normalizeSqliteProduct(r, locale)),
    };
  }

  const client = getClient(poolOverride);
  const row = numericId
    ? await client.queryOne(
        `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND (p.\`slug\` = ? OR p.\`id\` = ?) LIMIT 1`,
        [lookup, numericId]
      )
    : await client.queryOne(
        `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`slug\` = ? LIMIT 1`,
        [lookup]
      );
  if (!row) return null;

  const [productsWithVariants, reviews, rawRelated] = await Promise.all([
    attachVariantsMysql([row], client, locale),
    client.queryAll(
      "SELECT * FROM `reviews` WHERE `product_id` = ? AND `status` = 'approved' ORDER BY `id` DESC",
      [row.id]
    ),
    row.category_id
      ? client.queryAll(
          `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`category_id\` = ? AND p.\`id\` != ? ORDER BY p.\`id\` DESC LIMIT 4`,
          [row.category_id, row.id]
        )
      : Promise.resolve([]),
  ]);

  const relatedProducts = await attachVariantsMysql(rawRelated, client, locale);
  return {
    product: productsWithVariants[0],
    reviews,
    reviewStats: summarizeReviews(reviews),
    relatedProducts,
  };
}

async function findProductForCart(productId, options = {}, poolOverride = null, config = env) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const locale = options.locale || 'bn';

  if (!isMysqlMode(config) && !poolOverride) {
    const row = sqliteDb.get(
      `${SQLITE_PRODUCT_SELECT} WHERE ${SQLITE_ACTIVE_PRODUCT_WHERE} AND p.id = ?`,
      id
    );
    return row ? normalizeSqliteProduct(row, locale) : null;
  }

  const client = getClient(poolOverride);
  const row = await client.queryOne(
    `${MYSQL_PRODUCT_SELECT} WHERE ${MYSQL_ACTIVE_PRODUCT_WHERE} AND p.\`id\` = ? LIMIT 1`,
    [id]
  );
  if (!row) return null;
  const [product] = await attachVariantsMysql([row], client, locale);
  return product || null;
}

function normalizeBlogRow(row, locale = 'bn') {
  const excerpt = replaceLegacyBrandTokens(row.excerpt || row.summary || '', locale);
  const content = replaceLegacyBrandTokens(row.content || '', locale);
  return {
    id: Number(row.id),
    title: replaceLegacyBrandTokens(row.title || '', locale),
    slug: String(row.slug || ''),
    category: replaceLegacyBrandTokens(row.category || '', locale),
    image: sanitizeImagePath(row.image_url || row.image, '/uploads/banner/banner-1.jpg'),
    summary: excerpt || content.slice(0, 180),
    excerpt: excerpt || content.slice(0, 180),
    content,
    author: replaceLegacyBrandTokens(row.author || 'Mr. Tumi Editorial', locale),
    created_at: row.created_at,
  };
}

async function listBlogs(options = {}, poolOverride = null, config = env) {
  const locale = options.locale || 'bn';
  const category = String(options.category || '').trim();
  const { page, perPage, offset } = sanitizePagination(options.page, options.perPage || 8);

  if (!isMysqlMode(config) && !poolOverride) {
    const whereSql = category ? 'status = 1 AND category = ?' : 'status = 1';
    const params = category ? [category] : [];
    const total = Number(
      sqliteDb.get(`SELECT COUNT(*) AS cnt FROM blogs WHERE ${whereSql}`, ...params)?.cnt || 0
    );
    const rows = sqliteDb.all(
      `SELECT * FROM blogs WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      offset
    );
    return {
      items: rows.map((r) => normalizeBlogRow(r, locale)),
      total,
      page,
      perPage,
      totalPages: total > 0 ? Math.ceil(total / perPage) : 0,
    };
  }

  const client = getClient(poolOverride);
  const whereSql = category ? '`status` = 1 AND `category` = ?' : '`status` = 1';
  const params = category ? [category] : [];
  const countRow = await client.queryOne(
    `SELECT COUNT(*) AS cnt FROM \`blogs\` WHERE ${whereSql}`,
    params
  );
  const total = Number(countRow?.cnt || 0);
  const rows = await client.queryAll(
    `SELECT * FROM \`blogs\` WHERE ${whereSql} ORDER BY \`id\` DESC LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  return {
    items: rows.map((r) => normalizeBlogRow(r, locale)),
    total,
    page,
    perPage,
    totalPages: total > 0 ? Math.ceil(total / perPage) : 0,
  };
}

async function getBlogBySlug(slug, options = {}, poolOverride = null, config = env) {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug) return null;
  const locale = options.locale || 'bn';

  if (!isMysqlMode(config) && !poolOverride) {
    const row = sqliteDb.get('SELECT * FROM blogs WHERE slug = ? AND status = 1', cleanSlug);
    if (!row) return null;
    const related = sqliteDb
      .all('SELECT * FROM blogs WHERE status = 1 AND id != ? ORDER BY id DESC LIMIT 3', row.id)
      .map((r) => normalizeBlogRow(r, locale));
    return { blog: normalizeBlogRow(row, locale), relatedBlogs: related };
  }

  const client = getClient(poolOverride);
  const row = await client.queryOne(
    'SELECT * FROM `blogs` WHERE `slug` = ? AND `status` = 1 LIMIT 1',
    [cleanSlug]
  );
  if (!row) return null;
  const rawRelated = await client.queryAll(
    'SELECT * FROM `blogs` WHERE `status` = 1 AND `id` != ? ORDER BY `id` DESC LIMIT 3',
    [row.id]
  );
  return {
    blog: normalizeBlogRow(row, locale),
    relatedBlogs: rawRelated.map((r) => normalizeBlogRow(r, locale)),
  };
}

async function getCmsPageBySlug(slug, options = {}, poolOverride = null, config = env) {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug) return null;
  const locale = options.locale || 'bn';

  if (!isMysqlMode(config) && !poolOverride) {
    const row = sqliteDb.get('SELECT * FROM cms_pages WHERE slug = ? AND status = 1', cleanSlug);
    if (!row) return null;
    return {
      id: Number(row.id),
      slug: String(row.slug),
      title: replaceLegacyBrandTokens(row.title || '', locale),
      content: replaceLegacyBrandTokens(row.content || '', locale),
      hasExplicitEnglishCopy: false,
      created_at: row.created_at,
    };
  }

  const client = getClient(poolOverride);
  const row = await client.queryOne(
    'SELECT * FROM `cms_pages` WHERE `slug` = ? AND `status` = 1 LIMIT 1',
    [cleanSlug]
  );
  if (!row) return null;
  const hasExplicitEnglishCopy = Boolean(String(row.content_en || '').trim());
  return {
    id: Number(row.id),
    slug: String(row.slug),
    title: pickLocalizedText(locale, row.title_bn, row.title_en, row.slug),
    content: pickLocalizedText(locale, row.content_bn, row.content_en, ''),
    hasExplicitEnglishCopy,
    created_at: row.created_at,
  };
}

async function submitProductReview(payload = {}, poolOverride = null, config = env) {
  const productId = Number(payload.productId);
  const customerId = payload.customerId ? Number(payload.customerId) : null;
  const customerName = String(payload.customerName || '').trim().slice(0, 120);
  const comment = String(payload.comment || '').trim().slice(0, 1500);
  const rating = Math.min(5, Math.max(1, Math.round(Number(payload.rating || 5))));

  if (!Number.isInteger(productId) || productId <= 0 || !customerName || !comment) {
    return { ok: false, reason: 'VALIDATION_ERROR' };
  }

  const product = await findProductForCart(productId, {}, poolOverride, config);
  if (!product) {
    return { ok: false, reason: 'PRODUCT_NOT_FOUND' };
  }

  if (!isMysqlMode(config) && !poolOverride) {
    const res = sqliteDb.run(
      "INSERT INTO reviews (product_id, customer_name, rating, comment, status) VALUES (?, ?, ?, ?, 'pending')",
      productId,
      customerName,
      rating,
      comment
    );
    return { ok: true, id: Number(res.lastInsertRowid), status: 'pending' };
  }

  const client = getClient(poolOverride);
  const res = await client.execute(
    "INSERT INTO `reviews` (`product_id`, `customer_id`, `customer_name`, `rating`, `comment`, `status`) VALUES (?, ?, ?, ?, ?, 'pending')",
    [productId, customerId, customerName, rating, comment]
  );
  return { ok: true, id: Number(res.insertId), status: 'pending' };
}

async function submitContactMessage(payload = {}, poolOverride = null, config = env) {
  const name = String(payload.name || '').trim().slice(0, 150);
  const phone = String(payload.phone || '').trim().slice(0, 32);
  const email = String(payload.email || '').trim().slice(0, 190);
  const subject = String(payload.subject || '').trim().slice(0, 200);
  const message = String(payload.message || '').trim().slice(0, 2500);

  if (!name || !message) {
    return { ok: false, reason: 'VALIDATION_ERROR' };
  }

  if (!isMysqlMode(config) && !poolOverride) {
    const res = sqliteDb.run(
      'INSERT INTO contact_messages (name, phone, email, subject, message) VALUES (?, ?, ?, ?, ?)',
      name,
      phone,
      email,
      subject,
      message
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  }

  const client = getClient(poolOverride);
  const res = await client.execute(
    'INSERT INTO `contact_messages` (`name`, `phone`, `email`, `subject`, `message`, `status`) VALUES (?, ?, ?, ?, ?, ?)',
    [name, phone, email, subject, message, 'unread']
  );
  return { ok: true, id: Number(res.insertId) };
}

async function submitComplaint(payload = {}, poolOverride = null, config = env) {
  const name = String(payload.name || '').trim().slice(0, 150);
  const phone = String(payload.phone || '').trim().slice(0, 32);
  const invoiceNo = String(payload.invoiceNo || payload.invoice_id || '').trim().slice(0, 40);
  const details = String(payload.details || '').trim().slice(0, 2500);

  if (!name || !phone || !details) {
    return { ok: false, reason: 'VALIDATION_ERROR' };
  }

  if (!isMysqlMode(config) && !poolOverride) {
    const res = sqliteDb.run(
      'INSERT INTO complaints (name, phone, invoice_id, details) VALUES (?, ?, ?, ?)',
      name,
      phone,
      invoiceNo,
      details
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  }

  const client = getClient(poolOverride);
  const res = await client.execute(
    'INSERT INTO `complaints` (`name`, `phone`, `invoice_no`, `details`, `status`) VALUES (?, ?, ?, ?, ?)',
    [name, phone, invoiceNo, details, 'pending']
  );
  return { ok: true, id: Number(res.insertId) };
}

async function subscribeNewsletter(emailOrPhoneInput, poolOverride = null, config = env) {
  const value = String(emailOrPhoneInput || '').trim().slice(0, 190);
  if (!value) return { ok: false, reason: 'VALIDATION_ERROR' };

  if (!isMysqlMode(config) && !poolOverride) {
    sqliteDb.run(
      'INSERT OR IGNORE INTO newsletter_subscribers (email_or_phone, status) VALUES (?, 1)',
      value
    );
    return { ok: true };
  }

  const client = getClient(poolOverride);
  await client.execute(
    'INSERT INTO `newsletter_subscribers` (`email_or_phone`, `status`) VALUES (?, 1) ON DUPLICATE KEY UPDATE `status` = 1',
    [value]
  );
  return { ok: true };
}

async function getSitemapEntries(poolOverride = null, config = env) {
  if (!isMysqlMode(config) && !poolOverride) {
    const categories = sqliteDb.all('SELECT slug FROM categories WHERE status = 1 ORDER BY id ASC');
    const subcategories = sqliteDb.all('SELECT slug FROM subcategories WHERE status = 1 ORDER BY id ASC');
    const products = sqliteDb.all(
      "SELECT slug FROM products WHERE status = 1 AND COALESCE(approval_status, 'approved') = 'approved' ORDER BY id DESC"
    );
    const blogs = sqliteDb.all('SELECT slug FROM blogs WHERE status = 1 ORDER BY id DESC');
    const pages = sqliteDb.all('SELECT slug FROM cms_pages WHERE status = 1 ORDER BY id ASC');
    return { categories, subcategories, childcategories: [], brands: [], products, blogs, pages };
  }

  const client = getClient(poolOverride);
  const [categories, subcategories, childcategories, brands, products, blogs, pages] =
    await Promise.all([
      client.queryAll('SELECT `slug` FROM `categories` WHERE `status` = 1 ORDER BY `id` ASC'),
      client.queryAll('SELECT `slug` FROM `subcategories` WHERE `status` = 1 ORDER BY `id` ASC'),
      client.queryAll('SELECT `slug` FROM `childcategories` WHERE `status` = 1 ORDER BY `id` ASC'),
      client.queryAll('SELECT `slug` FROM `brands` WHERE `status` = 1 ORDER BY `id` ASC'),
      client.queryAll(
        "SELECT `slug` FROM `products` WHERE `status` = 1 AND `is_archived` = 0 AND `approval_status` = 'approved' ORDER BY `id` DESC"
      ),
      client.queryAll('SELECT `slug` FROM `blogs` WHERE `status` = 1 ORDER BY `id` DESC'),
      client.queryAll('SELECT `slug` FROM `cms_pages` WHERE `status` = 1 ORDER BY `id` ASC'),
    ]);
  return { categories, subcategories, childcategories, brands, products, blogs, pages };
}

module.exports = {
  isMysqlMode,
  parsePromoWindow,
  parseGalleryImages,
  getCatalogFacets,
  listStorefrontProducts,
  getHomepageData,
  getStorefrontProductDetail,
  findProductForCart,
  listBlogs,
  getBlogBySlug,
  getCmsPageBySlug,
  submitProductReview,
  submitContactMessage,
  submitComplaint,
  subscribeNewsletter,
  getSitemapEntries,
};
