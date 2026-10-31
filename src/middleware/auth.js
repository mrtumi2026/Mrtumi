'use strict';

const { getAllSettings } = require('../repositories/settingsRepository');
const {
  findActiveAdminById,
  findVendorById,
  findResellerById,
  findCustomerById,
  loadLayoutNavigationContext,
} = require('../repositories/authRepository');
const { hasPermission } = require('./rbac');
const { createI18nContext } = require('../i18n');
const {
  resolveBrandContext,
  requiresOwnerCopyReview,
  replaceLegacyBrandTokens,
} = require('../i18n/brand');

/**
 * Attaches global template variables (`siteSettings`, `navCategories`, `footerPages`,
 * `storeFeatures`, `socialLinks`, `cart`, `flash`, portal session users, and RBAC helpers)
 * via the async repository layer (MySQL in production/CI; SQLite in local prototype mode).
 */
async function attachGlobals(req, res, next) {
  try {
    const isAdminPath = Boolean(req.path && req.path.startsWith('/admin'));

    const [rawSettings, navContext] = await Promise.all([
      getAllSettings(),
      loadLayoutNavigationContext(isAdminPath),
    ]);

    // Ensure bound i18n context is always available even if called directly in unit tests
    if (!res.locals.t || !res.locals.fmt) {
      const fallbackI18n = createI18nContext(req.locale || 'bn');
      res.locals.locale = fallbackI18n.locale;
      res.locals.htmlLang = fallbackI18n.htmlLang;
      res.locals.isBangla = fallbackI18n.isBangla;
      res.locals.isEnglish = fallbackI18n.isEnglish;
      res.locals.t = fallbackI18n.t;
      res.locals.fmt = fallbackI18n.fmt;
    }

    const activeLocale = res.locals.locale || 'bn';
    const { siteSettings, brand } = resolveBrandContext(rawSettings, activeLocale);

    res.locals.siteSettings = siteSettings;
    res.locals.settings = siteSettings;
    res.locals.brand = brand;
    res.locals.requiresOwnerCopyReview = requiresOwnerCopyReview;
    res.locals.replaceLegacyBrandTokens = (val) => replaceLegacyBrandTokens(val, activeLocale);
    res.locals.sessionToken = req.sessionID || '';
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;

    let adminUser = req.session.adminUser || null;
    if (isAdminPath && adminUser && adminUser.id) {
      const freshAdmin = await findActiveAdminById(adminUser.id);
      adminUser = freshAdmin || null;
      if (!freshAdmin) {
        delete req.session.adminUser;
      }
    }

    let vendorUser = req.session.vendorUser || null;
    if (req.path.startsWith('/vendor') && vendorUser && vendorUser.id) {
      const freshV = await findVendorById(vendorUser.id);
      if (freshV) vendorUser = freshV;
    }

    let resellerUser = req.session.resellerUser || null;
    if (req.path.startsWith('/reseller') && resellerUser && resellerUser.id) {
      const freshR = await findResellerById(resellerUser.id);
      if (freshR) resellerUser = freshR;
    }

    let customerUser = req.session.customerUser || null;
    if (req.path.startsWith('/customer') && customerUser && customerUser.id) {
      const freshCustomer = await findCustomerById(customerUser.id);
      customerUser = freshCustomer || null;
      if (!freshCustomer) delete req.session.customerUser;
    }

    req.adminUser = adminUser;
    req.vendorUser = vendorUser;
    req.resellerUser = resellerUser;
    req.customerUser = customerUser;

    res.locals.adminUser = adminUser;
    res.locals.vendorUser = vendorUser;
    res.locals.resellerUser = resellerUser;
    res.locals.customerUser = customerUser;
    res.locals.hasPermission = (permKey) => hasPermission(adminUser, permKey);

    // Flash messages for Toastr
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    req.flash = (type, message) => {
      req.session.flash = { type, message };
    };

    // Cart state for storefront
    if (!Array.isArray(req.session.cart)) {
      req.session.cart = [];
    }
    const cart = req.session.cart;
    const cartCount = cart.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
    const cartSubtotal = cart.reduce(
      (sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 1),
      0
    );
    res.locals.cart = cart;
    res.locals.cartCount = cartCount;
    res.locals.cartSubtotal = cartSubtotal;

    // Categories, CMS pages & social links for storefront header/footer (localized per activeLocale)
    const localizeNavLabel = (bnOrDefault, enCandidate) => {
      const cleanEn = replaceLegacyBrandTokens(String(enCandidate || '').trim(), 'en');
      const cleanBn = replaceLegacyBrandTokens(String(bnOrDefault || '').trim(), 'bn');
      return activeLocale === 'en' ? cleanEn || cleanBn : cleanBn || cleanEn;
    };

    res.locals.navCategories = (navContext.navCategories || []).map((c) => ({
      ...c,
      name: localizeNavLabel(c.name_bn || c.name, c.name_en),
      subcategories: (c.subcategories || []).map((sc) => ({
        ...sc,
        name: localizeNavLabel(sc.name_bn || sc.name, sc.name_en),
      })),
    }));
    res.locals.footerPages = (navContext.footerPages || []).map((fp) => ({
      ...fp,
      title: localizeNavLabel(fp.title_bn || fp.title, fp.title_en),
    }));
    res.locals.storeFeatures = (navContext.storeFeatures || []).map((ft) => ({
      ...ft,
      title: localizeNavLabel(ft.title_bn || ft.title, ft.title_en),
      subtitle: localizeNavLabel(ft.subtitle_bn || ft.subtitle, ft.subtitle_en),
    }));
    res.locals.socialLinks = navContext.socialLinks;

    if (isAdminPath) {
      res.locals.pendingOrdersCount = navContext.pendingOrdersCount;
      res.locals.pendingOrdersList = navContext.pendingOrdersList;
      res.locals.pendingReviewsCount = navContext.pendingReviewsCount;
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminUser) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/admin/login');
  }
  return next();
}

function requireVendor(req, res, next) {
  if (!req.session || !req.session.vendorUser) {
    return res.redirect('/vendor/login');
  }
  return next();
}

function requireReseller(req, res, next) {
  if (!req.session || !req.session.resellerUser || (req.resellerUser !== undefined && !req.resellerUser)) {
    if (req.session) delete req.session.resellerUser;
    return res.redirect('/reseller/login');
  }
  return next();
}

function requireCustomer(req, res, next) {
  if (!req.session || !req.session.customerUser || (req.customerUser !== undefined && !req.customerUser)) {
    if (req.session) delete req.session.customerUser;
    return res.redirect('/customer/login');
  }
  return next();
}

module.exports = {
  attachGlobals,
  setFlash,
  requireAdmin,
  requireVendor,
  requireReseller,
  requireCustomer,
};
