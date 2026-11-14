'use strict';

const RESERVED_SLUGS = Object.freeze(new Set([
  'admin', 'vendor', 'reseller', 'customer', 'api', 'cart', 'checkout',
  'terms', 'privacy-policy', 'all-products', 'search', 'login', 'register',
  'logout', 'store', 'stores', 'shop', 'shops', 'category', 'subcategory',
  'childcategory', 'brand', 'product', 'locale', 'auth', 'uploads', 'assets',
  'static', 'default', 'public', 'home', 'order', 'orders', 'track-order',
  'order-success', 'campaign', 'flash-sales', 'hot-deals', 'faq', 'about', 'contact', 'affiliate'
]));

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Clean and format a string into a URL-friendly slug.
 * @param {string} val
 * @returns {string}
 */
function slugifyText(val) {
  return String(val ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}

/**
 * Validates a proposed vendor store slug.
 * @param {string} slug
 * @returns {{ valid: boolean, error?: string, slug: string }}
 */
function validateVendorSlug(slug) {
  const raw = String(slug ?? '').trim();
  if (!raw) {
    return { valid: false, error: 'Store URL slug is required.', slug: '' };
  }
  if (raw !== raw.toLowerCase()) {
    return { valid: false, error: 'Store slug must be strictly lowercase (e.g. "my-fresh-store").', slug: raw.toLowerCase() };
  }
  const clean = raw;
  if (clean.length < 3) {
    return { valid: false, error: 'Store slug must be at least 3 characters long.', slug: clean };
  }
  if (clean.length > 100) {
    return { valid: false, error: 'Store slug cannot exceed 100 characters.', slug: clean };
  }
  if (!SLUG_REGEX.test(clean)) {
    return { valid: false, error: 'Store slug may only contain lowercase letters, numbers, and hyphens (e.g., "my-fresh-store").', slug: clean };
  }
  if (RESERVED_SLUGS.has(clean)) {
    return { valid: false, error: `"${clean}" একটি সংরক্ষিত সিস্টেম পাথ এবং এটি স্টোর স্লাগ হিসেবে ব্যবহার করা যাবে না।`, slug: clean };
  }
  return { valid: true, slug: clean };
}

/**
 * Generates a guaranteed valid and safe fallback vendor slug.
 * @param {string} shopName
 * @param {number|string} vendorId
 * @returns {string}
 */
function generateSafeVendorSlug(shopName, vendorId) {
  const candidate = slugifyText(shopName);
  if (candidate && candidate.length >= 3 && !RESERVED_SLUGS.has(candidate) && SLUG_REGEX.test(candidate)) {
    return candidate;
  }
  const idStr = String(vendorId || '1');
  return `store-${idStr}`;
}

module.exports = {
  RESERVED_SLUGS,
  SLUG_REGEX,
  slugifyText,
  validateVendorSlug,
  generateSafeVendorSlug,
  isReservedRoute: (slug) => RESERVED_SLUGS.has(String(slug || '').toLowerCase().trim()),
};
