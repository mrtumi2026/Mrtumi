'use strict';

/**
 * PHASE 04: Brand Identity & Temporary Placeholder Asset Resolver
 *
 * Ensures zero reference-website identity ("ফল বাজার" / "pholbazar") leaks into
 * Customer Storefront, Admin, Vendor, or Reseller UI, without destructively
 * modifying untouched local SQLite prototype files (`data/pholbazar.db*`).
 *
 * Explicitly flags placeholder logos until official owner logo files are supplied.
 */

const PLACEHOLDER_LOGO_DARK = '/uploads/brand/mrtumi-placeholder-logo.svg';
const PLACEHOLDER_LOGO_LIGHT = '/uploads/brand/mrtumi-placeholder-logo-light.svg';
const PLACEHOLDER_FAVICON = '/uploads/brand/mrtumi-placeholder-favicon.svg';

const LEGACY_REFERENCE_NAMES = new Set([
  'ফল বাজার',
  'ফল বাজার অর্গানিক',
  'Phol Bazar',
  'pholbazar',
]);

const LEGACY_LOGO_PATHS = new Set([
  '',
  '/uploads/settings/logo.svg',
  '/uploads/settings/logo-light.svg',
  PLACEHOLDER_LOGO_DARK,
  PLACEHOLDER_LOGO_LIGHT,
]);

const BRAND_COPY = {
  bn: {
    siteName: 'মি. তুমি গ্রোসারি অ্যান্ড গিফট',
    legalName: 'Mr. Tumi Grocery & Gift',
    tagline: 'নিত্যপ্রয়োজনীয় গ্রোসারি ও প্রিয়জনের উপহার — বিশ্বস্ত ডেলিভারিতে ঘরে বসেই',
    marquee: '🛒 মি. তুমি গ্রোসারি অ্যান্ড গিফট-এ স্বাগতম! তাজা গ্রোসারি, উপহার সামগ্রী ও কম্বো প্যাকে দ্রুত হোম ডেলিভারি সারা বাংলাদেশে।',
    address: 'ঢাকা, বাংলাদেশ',
    defaultProductBrand: 'মি. তুমি সিলেক্ট',
    placeholderBadge: 'অস্থায়ী লোগো প্লেসহোল্ডার',
    placeholderNotice: 'অফিসিয়াল লোগো ফাইল সংযুক্ত না হওয়া পর্যন্ত অস্থায়ী ব্র্যান্ড প্লেসহোল্ডার ব্যবহৃত হচ্ছে।',
  },
  en: {
    siteName: 'Mr. Tumi Grocery & Gift',
    legalName: 'Mr. Tumi Grocery & Gift',
    tagline: 'Everyday groceries & thoughtful gifts delivered reliably across Bangladesh',
    marquee: '🛒 Welcome to Mr. Tumi Grocery & Gift! Fresh groceries, curated gift hampers & combo packs delivered across Bangladesh.',
    address: 'Dhaka, Bangladesh',
    defaultProductBrand: 'Mr. Tumi Select',
    placeholderBadge: 'Temporary Logo Placeholder',
    placeholderNotice: 'Temporary brand placeholder active until official owner logo files are uploaded.',
  },
};

const POLICY_SLUGS_REQUIRING_OWNER_REVIEW = new Set([
  'about-us',
  'return-policy',
  'privacy-policy',
  'terms-conditions',
]);

/**
 * Check if a string contains legacy reference-site branding (`ফল বাজার` / `pholbazar`).
 * @param {string} val
 * @returns {boolean}
 */
function hasLegacyReferenceBrand(val) {
  if (!val || typeof val !== 'string') return false;
  return /ফল\s*বাজার|phol\s*bazar|pholbazar/i.test(val);
}

/**
 * Resolve normalized `siteSettings` and `brand` metadata for the active locale.
 * Preserves genuine custom admin edits while replacing legacy reference defaults.
 *
 * @param {Record<string, any>} [rawSettings={}]
 * @param {'bn'|'en'} [locale='bn']
 */
function resolveBrandContext(rawSettings = {}, locale = 'bn') {
  const lang = locale === 'en' ? 'en' : 'bn';
  const defaults = BRAND_COPY[lang];
  const settings = { ...rawSettings };

  const rawName = String(settings.site_name || '').trim();
  if (!rawName || LEGACY_REFERENCE_NAMES.has(rawName) || hasLegacyReferenceBrand(rawName)) {
    settings.site_name = defaults.siteName;
  }

  const rawTagline = String(settings.site_tagline || '').trim();
  if (!rawTagline || hasLegacyReferenceBrand(rawTagline) || rawTagline === 'খাঁটি মানের খাবারের নিশ্চয়তা') {
    settings.site_tagline = defaults.tagline;
  }

  const rawMarquee = String(settings.marquee_text || '').trim();
  if (!rawMarquee || hasLegacyReferenceBrand(rawMarquee) || rawMarquee.includes('দিনাজপুরের বাগান')) {
    settings.marquee_text = defaults.marquee;
  }

  const rawSpecialNotice = String(settings.special_notice || '').trim();
  if (
    !rawSpecialNotice ||
    hasLegacyReferenceBrand(rawSpecialNotice) ||
    rawSpecialNotice.includes('দিনাজপুর ও রাজশাহীর বাগান')
  ) {
    settings.special_notice = defaults.marquee;
  }

  const rawSeoTitle = String(settings.seo_meta_title || '').trim();
  if (!rawSeoTitle || hasLegacyReferenceBrand(rawSeoTitle)) {
    settings.seo_meta_title = `${defaults.siteName} — ${defaults.tagline}`;
  }

  const rawEmail = String(settings.site_email || '').trim();
  if (!rawEmail || /pholbazar/i.test(rawEmail)) {
    settings.site_email = 'support@mrtumi.com';
  }

  const rawAddress = String(settings.site_address || '').trim();
  if (!rawAddress) {
    settings.site_address = defaults.address;
  } else if (lang === 'en' && rawAddress === 'বনানী, ঢাকা-১২১৩, বাংলাদেশ') {
    settings.site_address = 'Banani, Dhaka-1213, Bangladesh';
  }

  const rawLogoDark = String(settings.logo_dark || '').trim();
  const rawLogoLight = String(settings.logo_light || '').trim();

  const isPlaceholderDark = !rawLogoDark || LEGACY_LOGO_PATHS.has(rawLogoDark);
  const isPlaceholderLight = !rawLogoLight || LEGACY_LOGO_PATHS.has(rawLogoLight);

  if (isPlaceholderDark) {
    settings.logo_dark = PLACEHOLDER_LOGO_DARK;
  }
  if (isPlaceholderLight) {
    settings.logo_light = PLACEHOLDER_LOGO_LIGHT;
  }

  settings.favicon = settings.favicon || PLACEHOLDER_FAVICON;

  const isPlaceholderLogo = isPlaceholderDark || isPlaceholderLight;

  return {
    siteSettings: settings,
    brand: {
      name: settings.site_name,
      legalName: defaults.legalName,
      nameBn: BRAND_COPY.bn.siteName,
      nameEn: BRAND_COPY.en.siteName,
      tagline: settings.site_tagline,
      defaultProductBrand: defaults.defaultProductBrand,
      logoDark: settings.logo_dark,
      logoLight: settings.logo_light,
      favicon: settings.favicon,
      isPlaceholderLogo,
      placeholderBadge: defaults.placeholderBadge,
      placeholderNotice: defaults.placeholderNotice,
    },
  };
}

/**
 * Determine if a CMS/policy page requires an explicit owner legal-copy review notice.
 * @param {string} slug
 * @param {string} [content]
 * @returns {boolean}
 */
function requiresOwnerCopyReview(slug, content = '') {
  if (POLICY_SLUGS_REQUIRING_OWNER_REVIEW.has(String(slug || '').trim().toLowerCase())) {
    return true;
  }
  return hasLegacyReferenceBrand(content);
}

/**
 * Sanitize legacy reference brand names in unreviewed CMS text without inventing legal terms.
 * @param {string} text
 * @param {'bn'|'en'} [locale='bn']
 * @returns {string}
 */
function replaceLegacyBrandTokens(text, locale = 'bn') {
  if (!text || typeof text !== 'string') return '';
  const replacement = locale === 'en' ? BRAND_COPY.en.siteName : BRAND_COPY.bn.siteName;
  return text
    .replace(/ফল\s*বাজার\s*অর্গানিক/g, BRAND_COPY[locale === 'en' ? 'en' : 'bn'].defaultProductBrand)
    .replace(/ফল\s*বাজার/g, replacement)
    .replace(/Phol\s*Bazar/gi, BRAND_COPY.en.siteName)
    .replace(/support@pholbazar\.com/gi, 'support@mrtumi.com');
}

module.exports = {
  PLACEHOLDER_LOGO_DARK,
  PLACEHOLDER_LOGO_LIGHT,
  PLACEHOLDER_FAVICON,
  BRAND_COPY,
  POLICY_SLUGS_REQUIRING_OWNER_REVIEW,
  hasLegacyReferenceBrand,
  resolveBrandContext,
  requiresOwnerCopyReview,
  replaceLegacyBrandTokens,
};
