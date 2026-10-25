const db = require('../db/database');

function attachGlobals(req, res, next) {
  try {
    const settings = db.getSettings();
    res.locals.siteSettings = settings;
    res.locals.sessionToken = req.sessionID || '';
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;
    res.locals.adminUser = req.session.adminUser || null;
    res.locals.vendorUser = req.session.vendorUser || null;
    res.locals.resellerUser = req.session.resellerUser || null;
    res.locals.customerUser = req.session.customerUser || null;

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

    // Categories & CMS pages for storefront header/footer
    res.locals.navCategories = db.all(
      'SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC, id ASC'
    );
    res.locals.footerPages = db.all(
      'SELECT title, slug FROM cms_pages WHERE status = 1 ORDER BY id ASC'
    );
    res.locals.storeFeatures = db.all(
      'SELECT * FROM features WHERE status = 1 ORDER BY id ASC'
    );
    res.locals.socialLinks = db.all(
      'SELECT * FROM social_links WHERE status = 1 ORDER BY id ASC'
    );

    // Admin topbar & sidebar live badges
    if (req.path.startsWith('/admin')) {
      res.locals.pendingOrdersCount =
        db.get("SELECT COUNT(*) AS cnt FROM orders WHERE status = 'pending'")?.cnt || 0;
      res.locals.pendingOrdersList = db.all(
        "SELECT id, invoice_id, customer_name, amount, created_at FROM orders WHERE status = 'pending' ORDER BY id DESC LIMIT 10"
      );
      res.locals.pendingReviewsCount =
        db.get("SELECT COUNT(*) AS cnt FROM reviews WHERE status = 'pending'")?.cnt || 0;
    }

    // Refresh live vendor/reseller balance if logged in
    if (req.path.startsWith('/vendor') && req.session.vendorUser) {
      const freshV = db.get('SELECT * FROM vendors WHERE id = ?', req.session.vendorUser.id);
      if (freshV) res.locals.vendorUser = freshV;
    }
    if (req.path.startsWith('/reseller') && req.session.resellerUser) {
      const freshR = db.get('SELECT * FROM resellers WHERE id = ?', req.session.resellerUser.id);
      if (freshR) res.locals.resellerUser = freshR;
    }
  } catch (err) {
    console.error('Error attaching globals:', err);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminUser) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/admin/login');
  }
  next();
}

function requireVendor(req, res, next) {
  if (!req.session || !req.session.vendorUser) {
    return res.redirect('/vendor/login');
  }
  next();
}

function requireReseller(req, res, next) {
  if (!req.session || !req.session.resellerUser) {
    return res.redirect('/reseller/login');
  }
  next();
}

module.exports = {
  attachGlobals,
  requireAdmin,
  requireVendor,
  requireReseller,
};
