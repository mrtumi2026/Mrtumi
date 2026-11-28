'use strict';

/**
 * A short fingerprint of the site's own CSS and JS. Views append it to asset
 * URLs so a browser never keeps showing the old design after an update (the
 * web server sends these files without a Cache-Control header).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const ASSET_DIRS = ['frontEnd/css', 'frontEnd/js', 'shared/css', 'shared/js', 'backEnd/css', 'backEnd/js'];

function computeAssetVersion(publicDir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  for (const dir of ASSET_DIRS) {
    const full = path.join(publicDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).sort()) {
      const file = path.join(full, name);
      if (!/\.(css|js)$/.test(name) || !fs.statSync(file).isFile()) continue;
      hash.update(`${dir}/${name}\0`).update(fs.readFileSync(file));
    }
  }
  return hash.digest('hex').slice(0, 10);
}

module.exports = { computeAssetVersion };
