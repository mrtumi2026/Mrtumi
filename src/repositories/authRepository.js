'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const sqliteDb = require('../db/database');
const { paisaToBdtString } = require('../utils/money');

function isMysqlMode(config = env) {
  return config.db.client === 'mysql';
}

function getClient(poolOverride = null) {
  return createQueryClient(poolOverride || getPool());
}

async function loadRolePermissionsMysql(roleId, client) {
  if (!roleId) return [];
  const rows = await client.queryAll(
    `SELECT p.\`name\`
     FROM \`role_permissions\` rp
     INNER JOIN \`permissions\` p ON p.\`id\` = rp.\`permission_id\`
     WHERE rp.\`role_id\` = ?`,
    [roleId]
  );
  return rows.map((r) => r.name);
}

async function findActiveAdminByEmail(email, poolOverride = null, config = env) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return null;

  if (!isMysqlMode(config) && !poolOverride) {
    const user = sqliteDb.get(
      'SELECT * FROM users WHERE LOWER(email) = ? AND status = 1',
      cleanEmail
    );
    if (!user) return null;
    const roleName = user.role || 'Super Admin';
    return {
      ...user,
      role: roleName,
      role_name: roleName,
      role_slug: String(roleName).toLowerCase().replace(/\s+/g, '_'),
      avatar: user.avatar || '/uploads/default/user.svg',
      permissions: [],
    };
  }

  const client = getClient(poolOverride);
  const user = await client.queryOne(
    `SELECT u.*, r.\`name\` AS role_name, r.\`slug\` AS role_slug
     FROM \`users\` u
     LEFT JOIN \`roles\` r ON r.\`id\` = u.\`role_id\`
     WHERE LOWER(u.\`email\`) = ? AND u.\`status\` = 1
     LIMIT 1`,
    [cleanEmail]
  );
  if (!user) return null;
  const permissions = await loadRolePermissionsMysql(user.role_id, client);
  const roleLabel = user.role_name || user.role_label || 'Staff';
  return {
    ...user,
    role: roleLabel,
    role_name: roleLabel,
    role_slug: user.role_slug || String(roleLabel).toLowerCase().replace(/\s+/g, '_'),
    avatar: user.avatar_url || '/uploads/default/user.svg',
    permissions,
  };
}

async function findActiveAdminById(id, poolOverride = null, config = env) {
  if (!id) return null;

  if (!isMysqlMode(config) && !poolOverride) {
    const user = sqliteDb.get('SELECT * FROM users WHERE id = ? AND status = 1', id);
    if (!user) return null;
    const roleName = user.role || 'Super Admin';
    return {
      ...user,
      role: roleName,
      role_name: roleName,
      role_slug: String(roleName).toLowerCase().replace(/\s+/g, '_'),
      avatar: user.avatar || '/uploads/default/user.svg',
      permissions: [],
    };
  }

  const client = getClient(poolOverride);
  const user = await client.queryOne(
    `SELECT u.*, r.\`name\` AS role_name, r.\`slug\` AS role_slug
     FROM \`users\` u
     LEFT JOIN \`roles\` r ON r.\`id\` = u.\`role_id\`
     WHERE u.\`id\` = ? AND u.\`status\` = 1
     LIMIT 1`,
    [id]
  );
  if (!user) return null;
  const permissions = await loadRolePermissionsMysql(user.role_id, client);
  const roleLabel = user.role_name || user.role_label || 'Staff';
  return {
    ...user,
    role: roleLabel,
    role_name: roleLabel,
    role_slug: user.role_slug || String(roleLabel).toLowerCase().replace(/\s+/g, '_'),
    avatar: user.avatar_url || '/uploads/default/user.svg',
    permissions,
  };
}

async function recordAdminLoginSuccess(userId, poolOverride = null, config = env) {
  if (!userId) return;
  if (!isMysqlMode(config) && !poolOverride) {
    return;
  }
  const client = getClient(poolOverride);
  await client.execute(
    'UPDATE `users` SET `last_login_at` = UTC_TIMESTAMP() WHERE `id` = ?',
    [userId]
  );
}

async function findVendorById(id, poolOverride = null, config = env) {
  if (!id) return null;
  if (!isMysqlMode(config) && !poolOverride) {
    return sqliteDb.get('SELECT * FROM vendors WHERE id = ?', id) || null;
  }
  const client = getClient(poolOverride);
  return client.queryOne('SELECT * FROM `vendors` WHERE `id` = ? LIMIT 1', [id]);
}

async function findResellerById(id, poolOverride = null, config = env) {
  if (!id) return null;
  if (!isMysqlMode(config) && !poolOverride) {
    return sqliteDb.get('SELECT id,name,shop_name,phone,email,verified,status FROM resellers WHERE id = ? AND status = 1', id) || null;
  }
  const client = getClient(poolOverride);
  return client.queryOne('SELECT `id`,`name`,`shop_name`,`phone`,`email`,`verified`,`status` FROM `resellers` WHERE `id` = ? AND `status` = 1 LIMIT 1', [id]);
}

async function findCustomerById(id, poolOverride = null, config = env) {
  if (!id) return null;
  if (!isMysqlMode(config) && !poolOverride) {
    return sqliteDb.get('SELECT * FROM customers WHERE id = ?', id) || null;
  }
  const client = getClient(poolOverride);
  return client.queryOne('SELECT * FROM `customers` WHERE `id` = ? LIMIT 1', [id]);
}

async function loadLayoutNavigationContext(isAdminPath = false, poolOverride = null, config = env) {
  if (!isMysqlMode(config) && !poolOverride) {
    const rawCats = sqliteDb.all(
      'SELECT * FROM categories WHERE status = 1 ORDER BY sort_order ASC, id ASC'
    );
    const rawSubcats = sqliteDb.all(
      'SELECT * FROM subcategories WHERE status = 1 ORDER BY id ASC'
    );
    const subByCat = new Map();
    for (const sc of rawSubcats) {
      const cid = Number(sc.category_id);
      if (!subByCat.has(cid)) subByCat.set(cid, []);
      subByCat.get(cid).push(sc);
    }
    const navCategories = rawCats.map((c) => ({
      ...c,
      subcategories: subByCat.get(Number(c.id)) || [],
    }));
    const footerPages = sqliteDb.all(
      'SELECT title, slug FROM cms_pages WHERE status = 1 ORDER BY id ASC'
    );
    const storeFeatures = sqliteDb.all(
      'SELECT * FROM features WHERE status = 1 ORDER BY id ASC'
    );
    const socialLinks = sqliteDb.all(
      'SELECT * FROM social_links WHERE status = 1 ORDER BY id ASC'
    );
    let pendingOrdersCount = 0;
    let pendingOrdersList = [];
    let pendingReviewsCount = 0;
    if (isAdminPath) {
      pendingOrdersCount =
        sqliteDb.get("SELECT COUNT(*) AS cnt FROM orders WHERE status = 'pending'")?.cnt || 0;
      pendingOrdersList = sqliteDb.all(
        "SELECT id, invoice_id, customer_name, amount, created_at FROM orders WHERE status = 'pending' ORDER BY id DESC LIMIT 10"
      );
      pendingReviewsCount =
        sqliteDb.get("SELECT COUNT(*) AS cnt FROM reviews WHERE status = 'pending'")?.cnt || 0;
    }
    return {
      navCategories,
      footerPages,
      storeFeatures,
      socialLinks,
      pendingOrdersCount,
      pendingOrdersList,
      pendingReviewsCount,
    };
  }

  const client = getClient(poolOverride);
  const [rawCats, rawSubcats, footerPages, storeFeatures, socialLinks] = await Promise.all([
    client.queryAll(
      'SELECT `id`, `name_bn` AS `name`, `name_bn`, `name_en`, `slug`, `icon`, `image_url` AS `image`, `front_view` FROM `categories` WHERE `status` = 1 ORDER BY `sort_order` ASC, `id` ASC'
    ),
    client.queryAll(
      'SELECT `id`, `category_id`, `name_bn` AS `name`, `name_bn`, `name_en`, `slug` FROM `subcategories` WHERE `status` = 1 ORDER BY `id` ASC'
    ),
    client.queryAll(
      'SELECT `title_bn` AS `title`, `title_bn`, `title_en`, `slug` FROM `cms_pages` WHERE `status` = 1 ORDER BY `id` ASC'
    ),
    client.queryAll(
      'SELECT `id`, `title_bn` AS `title`, `title_bn`, `title_en`, `subtitle_bn` AS `subtitle`, `subtitle_bn`, `subtitle_en`, `icon`, `status` FROM `features` WHERE `status` = 1 ORDER BY `id` ASC'
    ),
    client.queryAll('SELECT * FROM `social_links` WHERE `status` = 1 ORDER BY `id` ASC'),
  ]);

  const subByCat = new Map();
  for (const sc of rawSubcats) {
    const cid = Number(sc.category_id);
    if (!subByCat.has(cid)) subByCat.set(cid, []);
    subByCat.get(cid).push(sc);
  }
  const navCategories = rawCats.map((c) => ({
    ...c,
    subcategories: subByCat.get(Number(c.id)) || [],
  }));

  let pendingOrdersCount = 0;
  let pendingOrdersList = [];
  let pendingReviewsCount = 0;
  if (isAdminPath) {
    const [pendingRow, rawOrders, reviewsRow] = await Promise.all([
      client.queryOne("SELECT COUNT(*) AS cnt FROM `orders` WHERE `order_status` = 'pending'"),
      client.queryAll(
        "SELECT `id`, `invoice_no` AS `invoice_id`, `customer_name`, `total_paisa`, `created_at` FROM `orders` WHERE `order_status` = 'pending' ORDER BY `id` DESC LIMIT 10"
      ),
      client.queryOne("SELECT COUNT(*) AS cnt FROM `reviews` WHERE `status` = 'pending'"),
    ]);
    pendingOrdersCount = Number(pendingRow?.cnt || 0);
    pendingOrdersList = rawOrders.map((o) => ({
      ...o,
      amount: Number(paisaToBdtString(Number(o.total_paisa || 0))),
    }));
    pendingReviewsCount = Number(reviewsRow?.cnt || 0);
  }

  return {
    navCategories,
    footerPages,
    storeFeatures,
    socialLinks,
    pendingOrdersCount,
    pendingOrdersList,
    pendingReviewsCount,
  };
}

module.exports = {
  findActiveAdminByEmail,
  findActiveAdminById,
  recordAdminLoginSuccess,
  findVendorById,
  findResellerById,
  findCustomerById,
  loadLayoutNavigationContext,
};
