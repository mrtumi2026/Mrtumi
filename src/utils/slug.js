'use strict';

const SAFE_SLUG = /^[a-z0-9-]+$/;

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 170)
    .replace(/-+$/g, '');
}

function safeIdentifier(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/** Always returns an ASCII-only, URL-segment-safe product slug. */
function generateSafeProductSlug(nameBn, nameEn, sku, id) {
  const generated = slugify(nameBn);
  if (generated && SAFE_SLUG.test(generated)) return generated;

  const fallbackName = slugify(nameEn || 'product') || 'product';
  const fallbackId = safeIdentifier(sku) || safeIdentifier(id) || String(Date.now());
  const fallback = `${fallbackName}-${fallbackId}`.slice(0, 191).replace(/-+$/g, '');
  if (SAFE_SLUG.test(fallback)) return fallback;

  return `product-${Date.now()}`;
}

module.exports = { generateSafeProductSlug, SAFE_SLUG, slugify };
