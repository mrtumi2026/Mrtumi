'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { requireCsrf } = require('../middleware/csrf');
const checkoutRepo = require('../repositories/checkoutRepository');
const phase08Repo = require('../repositories/phase08Repository');
const { asyncHandler } = require('../utils/asyncHandler');
const { createRateLimiter } = require('../middleware/rateLimit');
const storefrontRepo = require('../repositories/storefrontRepository');
const customerRepo = require('../repositories/customerRepository');
const { env } = require('../config/env');
const { captureAttribution, consentGranted } = require('../analytics/attribution');

const router = express.Router();

const publicFormLimiter = createRateLimiter({
  keyPrefix: 'store_public_form',
  windowMs: 60_000,
  max: 20,
});

router.use((req, res, next) => {
  const enabled = env.analyticsAttributionEnabled === true;
  res.locals.analyticsAttributionEnabled = enabled;
  res.locals.analyticsConsent = consentGranted(req.session, enabled);
  res.locals.analyticsConsentChoice = String(req.session.analyticsConsentChoice || '');
  captureAttribution(req.session, req.query, enabled);
  next();
});

function safeLocalReturnPath(value) {
  const path = String(value || '/').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return '/';
  try {
    const target = new URL(path, 'https://local.invalid');
    if (target.origin !== 'https://local.invalid') return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

router.post('/analytics/consent', publicFormLimiter, requireCsrf, (req, res) => {
  if (env.analyticsAttributionEnabled !== true) return res.sendStatus(404);
  const choice = String(req.body.choice || '');
  if (!['accept', 'reject', 'withdraw'].includes(choice)) return res.status(400).send('Choose an available analytics preference.');
  const granted = choice === 'accept';
  req.session.analyticsConsent = granted;
  req.session.analyticsConsentChoice = granted ? 'accepted' : choice === 'withdraw' ? 'withdrawn' : 'rejected';
  if (!granted) delete req.session.analyticsAttribution;
  return res.redirect(303, safeLocalReturnPath(req.body.return_to));
});

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(req.get('host') || 'localhost:3000').trim();
  return `${proto}://${host}`;
}

function buildPaginationBaseUrl(pathname, queryObj = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(queryObj)) {
    if (k === 'page' || k === '_sid' || v === undefined || v === null || String(v).trim() === '') {
      continue;
    }
    params.set(k, String(v).trim());
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function renderStoreNotFound(req, res) {
  const isEn = req.locale === 'en';
  return res.status(404).render('store/page', {
    mode: 'cms',
    blogs: [],
    relatedBlogs: [],
    page: {
      slug: '404',
      title: isEn ? '404 — Page or Product Not Found' : '৪০৪ — পেজ বা পণ্যটি খুঁজে পাওয়া যায়নি',
      content: isEn
        ? 'Sorry, the product or page you requested is unavailable or has moved. Browse our verified grocery and gift catalog below.'
        : 'দুঃখিত, আপনি যে পণ্য বা পেজটি খুঁজছেন তা বর্তমানে উপলব্ধ নেই। আমাদের যাচাইকৃত গ্রোসারি ও গিফট তালিকা থেকে পছন্দের পণ্য দেখুন।',
    },
    pageMeta: {
      title: isEn ? '404 Not Found' : '৪০৪ খুঁজে পাওয়া যায়নি',
      robots: 'noindex,follow',
    },
  });
}

// ─── Legacy Prototype Helpers (Scheduled for MySQL Conversion in Phases 07 & 08) ───
function generateInvoiceId() {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const exists = db.get('SELECT id FROM orders WHERE invoice_id = ?', code);
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6);
}

function detectTrafficSource(req) {
  const ref = String(req.get('Referrer') || req.query.utm_source || '').toLowerCase();
  if (ref.includes('facebook') || ref.includes('fb')) return 'Facebook';
  if (ref.includes('google')) return 'Google';
  if (ref.includes('tiktok')) return 'TikTok';
  if (ref && !ref.includes(req.get('host') || '')) return 'Other';
  return 'Direct';
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  const ctype = String(req.headers['content-type'] || '');
  return (
    req.xhr ||
    req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    accept.includes('application/json') ||
    ctype.includes('application/json')
  );
}

async function refreshCustomerCart(req) {
  if (storefrontRepo.isMysqlMode() && req.customerUser?.id) {
    req.session.cart = await customerRepo.listCart(req.customerUser.id, req.locale);
  }
}
async function persistCustomerCart(req) {
  if (storefrontRepo.isMysqlMode() && req.customerUser?.id) {
    await customerRepo.replaceCart(req.customerUser.id, req.session.cart || []);
  }
}
function computeCartTotals(req) {
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  const cart = req.session.cart;
  const cartCount = cart.reduce((s, i) => s + (Number(i.qty) || 1), 0);
  const cartSubtotal = cart.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);

  // Recalculate coupon discount if applied (full MySQL coupon engine scheduled for Phase 07)
  let discount = 0;
  if (req.session.appliedCoupon && req.session.appliedCoupon.code && !storefrontRepo.isMysqlMode()) {
    const cpn = db.get(
      'SELECT * FROM coupons WHERE UPPER(code) = ? AND status = 1',
      String(req.session.appliedCoupon.code).toUpperCase()
    );
    if (cpn && cartSubtotal >= Number(cpn.min_purchase || 0)) {
      discount =
        cpn.type === 'percent'
          ? Math.round((cartSubtotal * Number(cpn.value)) / 100)
          : Number(cpn.value);
      req.session.appliedCoupon.discount = discount;
    } else if (cartSubtotal === 0) {
      delete req.session.appliedCoupon;
    }
  }

  return {
    cart,
    cartCount,
    cartSubtotal,
    discount,
    appliedCoupon: req.session.appliedCoupon || null,
  };
}

function resolveEffectiveUnitPrice(prod, matchedVariant, qty) {
  if (
    prod.has_valid_wholesale &&
    prod.wholesale_price > 0 &&
    prod.wholesale_min_qty >= 2 &&
    qty >= prod.wholesale_min_qty
  ) {
    return Number(prod.wholesale_price);
  }
  if (matchedVariant && matchedVariant.price > 0) {
    return Number(matchedVariant.price);
  }
  return Number(prod.new_price);
}

// ============================================================================
// PHASE 05 — MYSQL-FIRST STOREFRONT CATALOGUE, DETAIL, CONTENT & SEO ROUTES
// ============================================================================

// ─── Storefront Homepage ───
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const homeData = await storefrontRepo.getHomepageData({
      locale: req.locale,
      siteSettings: res.locals.siteSettings,
    });

    res.render('store/home', {
      ...homeData,
      pageMeta: {
        canonicalUrl: `${baseUrl}/`,
        ogType: 'website',
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: res.locals.siteSettings.site_name,
          url: `${baseUrl}/`,
          potentialAction: {
            '@type': 'SearchAction',
            target: `${baseUrl}/all-products?q={search_term_string}`,
            'query-input': 'required name=search_term_string',
          },
        },
      },
    });
  })
);

// ─── Shared Catalogue Listing Renderer ───
async function renderCatalogueListing(req, res, preset = {}) {
  const t = res.locals.t;
  const baseUrl = buildBaseUrl(req);

  const queryFilters = {
    locale: req.locale,
    q: preset.q !== undefined ? preset.q : String(req.query.q || '').trim(),
    categorySlug: preset.categorySlug || String(req.query.category || '').trim(),
    subcategorySlug: preset.subcategorySlug || String(req.query.subcategory || '').trim(),
    childcategorySlug: preset.childcategorySlug || String(req.query.childcategory || '').trim(),
    brandSlug: preset.brandSlug || String(req.query.brand || '').trim(),
    dealType: preset.dealType || String(req.query.deal || '').trim(),
    minPrice: req.query.min_price,
    maxPrice: req.query.max_price,
    inStockOnly: req.query.in_stock,
    sort: req.query.sort || 'newest',
    page: req.query.page || 1,
    perPage: req.query.per_page || 12,
  };

  const [listing, facets] = await Promise.all([
    storefrontRepo.listStorefrontProducts(queryFilters),
    storefrontRepo.getCatalogFacets({ locale: req.locale }),
  ]);

  const activeCategory = queryFilters.categorySlug
    ? facets.categories.find((c) => c.slug === queryFilters.categorySlug) || null
    : null;

  let activeSubcategory = null;
  let activeChildcategory = null;
  for (const c of facets.categories) {
    for (const sc of c.subcategories || []) {
      if (queryFilters.subcategorySlug && sc.slug === queryFilters.subcategorySlug) {
        activeSubcategory = { ...sc, parentCategory: c };
      }
      for (const cc of sc.childcategories || []) {
        if (queryFilters.childcategorySlug && cc.slug === queryFilters.childcategorySlug) {
          activeChildcategory = { ...cc, parentSubcategory: sc, parentCategory: c };
        }
      }
    }
  }

  const activeBrand = queryFilters.brandSlug
    ? facets.brands.find((b) => b.slug === queryFilters.brandSlug) || null
    : null;

  if (preset.requireEntityMatch) {
    if (preset.categorySlug && !activeCategory) return renderStoreNotFound(req, res);
    if (preset.subcategorySlug && !activeSubcategory) return renderStoreNotFound(req, res);
    if (preset.childcategorySlug && !activeChildcategory) return renderStoreNotFound(req, res);
    if (preset.brandSlug && !activeBrand) return renderStoreNotFound(req, res);
  }

  let pageTitle = preset.pageTitle || t('common.allProducts');
  let subtitle = preset.subtitle || t('store.catalogDefaultSub');

  if (activeChildcategory) {
    pageTitle = activeChildcategory.name;
    subtitle = t('store.categoryBrowseSub', { name: activeChildcategory.name });
  } else if (activeSubcategory) {
    pageTitle = activeSubcategory.name;
    subtitle = t('store.categoryBrowseSub', { name: activeSubcategory.name });
  } else if (activeCategory) {
    pageTitle = activeCategory.name;
    subtitle = t('store.categoryBrowseSub', { name: activeCategory.name });
  } else if (activeBrand) {
    pageTitle = activeBrand.name;
    subtitle = t('store.categoryBrowseSub', { name: activeBrand.name });
  } else if (queryFilters.q) {
    pageTitle = t('store.searchResultsTitle', { query: queryFilters.q });
  }

  const actionPath = preset.actionPath || req.path;
  const paginationBaseUrl = buildPaginationBaseUrl(actionPath, req.query);

  return res.render('store/catalog', {
    pageTitle,
    subtitle,
    products: listing.items,
    totalProducts: listing.total,
    page: listing.page,
    perPage: listing.perPage,
    totalPages: listing.totalPages,
    paginationBaseUrl,
    actionPath,
    searchQuery: queryFilters.q,
    sort: listing.sort,
    facets,
    activeCategory,
    activeSubcategory,
    activeChildcategory,
    activeBrand,
    promoCountdownIso: preset.promoCountdownIso || null,
    filterState: {
      q: queryFilters.q,
      category: queryFilters.categorySlug,
      subcategory: queryFilters.subcategorySlug,
      childcategory: queryFilters.childcategorySlug,
      brand: queryFilters.brandSlug,
      deal: queryFilters.dealType,
      min_price: req.query.min_price ? String(req.query.min_price).trim() : '',
      max_price: req.query.max_price ? String(req.query.max_price).trim() : '',
      in_stock:
        req.query.in_stock === '1' || req.query.in_stock === 'true' ? '1' : '',
      sort: listing.sort,
    },
    pageMeta: {
      title: pageTitle,
      description: subtitle,
      canonicalUrl: `${baseUrl}${actionPath}`,
      ogType: 'website',
    },
  });
}

router.get(
  ['/all-products', '/search'],
  asyncHandler(async (req, res) => renderCatalogueListing(req, res, { actionPath: '/all-products' }))
);

router.get(
  '/flash-sales',
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    const flashWin = storefrontRepo.parsePromoWindow(
      res.locals.siteSettings.flash_sale_enabled,
      res.locals.siteSettings.flash_sale_end
    );
    return renderCatalogueListing(req, res, {
      dealType: 'flash',
      actionPath: '/flash-sales',
      pageTitle: `⚡ ${t('store.flashSaleTitle')}`,
      subtitle: t('store.flashSaleSub'),
      promoCountdownIso: flashWin.active ? flashWin.countdownIso : null,
    });
  })
);

router.get(
  '/hot-deals',
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    const hotWin = storefrontRepo.parsePromoWindow(
      res.locals.siteSettings.hot_deal_enabled,
      res.locals.siteSettings.hot_deal_end
    );
    return renderCatalogueListing(req, res, {
      dealType: 'hot',
      actionPath: '/hot-deals',
      pageTitle: `🔥 ${t('store.hotDealTitle')}`,
      subtitle: t('store.hotDealBadge'),
      promoCountdownIso: hotWin.active ? hotWin.countdownIso : null,
    });
  })
);

router.get(
  '/category/:slug',
  asyncHandler(async (req, res) =>
    renderCatalogueListing(req, res, {
      categorySlug: req.params.slug,
      actionPath: `/category/${encodeURIComponent(req.params.slug)}`,
      requireEntityMatch: true,
    })
  )
);

router.get(
  '/subcategory/:slug',
  asyncHandler(async (req, res) =>
    renderCatalogueListing(req, res, {
      subcategorySlug: req.params.slug,
      actionPath: `/subcategory/${encodeURIComponent(req.params.slug)}`,
      requireEntityMatch: true,
    })
  )
);

router.get(
  '/childcategory/:slug',
  asyncHandler(async (req, res) =>
    renderCatalogueListing(req, res, {
      childcategorySlug: req.params.slug,
      actionPath: `/childcategory/${encodeURIComponent(req.params.slug)}`,
      requireEntityMatch: true,
    })
  )
);

router.get(
  '/brand/:slug',
  asyncHandler(async (req, res) =>
    renderCatalogueListing(req, res, {
      brandSlug: req.params.slug,
      actionPath: `/brand/${encodeURIComponent(req.params.slug)}`,
      requireEntityMatch: true,
    })
  )
);

// ─── Single Product Detail (/product/:slug) ───
router.get(
  '/product/:slug',
  asyncHandler(async (req, res) => {
    const detail = await storefrontRepo.getStorefrontProductDetail(req.params.slug, {
      locale: req.locale,
    });
    if (!detail) {
      return renderStoreNotFound(req, res);
    }

    const baseUrl = buildBaseUrl(req);
    const { product, reviews, reviewStats, relatedProducts } = detail;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      sku: product.sku,
      image: product.gallery_images.map((img) =>
        img.startsWith('http') ? img : `${baseUrl}${img}`
      ),
      description: product.short_desc || product.description || product.name,
      brand: {
        '@type': 'Brand',
        name: product.brand_name || res.locals.brand.defaultProductBrand,
      },
      offers: {
        '@type': 'Offer',
        priceCurrency: 'BDT',
        price: Number(product.new_price).toFixed(2),
        availability: product.is_in_stock
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
        url: `${baseUrl}/product/${encodeURIComponent(product.slug)}`,
      },
    };
    if (reviewStats.count > 0) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: reviewStats.averageRating,
        reviewCount: reviewStats.count,
      };
    }

    return res.render('store/product', {
      product,
      reviews,
      reviewStats,
      relatedProducts,
      pageMeta: {
        title: product.name,
        description: (product.short_desc || product.description || product.name).slice(0, 160),
        canonicalUrl: `${baseUrl}/product/${encodeURIComponent(product.slug)}`,
        ogType: 'product',
        ogImage: product.image.startsWith('http') ? product.image : `${baseUrl}${product.image}`,
        jsonLd,
      },
    });
  })
);

// ─── Dedicated Shopping Cart Page (/cart) ───
router.get('/cart', asyncHandler(async (req, res) => {
  await refreshCustomerCart(req);
  const state = computeCartTotals(req);
  res.render('store/cart', state);
}));

// ─── Cart Entry Endpoints (Product Lookup Backed by MySQL-First Repository) ───
router.post(
  '/cart/add',
  requireCsrf,
  asyncHandler(async (req, res) => {
    await refreshCustomerCart(req);
    const t = res.locals.t;
    const { product_id, variant_id, qty, size, color, buy_now } = req.body;
    const prod = await storefrontRepo.findProductForCart(product_id, { locale: req.locale });
    if (!prod) {
      const msg = t('store.productNotFoundMsg');
      if (wantsJson(req)) {
        return res.status(404).json({ success: false, message: msg });
      }
      req.flash('error', msg);
      return res.redirect('/all-products');
    }

    let matchedVariant = null;
    if (prod.variants && prod.variants.length > 0) {
      if (variant_id) {
        matchedVariant = prod.variants.find((v) => Number(v.id) === Number(variant_id)) || null;
      }
      if (!matchedVariant && (size || color)) {
        matchedVariant =
          prod.variants.find(
            (v) =>
              (!size || v.size_label === String(size).trim()) &&
              (!color || !v.color_label || v.color_label === String(color).trim())
          ) || null;
      }
      if (!matchedVariant) {
        matchedVariant = prod.variants.find((v) => v.is_in_stock) || prod.variants[0];
      }
    }

    const availableStock = matchedVariant
      ? Number(matchedVariant.available_stock || 0)
      : Number(prod.available_stock || 0);

    if (availableStock <= 0) {
      const msg = t('store.outOfStockMsg', { name: prod.name });
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: msg });
      }
      req.flash('error', msg);
      return res.redirect(req.get('Referrer') || `/product/${prod.slug}`);
    }

    const addQty = Math.max(1, parseInt(String(qty || '1'), 10) || 1);
    const chosenSize = String(
      (matchedVariant && matchedVariant.size_label) ||
        size ||
        prod.size_options[0] ||
        prod.unit ||
        'Standard'
    ).trim();
    const chosenColor = String(
      (matchedVariant && matchedVariant.color_label) ||
        color ||
        prod.color_options[0] ||
        ''
    ).trim();

    if (!Array.isArray(req.session.cart)) req.session.cart = [];
    const existing = req.session.cart.find(
      (it) =>
        Number(it.product_id) === Number(prod.id) &&
        Number(it.variant_id || 0) === Number(matchedVariant ? matchedVariant.id : 0) &&
        it.size === chosenSize &&
        it.color === chosenColor
    );

    if (existing) {
      existing.qty = Math.min(availableStock, Number(existing.qty || 1) + addQty);
      existing.price = resolveEffectiveUnitPrice(prod, matchedVariant, existing.qty);
    } else {
      const finalQty = Math.min(availableStock, addQty);
      const baseRetail = matchedVariant && matchedVariant.price > 0 ? matchedVariant.price : prod.new_price;
      const unitPrice = resolveEffectiveUnitPrice(prod, matchedVariant, finalQty);

      req.session.cart.push({
        key: `${prod.id}-${matchedVariant ? matchedVariant.id : 0}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        product_id: prod.id,
        variant_id: matchedVariant ? matchedVariant.id : null,
        sku: matchedVariant ? matchedVariant.variant_sku : prod.sku,
        name: prod.name,
        slug: prod.slug,
        image: prod.image,
        regular_price: Number(baseRetail),
        wholesale_price: Number(prod.wholesale_price || 0),
        wholesale_min_qty: Number(prod.wholesale_min_qty || 0),
        price: unitPrice,
        qty: finalQty,
        size: chosenSize,
        color: chosenColor,
      });
    }

    await persistCustomerCart(req);
    const state = computeCartTotals(req);
    const isBuyNow = String(buy_now || '') === '1' || buy_now === true;
    const addedMsg = t('store.addedToCartMsg', { name: prod.name });

    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: addedMsg,
        ...state,
        sessionToken: req.sessionID,
        redirect: isBuyNow ? '/customer/checkout' : null,
      });
    }

    if (isBuyNow) {
      return res.redirect('/customer/checkout');
    }
    req.flash('success', addedMsg);
    return res.redirect(req.get('Referrer') || '/cart');
  })
);

router.post(
  '/cart/update',
  requireCsrf,
  asyncHandler(async (req, res) => {
    await refreshCustomerCart(req);
    const t = res.locals.t;
    const { key, qty } = req.body;
    const qtyText = String(qty ?? '');
    if (!/^\d+$/.test(qtyText) || Number(qtyText) > 99) throw new (require('../utils/errors').ValidationError)('Quantity must be a whole number from 0 to 99.');
    let availabilityAdjusted = false;
    if (Array.isArray(req.session.cart)) {
      const item = req.session.cart.find((i) => i.key === key);
      if (item) {
        const requested = Number(qtyText);
        if (requested === 0) {
          req.session.cart = req.session.cart.filter((i) => i.key !== key);
        } else {
          const prod = await storefrontRepo.findProductForCart(item.product_id, { locale: req.locale });
          const matchedVariant = prod && item.variant_id
            ? (prod.variants || []).find((v) => Number(v.id) === Number(item.variant_id)) || null
            : null;
          const staleVariant = Boolean(item.variant_id) && !matchedVariant;
          const availableStock = matchedVariant ? Number(matchedVariant.available_stock || 0) : Number(prod?.available_stock || 0);
          if (!prod || staleVariant || !Number.isSafeInteger(availableStock) || availableStock <= 0) {
            req.session.cart = req.session.cart.filter((i) => i.key !== key);
            availabilityAdjusted = true;
          } else {
            item.qty = Math.min(availableStock, requested);
            availabilityAdjusted = item.qty !== requested;
            item.price = resolveEffectiveUnitPrice(prod, matchedVariant, item.qty);
          }
        }
      }
    }

    await persistCustomerCart(req);
    const state = computeCartTotals(req);
    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: t('store.updatedCartMsg'),
        availabilityAdjusted,
        ...state,
        sessionToken: req.sessionID,
      });
    }
    return res.redirect(req.get('Referrer') || '/customer/checkout');
  })
);

router.post('/cart/remove', requireCsrf, asyncHandler(async (req, res) => {
  await refreshCustomerCart(req);
  const t = res.locals.t;
  const { key } = req.body;
  if (Array.isArray(req.session.cart)) {
    req.session.cart = req.session.cart.filter((i) => i.key !== key);
  }
  await persistCustomerCart(req);
  const state = computeCartTotals(req);
  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: t('store.removedFromCartMsg'),
      ...state,
      sessionToken: req.sessionID,
    });
  }
  return res.redirect(req.get('Referrer') || '/customer/checkout');
}));

router.post('/cart/clear', requireCsrf, asyncHandler(async (req, res) => {
  await refreshCustomerCart(req);
  const t = res.locals.t;
  req.session.cart = [];
  delete req.session.appliedCoupon;
  await persistCustomerCart(req);
  if (wantsJson(req)) {
    return res.json({
      success: true,
      message: t('store.clearedCartMsg'),
      cart: [],
      cartCount: 0,
      cartSubtotal: 0,
      discount: 0,
    });
  }
  req.flash('success', t('store.clearedCartMsg'));
  return res.redirect('/cart');
}));

router.get('/cart/json', asyncHandler(async (req, res) => {
  await refreshCustomerCart(req);
  const state = computeCartTotals(req);
  res.json({
    ...state,
    sessionToken: req.sessionID,
  });
}));

// ============================================================================
// DEFERRED CHECKOUT, ORDER & LANDING PAGE ROUTES (SCHEDULED PHASES 07, 08, 15)
// Documented in `docs/PHASE_05_CUSTOMER_STOREFRONT.md` §2.2
// ============================================================================

// ─── Direct 1-Click Quick Order (from Quick Order Modal or Product Page) ───
router.post('/order/quick-submit', (req, res) => {
  if (storefrontRepo.isMysqlMode()) return res.status(409).json({ success:false, message:'Quick order is not enabled on the canonical MySQL path. Add the product to the cart and use checkout.' });
  const {
    product_id,
    qty,
    size,
    color,
    customer_name,
    phone,
    address,
    shipping_area,
    note,
  } = req.body;

  const prod = db.get('SELECT * FROM products WHERE id = ? AND status = 1', Number(product_id));
  if (!prod) {
    if (wantsJson(req)) {
      return res.status(404).json({ success: false, message: 'পণ্য খুঁজে পাওয়া যায়নি।' });
    }
    req.flash('error', 'পণ্য খুঁজে পাওয়া যায়নি।');
    return res.redirect('/all-products');
  }

  const cleanName = String(customer_name || '').trim();
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '').trim();
  const cleanAddr = String(address || '').trim();

  if (!cleanName || cleanPhone.length < 10 || !cleanAddr) {
    const errMsg = 'অনুগ্রহ করে নাম, সঠিক মোবাইল নম্বর (১১ সংখ্যা) এবং সম্পূর্ণ ঠিকানা লিখুন।';
    if (wantsJson(req)) {
      return res.status(400).json({ success: false, message: errMsg });
    }
    req.flash('error', errMsg);
    return res.redirect(req.get('Referrer') || `/product/${prod.slug}`);
  }

  const clientIp = req.ip || '';
  const blocked = db.get(
    'SELECT * FROM ip_blocks WHERE status = 1 AND (ip_or_phone = ? OR ip_or_phone = ?)',
    cleanPhone,
    clientIp
  );
  if (blocked) {
    const msg = 'দুঃখিত, আপনার নম্বর থেকে বর্তমানে অর্ডার গ্রহণ করা সম্ভব হচ্ছে না। হটলাইনে যোগাযোগ করুন।';
    if (wantsJson(req)) return res.status(403).json({ success: false, message: msg });
    req.flash('error', msg);
    return res.redirect('/');
  }

  const orderQty = Math.max(1, Number(qty || 1));
  const unitPrice =
    prod.wholesale_price > 0 && prod.wholesale_min_qty > 0 && orderQty >= prod.wholesale_min_qty
      ? Number(prod.wholesale_price)
      : Number(prod.new_price);

  const settings = db.getSettings();
  const insideCharge = Number(settings.inside_dhaka_charge || 60);
  const outsideCharge = Number(settings.outside_dhaka_charge || 120);
  const freeMin = Number(settings.free_shipping_min || 2500);

  const subtotal = unitPrice * orderQty;
  let shippingCharge = shipping_area === 'ঢাকার বাইরে' ? outsideCharge : insideCharge;
  if (freeMin > 0 && subtotal >= freeMin) shippingCharge = 0;

  const totalAmount = subtotal + shippingCharge;
  const inv = generateInvoiceId();
  const trafficSource = detectTrafficSource(req);
  const chosenSize = String(size || (prod.sizes ? prod.sizes.split(',')[0].trim() : 'Standard')).trim();
  const chosenColor = String(color || '').trim();

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, discount, coupon_code,
     amount, payment_method, payment_status, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, 'ক্যাশ অন ডেলিভারি', 'unpaid', 'pending', ?, 'quick_order', ?, 0)`,
    inv,
    cleanName,
    cleanPhone,
    cleanAddr,
    shipping_area || 'ঢাকার ভিতরে',
    shippingCharge,
    subtotal,
    totalAmount,
    trafficSource,
    note || ''
  );

  db.run(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ordRes.lastInsertRowid,
    prod.id,
    prod.name,
    prod.image,
    unitPrice,
    orderQty,
    chosenSize,
    chosenColor
  );

  db.run(
    'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
    orderQty,
    orderQty,
    prod.id
  );

  const existingCust = db.get('SELECT id FROM customers WHERE phone = ?', cleanPhone);
  if (!existingCust) {
    db.run(
      'INSERT INTO customers (name, phone, address, ip_address, total_orders) VALUES (?, ?, ?, ?, 1)',
      cleanName,
      cleanPhone,
      cleanAddr,
      clientIp
    );
  } else {
    db.run(
      'UPDATE customers SET total_orders = total_orders + 1, address = ? WHERE id = ?',
      cleanAddr,
      existingCust.id
    );
  }

  const successUrl = `/order-success/${inv}`;
  if (wantsJson(req)) {
    return res.json({
      success: true,
      invoice_id: inv,
      redirect: successUrl,
      message: `অর্ডার #${inv} সফলভাবে সম্পন্ন হয়েছে!`,
    });
  }
  return res.redirect(successUrl);
});

// ─── Coupon Validation ───
router.post('/checkout/apply-coupon', requireCsrf, asyncHandler(async (req, res) => {
  if (storefrontRepo.isMysqlMode()) {
    const result = await checkoutRepo.validateCoupon(req.body.code, req.session.cart || [], { locale: req.locale });
    req.session.appliedCoupon = { code: result.code };
    return res.json({ success: true, code: result.code, discount: result.amount / 100, message: `Coupon applied: ৳${result.amount / 100}` });
  }
  const code = String(req.body.code || '').trim().toUpperCase();
  const subtotal = (req.session.cart || []).reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);

  const coupon = db.get('SELECT * FROM coupons WHERE UPPER(code) = ? AND status = 1', code);
  if (!coupon) {
    return res.json({ success: false, message: 'কুপন কোডটি সঠিক নয় বা মেয়াদোত্তীর্ণ।' });
  }
  if (subtotal < Number(coupon.min_purchase || 0)) {
    return res.json({
      success: false,
      message: `এই কুপন ব্যবহার করতে ন্যূনতম ৳${coupon.min_purchase} অর্ডার করতে হবে।`,
    });
  }

  const discount =
    coupon.type === 'percent'
      ? Math.round((subtotal * Number(coupon.value)) / 100)
      : Number(coupon.value);

  req.session.appliedCoupon = { code: coupon.code, discount };
  return res.json({
    success: true,
    code: coupon.code,
    discount,
    message: `কুপন "${coupon.code}" প্রয়োগ হয়েছে! ছাড়: ৳${discount}`,
  });
}));

// ─── Save Incomplete / Abandoned Checkout ───
router.post('/checkout/save-incomplete', requireCsrf, asyncHandler(async (req, res) => {
  const { name, phone, address } = req.body;
  if (storefrontRepo.isMysqlMode()) {
    if (req.body.consent !== 'true' || req.body.notification_consent === 'true') return res.json({ ok: false, reason: 'explicit_consent_required' });
    const result = await phase08Repo.recordIncompleteCheckout({
      consent: true, notificationConsent: false, phone, name, sessionSid: req.sessionID,
      cart: (req.session.cart || []).map((item) => ({ product_id: item.product_id ?? item.productId ?? item.id, variant_id: item.variant_id ?? item.variantId ?? null, qty: item.qty ?? item.quantity })),
    });
    if (result.recorded) req.session.incompleteCheckoutId = result.id;
    return res.json({ ok: Boolean(result.recorded), id: result.id || null, reason: result.reason || null });
  }
  const cleanPhone = String(phone || '').trim();
  if (cleanPhone.length >= 10 && Array.isArray(req.session.cart) && req.session.cart.length > 0) {
    const summary = req.session.cart.map((i) => `${i.name} × ${i.qty}`).join(', ');
    const est = req.session.cart.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
    const existing = db.get(
      "SELECT id FROM incomplete_orders WHERE phone = ? AND status = 'abandoned'",
      cleanPhone
    );
    if (existing) {
      db.run(
        'UPDATE incomplete_orders SET customer_name = ?, address = ?, cart_summary = ?, estimated_amount = ? WHERE id = ?',
        name || '',
        address || '',
        summary,
        est,
        existing.id
      );
    } else {
      db.run(
        'INSERT INTO incomplete_orders (customer_name, phone, address, cart_summary, estimated_amount) VALUES (?, ?, ?, ?, ?)',
        name || '',
        cleanPhone,
        address || '',
        summary,
        est
      );
    }
  }
  res.json({ ok: true });
}));

router.post('/checkout/withdraw-recovery-consent', requireCsrf, asyncHandler(async (req, res) => {
  if (!storefrontRepo.isMysqlMode()) return res.json({ ok: true });
  const result = await phase08Repo.withdrawIncompleteCheckout(req.body.record_id, req.sessionID);
  if (Number(req.session.incompleteCheckoutId) === Number(result.id)) delete req.session.incompleteCheckoutId;
  return res.json({ ok: true, status: result.status });
}));

// ─── Customer Checkout Page ───
router.get('/customer/checkout', asyncHandler(async (req, res) => {
  if (storefrontRepo.isMysqlMode()) {
    await refreshCustomerCart(req);
    const source = Array.isArray(req.session.cart) ? req.session.cart : [];
    const quote = source.length ? await checkoutRepo.quoteCart(source, { locale: req.locale }) : { items: [], subtotalPaisa: 0, count: 0 };
    const sourceKeys = new Map(source.map((item) => [`${Number(item.product_id ?? item.productId ?? item.id)}:${Number(item.variant_id ?? item.variantId ?? 0)}:${String(item.size||'')}:${String(item.color||'')}`, item.key]));
    const cart = quote.items.map((item) => ({ ...item, key: sourceKeys.get(`${Number(item.product_id)}:${Number(item.variant_id||0)}:${String(item.size||'')}:${String(item.color||'')}`) || `${item.product_id}:${item.variant_id || 0}`, price: item.price_paisa / 100 }));
    req.session.cart = cart.map((item) => ({ key: item.key, product_id: item.product_id, variant_id: item.variant_id, qty: item.qty, name: item.name, image: item.image, price: item.price, size: item.size, color: item.color }));
    let discount = 0;
    if (req.session.appliedCoupon?.code && cart.length) {
      try { discount = (await checkoutRepo.validateCoupon(req.session.appliedCoupon.code, cart, { locale: req.locale })).amount / 100; }
      catch (_err) { delete req.session.appliedCoupon; }
    }
    if (!req.session.checkoutRequestKey || req.session.checkoutLastRequestKey === req.session.checkoutRequestKey) req.session.checkoutRequestKey = crypto.randomBytes(24).toString('hex');
    const [locations, methods] = await Promise.all([checkoutRepo.listDeliveryLocations(), checkoutRepo.listCheckoutMethods()]);
    return res.render('store/checkout', {
      cart, cartCount: quote.count, cartSubtotal: quote.subtotalPaisa / 100, discount,
      appliedCoupon: req.session.appliedCoupon || null, gateways: methods,
      deliveryLocations: locations, checkoutAvailable: Boolean(locations.length && methods.length), canonicalMysqlCheckout: true, checkoutRequestKey: req.session.checkoutRequestKey,
      csrfToken: req.csrfToken(), siteSettings: { free_shipping_min: 0 }, isEn: req.locale === 'en',
    });
  }
  const state = computeCartTotals(req);
  const gateways = db.all('SELECT * FROM payment_gateways WHERE status = 1 ORDER BY id ASC');
  return res.render('store/checkout', { ...state, gateways, canonicalMysqlCheckout: false, csrfToken: req.csrfToken() });
}));

router.post('/customer/checkout', requireCsrf, asyncHandler(async (req, res) => {
  if (storefrontRepo.isMysqlMode()) {
    const candidate = String(req.body.checkout_request_key || '');
    const activeKey = String(req.session.checkoutRequestKey || '');
    const replayKey = String(req.session.checkoutLastRequestKey || '');
    const matches = (key) => key && candidate.length === key.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(candidate));
    const expected = matches(activeKey) ? activeKey : (matches(replayKey) ? replayKey : '');
    if (!expected) throw new (require('../utils/errors').ConflictError)('Checkout session expired. Reload checkout and try again.');
    if (req.body.confirm_order !== 'yes') throw new (require('../utils/errors').ValidationError)('Confirm the order details before submitting.');
    const isReplay = matches(replayKey);
    const sourceCart = isReplay ? (req.session.checkoutLastCart || []) : (req.session.cart || []);
    const incompleteOrderId = isReplay ? (req.session.checkoutLastRecoveryId || null) : (req.session.incompleteCheckoutId || null);
    if (!Array.isArray(sourceCart) || !sourceCart.length) throw new (require('../utils/errors').ValidationError)('Your server-side cart is empty.');
    const result = await checkoutRepo.createOrder({
      customer_name: req.body.customer_name, phone: req.body.phone, address: req.body.address,
      delivery_location_id: req.body.delivery_location_id, payment_method: req.body.payment_method,
      note: req.body.note, coupon_code: matches(replayKey) ? String(req.body.coupon_code || '') : (req.session.appliedCoupon?.code || ''),
    }, { locale: req.locale, sessionCustomer: req.customerUser || null, ip: req.ip, requestKey: expected, cart: sourceCart, incompleteOrderId, sessionSid: req.sessionID, analyticsConsent: consentGranted(req.session, env.analyticsAttributionEnabled), attribution: req.session.analyticsAttribution || null });
    if (!isReplay) { req.session.checkoutLastCart = JSON.parse(JSON.stringify(sourceCart)); req.session.checkoutLastRequestKey = expected; req.session.checkoutLastRecoveryId = incompleteOrderId; delete req.session.incompleteCheckoutId; req.session.cart = []; delete req.session.appliedCoupon; await persistCustomerCart(req); }
    return res.redirect(`/order-success/${encodeURIComponent(result.invoiceNo)}`);
  }
  const {
    customer_name,
    phone,
    address,
    shipping_area,
    note,
    payment_method,
    trx_id,
    sender_number,
    cart_backup_json,
  } = req.body;

  let cart = Array.isArray(req.session.cart) ? req.session.cart : [];
  if (!cart.length && cart_backup_json) {
    try {
      const parsed = JSON.parse(cart_backup_json);
      if (Array.isArray(parsed) && parsed.length) {
        cart = parsed;
      }
    } catch (_e) {}
  }

  if (!cart.length) {
    req.flash('error', 'আপনার কার্ট খালি! প্রথমে পছন্দের পণ্য কার্টে যোগ করুন।');
    return res.redirect('/all-products');
  }

  const cleanName = String(customer_name || '').trim();
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '').trim();
  const cleanAddress = String(address || '').trim();

  if (!cleanName || cleanPhone.length < 10 || !cleanAddress) {
    req.flash('error', 'অনুগ্রহ করে আপনার পূর্ণ নাম, ১১ সংখ্যার মোবাইল নম্বর এবং সম্পূর্ণ ঠিকানা সঠিকভাবে দিন।');
    return res.redirect('/customer/checkout');
  }

  const clientIp = req.ip || '';
  const blocked = db.get(
    'SELECT * FROM ip_blocks WHERE status = 1 AND (ip_or_phone = ? OR ip_or_phone = ?)',
    cleanPhone,
    clientIp
  );
  if (blocked) {
    req.flash('error', 'দুঃখিত, আপনার নম্বর থেকে বর্তমানে অর্ডার গ্রহণ করা সম্ভব হচ্ছে না। হটলাইনে যোগাযোগ করুন।');
    return res.redirect('/customer/checkout');
  }

  const settings = db.getSettings();
  const insideCharge = Number(settings.inside_dhaka_charge || 60);
  const outsideCharge = Number(settings.outside_dhaka_charge || 120);
  const freeMin = Number(settings.free_shipping_min || 2500);

  const subtotal = cart.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  let shippingCharge = shipping_area === 'ঢাকার বাইরে' ? outsideCharge : insideCharge;
  if (freeMin > 0 && subtotal >= freeMin) shippingCharge = 0;

  const appliedCoupon = req.session.appliedCoupon || null;
  const discount = appliedCoupon ? Number(appliedCoupon.discount || 0) : 0;
  const totalAmount = Math.max(0, subtotal + shippingCharge - discount);

  const inv = generateInvoiceId();
  const trafficSource = detectTrafficSource(req);

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, discount, coupon_code,
     amount, payment_method, payment_status, trx_id, sender_number, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'website', ?, 0)`,
    inv,
    cleanName,
    cleanPhone,
    cleanAddress,
    shipping_area || 'ঢাকার ভিতরে',
    shippingCharge,
    subtotal,
    discount,
    appliedCoupon ? appliedCoupon.code : '',
    totalAmount,
    payment_method || 'ক্যাশ অন ডেলিভারি',
    trx_id ? 'verification_pending' : 'unpaid',
    trx_id || '',
    sender_number || '',
    trafficSource,
    note || ''
  );

  const orderId = ordRes.lastInsertRowid;
  for (const item of cart) {
    db.run(
      `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      item.product_id,
      item.name,
      item.image,
      Number(item.price),
      Number(item.qty),
      item.size || 'Standard',
      item.color || ''
    );
    db.run(
      'UPDATE products SET stock = MAX(0, stock - ?), sold_count = sold_count + ? WHERE id = ?',
      Number(item.qty),
      Number(item.qty),
      item.product_id
    );
  }

  if (appliedCoupon) {
    db.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', appliedCoupon.code);
  }

  db.run("DELETE FROM incomplete_orders WHERE phone = ? AND status = 'abandoned'", cleanPhone);

  const existingCust = db.get('SELECT id FROM customers WHERE phone = ?', cleanPhone);
  if (!existingCust) {
    db.run(
      'INSERT INTO customers (name, phone, address, ip_address, total_orders) VALUES (?, ?, ?, ?, 1)',
      cleanName,
      cleanPhone,
      cleanAddress,
      clientIp
    );
  } else {
    db.run(
      'UPDATE customers SET total_orders = total_orders + 1, address = ? WHERE id = ?',
      cleanAddress,
      existingCust.id
    );
  }

  req.session.cart = [];
  delete req.session.appliedCoupon;

  return res.redirect(`/order-success/${inv}`);
}));

router.get('/order-success/:invoiceId', asyncHandler(async (req, res) => {
  if (storefrontRepo.isMysqlMode()) {
    const result = await checkoutRepo.getOrderForSuccess(req.params.invoiceId);
    if (!result) return res.redirect('/');
    return res.render('store/order-success-mysql', { order: result.order, items: result.items, isEn: req.locale === 'en' });
  }
  const order = db.get(
    `SELECT o.*, COALESCE(os.name, o.status) AS status_label
     FROM orders o
     LEFT JOIN order_statuses os ON os.slug = o.status
     WHERE o.invoice_id = ?`,
    req.params.invoiceId
  );
  if (!order) return res.redirect('/');
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  return res.render('store/order-success', { order, items });
}));

router.post('/order/:invoiceId/cancel', (req, res) => {
  if (storefrontRepo.isMysqlMode()) return res.status(409).json({ success:false, message:'Customer cancellation is paused on MySQL until invoice ownership verification is available. Contact support; authorized admins can cancel pending orders.' });
  const order = db.get('SELECT * FROM orders WHERE invoice_id = ?', req.params.invoiceId);
  if (!order) return res.redirect('/track-order');

  if (order.status !== 'pending') {
    req.flash('error', 'এই অর্ডারটি ইতিমধ্যে প্রসেসিংয়ে চলে গেছে, বাতিল করতে হটলাইনে কল করুন।');
    return res.redirect(`/track-order?q=${order.invoice_id}`);
  }

  db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
  const items = db.all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  for (const it of items) {
    if (it.product_id) {
      db.run(
        'UPDATE products SET stock = stock + ?, sold_count = MAX(0, sold_count - ?) WHERE id = ?',
        Number(it.qty || 1),
        Number(it.qty || 1),
        it.product_id
      );
    }
  }
  req.flash('success', `অর্ডার #${order.invoice_id} বাতিল করা হয়েছে।`);
  return res.redirect(`/track-order?q=${order.invoice_id}`);
});

router.get(['/track-order', '/order-track', '/site/order-track'], (req, res) => {
  const query = String(req.query.q || '').trim().replace(/^#/, '');
  let orders = [];
  if (query && !storefrontRepo.isMysqlMode()) {
    orders = db.all(
      `SELECT o.*, COALESCE(os.name, o.status) AS status_label, COALESCE(os.color, '#f59e0b') AS status_color
       FROM orders o
       LEFT JOIN order_statuses os ON os.slug = o.status
       WHERE o.invoice_id = ? OR o.phone = ?
       ORDER BY o.id DESC`,
      query,
      query
    );
    for (const o of orders) {
      o.items = db.all('SELECT * FROM order_items WHERE order_id = ?', o.id);
    }
  }
  res.render('store/track-order', { query, orders });
});

router.get('/campaign/:slug', (req, res) => {
  const campaign = db.get('SELECT * FROM campaigns WHERE slug = ? AND status = 1', req.params.slug);
  if (!campaign) return res.redirect('/');
  const product =
    db.get('SELECT * FROM products WHERE id = ?', campaign.product_id) ||
    db.get('SELECT * FROM products LIMIT 1');
  return res.render('store/campaign', { campaign, product });
});

router.post('/campaign/:slug/order', (req, res) => {
  const campaign = db.get('SELECT * FROM campaigns WHERE slug = ?', req.params.slug);
  if (!campaign) return res.redirect('/');
  const product = db.get('SELECT * FROM products WHERE id = ?', campaign.product_id);

  const { customer_name, phone, address, shipping_area, qty } = req.body;
  const orderQty = Math.max(1, Number(qty || 1));
  const ship = shipping_area === 'ঢাকার বাইরে' ? 120 : 60;
  const subtotal = Number(campaign.offer_price) * orderQty;
  const total = subtotal + ship;
  const inv = generateInvoiceId();

  const ordRes = db.run(
    `INSERT INTO orders
    (invoice_id, customer_name, phone, address, shipping_area, shipping_charge, subtotal, amount,
     payment_method, status, traffic_source, order_type, note, is_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ক্যাশ অন ডেলিভারি', 'pending', 'Landing Page', 'landing', ?, 0)`,
    inv,
    customer_name,
    phone,
    address,
    shipping_area || 'ঢাকার ভিতরে',
    ship,
    subtotal,
    total,
    `Campaign: ${campaign.title}`
  );
  db.run(
    `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, qty, size)
     VALUES (?, ?, ?, ?, ?, ?, 'স্পেশাল প্যাক')`,
    ordRes.lastInsertRowid,
    product ? product.id : 1,
    product ? product.name : campaign.title,
    product ? product.image : campaign.banner_image,
    Number(campaign.offer_price),
    orderQty
  );
  return res.redirect(`/order-success/${inv}`);
});

// ============================================================================
// PHASE 05 — BLOGS, CMS POLICIES, ABOUT, FAQ, CONTACT, SUPPORT & SEO ENDPOINTS
// ============================================================================

router.get(
  '/blogs',
  asyncHandler(async (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const blogData = await storefrontRepo.listBlogs({
      locale: req.locale,
      category: req.query.category,
      page: req.query.page,
      perPage: 6,
    });
    res.render('store/page', {
      mode: 'blogs',
      blogs: blogData.items,
      relatedBlogs: [],
      page: null,
      blogPagination: {
        page: blogData.page,
        totalPages: blogData.totalPages,
        baseUrl: buildPaginationBaseUrl('/blogs', req.query),
      },
      pageMeta: {
        title: res.locals.t('common.blogs'),
        description: res.locals.t('store.blogSub'),
        canonicalUrl: `${baseUrl}/blogs`,
        ogType: 'website',
      },
    });
  })
);

router.get(
  '/blog/:slug',
  asyncHandler(async (req, res) => {
    const found = await storefrontRepo.getBlogBySlug(req.params.slug, { locale: req.locale });
    if (!found) return renderStoreNotFound(req, res);

    const baseUrl = buildBaseUrl(req);
    return res.render('store/page', {
      mode: 'blog_detail',
      blogs: [],
      relatedBlogs: found.relatedBlogs,
      page: found.blog,
      pageMeta: {
        title: found.blog.title,
        description: found.blog.summary,
        canonicalUrl: `${baseUrl}/blog/${encodeURIComponent(found.blog.slug)}`,
        ogType: 'article',
        ogImage: found.blog.image.startsWith('http')
          ? found.blog.image
          : `${baseUrl}${found.blog.image}`,
      },
    });
  })
);

router.get(
  '/about',
  asyncHandler(async (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const cms = await storefrontRepo.getCmsPageBySlug('about-us', { locale: req.locale });
    const page = cms || {
      slug: 'about-us',
      title: res.locals.t('store.aboutNav'),
      content: res.locals.t('store.footerTagline'),
    };
    return res.render('store/page', {
      mode: 'cms',
      blogs: [],
      relatedBlogs: [],
      page,
      pageMeta: {
        title: page.title,
        canonicalUrl: `${baseUrl}/about`,
        ogType: 'website',
      },
    });
  })
);

router.get('/faq', (req, res) => {
  const t = res.locals.t;
  const fmt = res.locals.fmt;
  const s = res.locals.siteSettings;
  const baseUrl = buildBaseUrl(req);

  const faqItems = [
    { q: t('store.faqQ1'), a: t('store.faqA1') },
    {
      q: t('store.faqQ2'),
      a: t('store.faqA2', {
        insideFee: fmt.bdt(Number(s.inside_dhaka_charge || 60)),
        outsideFee: fmt.bdt(Number(s.outside_dhaka_charge || 120)),
        freeMin: fmt.bdt(Number(s.free_shipping_min || 2500)),
      }),
    },
    { q: t('store.faqQ3'), a: t('store.faqA3') },
    { q: t('store.faqQ4'), a: t('store.faqA4') },
    { q: t('store.faqQ5'), a: t('store.faqA5') },
  ];

  res.render('store/page', {
    mode: 'faq',
    blogs: [],
    relatedBlogs: [],
    page: { title: t('store.faqPageTitle') },
    faqItems,
    pageMeta: {
      title: t('store.faqPageTitle'),
      description: t('store.faqPageSub'),
      canonicalUrl: `${baseUrl}/faq`,
      ogType: 'website',
    },
  });
});

router.get('/contact', (req, res) => {
  const t = res.locals.t;
  const baseUrl = buildBaseUrl(req);
  res.render('store/page', {
    mode: 'contact',
    blogs: [],
    relatedBlogs: [],
    page: { title: t('store.contactPageTitle') },
    pageMeta: {
      title: t('store.contactPageTitle'),
      description: t('store.contactPageSub'),
      canonicalUrl: `${baseUrl}/contact`,
      ogType: 'website',
    },
  });
});

router.get(
  '/page/:slug',
  asyncHandler(async (req, res) => {
    const page = await storefrontRepo.getCmsPageBySlug(req.params.slug, { locale: req.locale });
    if (!page) return renderStoreNotFound(req, res);

    const baseUrl = buildBaseUrl(req);
    return res.render('store/page', {
      mode: 'cms',
      blogs: [],
      relatedBlogs: [],
      page,
      pageMeta: {
        title: page.title,
        canonicalUrl: `${baseUrl}/page/${encodeURIComponent(page.slug)}`,
        ogType: 'website',
      },
    });
  })
);

// ─── Customer Support Assistant, Complaint, Contact, Newsletter, Review & SEO ───
router.post(
  '/api/store-assistant',
  asyncHandler(async (req, res) => {
    const msg = String(req.body.message || '').trim();
    const q = msg.toLowerCase();
    const fmt = res.locals.fmt;
    const isEn = req.locale === 'en';

    const numMatch = msg.match(/\d{5,11}/);
    if (numMatch && !storefrontRepo.isMysqlMode()) {
      const token = numMatch[0];
      const ord = db.get(
        'SELECT * FROM orders WHERE invoice_id = ? OR phone = ? ORDER BY id DESC LIMIT 1',
        token,
        token
      );
      if (ord) {
        return res.json({
          success: true,
          reply: isEn
            ? `📦 Order Found!\n• Invoice: #${ord.invoice_id}\n• Customer: ${ord.customer_name}\n• Total: ${fmt.bdt(ord.amount)}\n• Status: ${String(ord.status || '').toUpperCase()}${ord.courier_tracking_id ? '\n• Courier Tracking: ' + ord.courier_tracking_id : ''}`
            : `📦 অর্ডার পাওয়া গেছে!\n• ইনভয়েস: #${ord.invoice_id}\n• নাম: ${ord.customer_name}\n• মোট মূল্য: ${fmt.bdt(ord.amount)}\n• বর্তমান স্ট্যাটাস: ${String(ord.status || '').toUpperCase()}${ord.courier_tracking_id ? '\n• কুরিয়ার ট্র্যাকিং: ' + ord.courier_tracking_id : ''}`,
        });
      }
    }

    if (
      q.includes('দাম') ||
      q.includes('price') ||
      q.includes('প্রোডাক্ট') ||
      q.includes('খুঁজুন') ||
      q.includes('product') ||
      q.includes('gift') ||
      q.includes('গিফট')
    ) {
      const listing = await storefrontRepo.listStorefrontProducts({
        locale: req.locale,
        perPage: 5,
      });
      if (listing.items.length > 0) {
        return res.json({
          success: true,
          reply:
            (isEn ? '🛒 Available Products:\n' : '🛒 আমাদের উপলব্ধ পণ্যসমূহ:\n') +
            listing.items.map((p) => `• ${p.name} — ${fmt.bdt(p.new_price)}`).join('\n'),
        });
      }
    }

    if (q.includes('ট্র্যাক') || q.includes('track')) {
      return res.json({
        success: true,
        reply: isEn
          ? '📦 Visit /track-order or send your Invoice ID / mobile number here to check your order status.'
          : '📦 অর্ডার ট্র্যাক করতে /track-order পেজে যান অথবা আপনার ইনভয়েস বা মোবাইল নম্বর এখানে লিখে পাঠান!',
      });
    }

    return res.json({
      success: true,
      reply: isEn
        ? 'Welcome to Mr. Tumi Grocery & Gift! 😊\nHow can we help you today?\n• Ask for product prices & availability\n• Track an order via /track-order\n• Visit /contact or use Feedback & Complaint for support.'
        : 'স্বাগতম মি. তুমি গ্রোসারি অ্যান্ড গিফট-এ! 😊\nআপনি নিচের যেকোনো বিষয়ে জানতে পারেন:\n• পণ্যের দাম ও স্টক তথ্য জানতে নাম লিখুন\n• অর্ডার ট্র্যাক করতে ইনভয়েস বা মোবাইল নম্বর লিখুন\n• সহায়তা বা অভিযোগের জন্য /contact পেজ দেখুন।',
    });
  })
);

router.post(
  '/api/complaint',
  publicFormLimiter,
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    const result = await storefrontRepo.submitComplaint({
      name: req.body.name,
      phone: req.body.phone,
      invoiceNo: req.body.invoice_id || req.body.invoice_no,
      details: req.body.details,
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: t('store.complaintValidationError') });
    }
    return res.json({ success: true, message: t('store.complaintSuccessMsg') });
  })
);

router.post(
  '/api/contact',
  publicFormLimiter,
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    const result = await storefrontRepo.submitContactMessage({
      name: req.body.name,
      phone: req.body.phone,
      email: req.body.email,
      subject: req.body.subject,
      message: req.body.message,
    });
    if (!result.ok) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: t('store.contactValidationError') });
      }
      req.flash('error', t('store.contactValidationError'));
      return res.redirect(req.get('Referrer') || '/contact');
    }
    if (wantsJson(req)) {
      return res.json({ success: true, message: t('store.contactSuccessMsg') });
    }
    req.flash('success', t('store.contactSuccessMsg'));
    return res.redirect(req.get('Referrer') || '/contact');
  })
);

router.post(
  '/api/newsletter',
  publicFormLimiter,
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    await storefrontRepo.subscribeNewsletter(req.body.email_or_phone);
    if (wantsJson(req)) {
      return res.json({ success: true, message: t('store.newsletterSuccessMsg') });
    }
    req.flash('success', t('store.newsletterSuccessMsg'));
    return res.redirect(req.get('Referrer') || '/');
  })
);

router.post(
  '/api/review',
  publicFormLimiter,
  asyncHandler(async (req, res) => {
    const t = res.locals.t;
    const result = await storefrontRepo.submitProductReview({
      productId: req.body.product_id,
      customerId: req.customerUser ? req.customerUser.id : null,
      customerName: req.body.customer_name,
      rating: req.body.rating,
      comment: req.body.comment,
    });
    if (!result.ok) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: t('store.reviewValidationError') });
      }
      req.flash('error', t('store.reviewValidationError'));
      return res.redirect(req.get('Referrer') || '/all-products');
    }
    if (wantsJson(req)) {
      return res.json({ success: true, status: 'pending', message: t('store.reviewSubmittedPending') });
    }
    req.flash('success', t('store.reviewSubmittedPending'));
    return res.redirect(req.get('Referrer') || '/');
  })
);

router.get('/api/recent-verified-order', (_req, res) => {
  if (storefrontRepo.isMysqlMode()) {
    return res.json({ enabled: false });
  }
  const s = db.getSettings();
  if (s.sale_notification_enabled === '0') {
    return res.json({ enabled: false });
  }
  const ord = db.get(
    `SELECT o.customer_name, o.address, oi.product_name, oi.product_image, p.slug
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN products p ON p.id = oi.product_id
     ORDER BY RANDOM() LIMIT 1`
  );
  if (!ord) return res.json({ enabled: false });
  return res.json({
    enabled: true,
    customer: ord.customer_name,
    location: ord.address,
    product: ord.product_name,
    image: ord.product_image || '/uploads/product/lychee-fresh.jpg',
    url: ord.slug ? `/product/${ord.slug}` : '/all-products',
  });
});

router.get('/robots.txt', (req, res) => {
  const baseUrl = buildBaseUrl(req);
  const txt = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Disallow: /vendor/',
    'Disallow: /reseller/',
    'Disallow: /cart',
    'Disallow: /customer/checkout',
    'Disallow: /api/',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    '',
  ].join('\n');
  res.type('text/plain').send(txt);
});

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const entries = await storefrontRepo.getSitemapEntries();
    const urls = [
      `${baseUrl}/`,
      `${baseUrl}/all-products`,
      `${baseUrl}/flash-sales`,
      `${baseUrl}/hot-deals`,
      `${baseUrl}/about`,
      `${baseUrl}/faq`,
      `${baseUrl}/contact`,
      `${baseUrl}/blogs`,
      ...entries.categories.map((c) => `${baseUrl}/category/${encodeURIComponent(c.slug)}`),
      ...entries.subcategories.map((sc) => `${baseUrl}/subcategory/${encodeURIComponent(sc.slug)}`),
      ...entries.childcategories.map((cc) => `${baseUrl}/childcategory/${encodeURIComponent(cc.slug)}`),
      ...entries.brands.map((b) => `${baseUrl}/brand/${encodeURIComponent(b.slug)}`),
      ...entries.products.map((p) => `${baseUrl}/product/${encodeURIComponent(p.slug)}`),
      ...entries.blogs.map((b) => `${baseUrl}/blog/${encodeURIComponent(b.slug)}`),
      ...entries.pages.map((pg) => `${baseUrl}/page/${encodeURIComponent(pg.slug)}`),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n')}
</urlset>`;
    res.type('application/xml').send(xml);
  })
);

module.exports = router;
