'use strict';

/**
 * Live Production Business Acceptance Testing Runner
 * Tests live behavior on https://mrtumi.com across:
 * - Public Store Page (/store/:slug)
 * - Product Card Store Attribution (Vendor vs Mr. Tumi Select)
 * - Product Details Sold By & Seller Card
 * - Vendor Dashboard (/vendor/profile redirects to login when unauth)
 * - Admin Vendors (/admin/vendors redirects to login when unauth)
 * - XML Sitemap (/sitemap.xml contains /store/)
 * - Robots.txt (/robots.txt)
 * - Existing Cart & Checkout
 * - Live Health (/health)
 */

const https = require('https');

const baseUrl = 'https://mrtumi.com';

function fetch(urlPath) {
  return new Promise((resolve) => {
    const fullUrl = new URL(urlPath, baseUrl).toString();
    const start = Date.now();
    https.get(fullUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'MrTumi-AcceptanceVerifier/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          path: urlPath,
          status: res.statusCode,
          headers: res.headers,
          latency: Date.now() - start,
          body
        });
      });
    }).on('error', (err) => {
      resolve({ path: urlPath, status: 0, error: err.message, latency: Date.now() - start, body: '' });
    });
  });
}

async function verifyLive() {
  console.log('=== RUNNING LIVE PRODUCTION ACCEPTANCE PROBE ===\n');

  const [
    health,
    home,
    allProducts,
    lycheeProduct,
    storeDinajpur,
    storeInvalid,
    sitemap,
    robots,
    cart,
    checkout,
    vendorProfile,
    adminVendors
  ] = await Promise.all([
    fetch('/health'),
    fetch('/'),
    fetch('/all-products'),
    fetch('/product/deshi-lychee-fresh-pack'),
    fetch('/store/store-1'),
    fetch('/store/non-existent-store-slug-999'),
    fetch('/sitemap.xml'),
    fetch('/robots.txt'),
    fetch('/cart'),
    fetch('/customer/checkout'),
    fetch('/vendor/profile'),
    fetch('/admin/vendors')
  ]);

  console.log('1. Production Health API:');
  console.log(`   Status: [${health.status}] - Latency: ${health.latency}ms`);
  console.log(`   Response: ${health.body}\n`);

  console.log('2. Storefront Home & All Products:');
  console.log(`   Home: [${home.status}] (${home.body.length} bytes, ${home.latency}ms)`);
  console.log(`   All Products: [${allProducts.status}] (${allProducts.body.length} bytes)`);
  const hasStoreAttribution = allProducts.body.includes('/store/') || allProducts.body.includes('Mr. Tumi Select');
  console.log(`   Product Cards have Store Attribution: ${hasStoreAttribution ? 'YES ✔' : 'NO (Pending Deployment)'}\n`);

  console.log('3. Product Detail Page Attribution:');
  console.log(`   Deshi Lychee Pack: [${lycheeProduct.status}] (${lycheeProduct.body.length} bytes)`);
  const hasSoldBy = lycheeProduct.body.includes('Sold by') || lycheeProduct.body.includes('বিক্রেতা');
  const hasSellerBox = lycheeProduct.body.includes('Mr. Tumi Select') || lycheeProduct.body.includes('/store/');
  console.log(`   Has "Sold by" or "বিক্রেতা": ${hasSoldBy ? 'YES ✔' : 'NO'}`);
  console.log(`   Has Seller Identity Card: ${hasSellerBox ? 'YES ✔' : 'NO'}\n`);

  console.log('4. Dedicated Vendor Store Page (/store/:slug):');
  console.log(`   /store/store-1: [${storeDinajpur.status}] (Expected 200 after migration, currently ${storeDinajpur.status})`);
  console.log(`   /store/non-existent-store-slug-999: [${storeInvalid.status}] (Expected 404)\n`);

  console.log('5. SEO Sitemaps & Robots:');
  console.log(`   Sitemap: [${sitemap.status}] - Contains /store/ URLs: ${sitemap.body.includes('/store/') ? 'YES ✔' : 'NO'}`);
  console.log(`   Robots.txt: [${robots.status}] - Disallow admin/vendor/cart: ${robots.body.includes('Disallow: /admin/') ? 'YES ✔' : 'NO'}\n`);

  console.log('6. Commerce Protection (Cart & Checkout):');
  console.log(`   Cart: [${cart.status}]`);
  console.log(`   Checkout: [${checkout.status}] (Redirects or renders safely)\n`);

  console.log('7. Portal Auth & Route Protection:');
  console.log(`   Vendor Profile: [${vendorProfile.status}] (Expected 302/redirect to login)`);
  console.log(`   Admin Vendors: [${adminVendors.status}] (Expected 302/redirect to login)\n`);

  const isLiveBrandingActive = storeDinajpur.status === 200 || hasStoreAttribution;
  console.log(`Overall Live Status: ${isLiveBrandingActive ? 'LIVE & ACTIVE ✔' : 'DEPLOYMENT PENDING ON CPANEL'}`);
}

verifyLive();
