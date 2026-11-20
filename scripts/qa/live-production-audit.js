'use strict';

/**
 * Live Production Business Acceptance Testing Runner
 * Tests live behavior on https://mrtumi.com without destructive writes or real payments.
 */

const https = require('https');
const http = require('http');

const baseUrl = process.argv[2] || process.env.APP_URL || 'https://mrtumi.com';

function request(urlPath, options = {}) {
  return new Promise((resolve) => {
    const fullUrl = new URL(urlPath, baseUrl).toString();
    const parsed = new URL(fullUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();

    const req = client.request(fullUrl, {
      method: options.method || 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'MrTumi-ProductionAudit/1.0',
        ...(options.headers || {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          path: urlPath,
          fullUrl,
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          latency: Date.now() - start,
          setCookie: res.headers['set-cookie'] || []
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ path: urlPath, fullUrl, statusCode: 0, latency: 10000, error: 'TIMEOUT', body: '' });
    });

    req.on('error', (err) => {
      resolve({ path: urlPath, fullUrl, statusCode: 0, latency: Date.now() - start, error: err.message, body: '' });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function auditProduction() {
  console.log(`Starting Live Production Business Acceptance Testing against: ${baseUrl}\n`);
  const results = {
    storefront: {},
    catalog: {},
    portalsAuth: {},
    cartCheckout: {},
    tracking: {},
    securityHeaders: {},
    discoveredLinks: {}
  };

  // 1. Storefront & Customer Account
  console.log('1. Checking Storefront and Public Pages...');
  const publicRoutes = [
    '/',
    '/all-products',
    '/flash-sales',
    '/cart',
    '/customer/checkout',
    '/track-order',
    '/customer/login',
    '/customer/register',
    '/customer/recovery',
    '/customer/recovery/reset',
    '/admin/login',
    '/vendor/login',
    '/vendor/register',
    '/reseller/login',
    '/reseller/register'
  ];

  for (const r of publicRoutes) {
    const res = await request(r);
    const hasCsrf = res.body.includes('_csrf') || res.body.includes('csrf-token');
    const hasInternalError = res.body.includes('Internal Server Error');
    console.log(`  ${res.statusCode === 200 ? '✔' : '✖'} [${res.statusCode}] ${r.padEnd(26)} (${res.latency}ms, length: ${res.body.length}, csrf: ${hasCsrf ? 'yes' : 'no'})`);
    results.storefront[r] = {
      status: res.statusCode,
      latency: res.latency,
      hasCsrf,
      hasInternalError,
      bodyLength: res.body.length
    };

    if (r === '/') {
      // Extract product and category links
      const prodMatches = [...res.body.matchAll(/href=["'](\/product\/[^"'\s]+)["']/g)].map(m => m[1]);
      const catMatches = [...res.body.matchAll(/href=["'](\/category\/[^"'\s]+)["']/g)].map(m => m[1]);
      results.discoveredLinks.products = [...new Set(prodMatches)];
      results.discoveredLinks.categories = [...new Set(catMatches)];
      console.log(`     Discovered ${results.discoveredLinks.products.length} product links and ${results.discoveredLinks.categories.length} category links on homepage.`);
    }
  }

  // 2. Product Detail & Variant System Verification
  console.log('\n2. Checking Product Detail, Variants & Units...');
  if (results.discoveredLinks.products.length > 0) {
    const sampleProduct = results.discoveredLinks.products[0];
    const prodRes = await request(sampleProduct);
    const hasVariants = prodRes.body.includes('variant') || prodRes.body.includes('data-variant') || prodRes.body.includes('size') || prodRes.body.includes('unit');
    const hasAddToCart = prodRes.body.includes('add-to-cart') || prodRes.body.includes('কার্টে যোগ করুন') || prodRes.body.includes('কার্ট');
    const hasPrice = prodRes.body.includes('৳') || prodRes.body.includes('price');
    console.log(`  Sample Product: ${sampleProduct}`);
    console.log(`  Status: ${prodRes.statusCode}, Price Present: ${hasPrice}, Add-To-Cart: ${hasAddToCart}, Variant/Unit Indicators: ${hasVariants}`);
    results.catalog.sampleProduct = {
      path: sampleProduct,
      statusCode: prodRes.statusCode,
      hasPrice,
      hasAddToCart,
      hasVariants
    };
  } else {
    console.log('  No specific product links found on homepage; testing /all-products...');
    const allProdRes = await request('/all-products');
    const allProdMatches = [...allProdRes.body.matchAll(/href=["'](\/product\/[^"'\s]+)["']/g)].map(m => m[1]);
    console.log(`  Discovered ${allProdMatches.length} products on /all-products.`);
    if (allProdMatches.length > 0) {
      const sample = allProdMatches[0];
      const prodRes = await request(sample);
      console.log(`  Sample Product: ${sample} -> [${prodRes.statusCode}] length: ${prodRes.body.length}`);
    }
  }

  // 3. Security Headers Verification
  console.log('\n3. Checking Security Headers & Cookie Policies...');
  const rootRes = await request('/');
  const headers = rootRes.headers;
  results.securityHeaders = {
    xFrameOptions: headers['x-frame-options'] || 'MISSING',
    xContentTypeOptions: headers['x-content-type-options'] || 'MISSING',
    strictTransportSecurity: headers['strict-transport-security'] || 'MISSING',
    contentSecurityPolicy: headers['content-security-policy'] || 'NOT_CONFIGURED',
    cookies: rootRes.setCookie
  };
  console.log(`  X-Frame-Options: ${results.securityHeaders.xFrameOptions}`);
  console.log(`  X-Content-Type-Options: ${results.securityHeaders.xContentTypeOptions}`);
  console.log(`  Strict-Transport-Security: ${results.securityHeaders.strictTransportSecurity}`);
  console.log(`  Set-Cookie Count: ${rootRes.setCookie.length}`);
  if (rootRes.setCookie.length > 0) {
    for (const c of rootRes.setCookie) {
      const isHttpOnly = c.toLowerCase().includes('httponly');
      const isSecure = c.toLowerCase().includes('secure');
      const sameSite = c.match(/samesite=([^;]+)/i)?.[1] || 'none';
      console.log(`    Cookie: HttpOnly=${isHttpOnly}, Secure=${isSecure}, SameSite=${sameSite}`);
    }
  }

  // 4. Cart & Checkout Form Validation
  console.log('\n4. Checking Cart & Checkout Behavior...');
  const checkoutRes = await request('/customer/checkout');
  const hasDeliveryAreas = checkoutRes.body.includes('ঢাকার ভিতরে') || checkoutRes.body.includes('ঢাকার বাইরে') || checkoutRes.body.includes('delivery');
  const hasPaymentMethods = checkoutRes.body.includes('Cash On Delivery') || checkoutRes.body.includes('cod') || checkoutRes.body.includes('bKash') || checkoutRes.body.includes('ক্যাশ অন ডেলিভারি');
  const hasOtpModal = checkoutRes.body.includes('otp') || checkoutRes.body.includes('ওটিপি');
  const hasCustomerFields = checkoutRes.body.includes('phone') && checkoutRes.body.includes('address');
  console.log(`  Checkout Page: [${checkoutRes.statusCode}] Delivery Areas: ${hasDeliveryAreas}, Payment Options: ${hasPaymentMethods}, OTP Guard: ${hasOtpModal}, Form Fields: ${hasCustomerFields}`);

  // 5. Protected Portals Access Control Verification (Without Credentials)
  console.log('\n5. Checking Portal Access Control (Unauthenticated Redirects)...');
  const protectedRoutes = [
    '/admin/dashboard',
    '/admin/orders',
    '/admin/products',
    '/admin/categories',
    '/admin/brands',
    '/admin/reseller-withdrawals',
    '/admin/vendor-withdrawals',
    '/vendor/dashboard',
    '/vendor/products',
    '/vendor/orders',
    '/vendor/withdrawals',
    '/reseller/dashboard',
    '/reseller/products',
    '/reseller/orders',
    '/reseller/withdrawals',
    '/reseller/transactions',
    '/customer/account',
    '/customer/account/orders'
  ];

  for (const pr of protectedRoutes) {
    const res = await request(pr);
    // Should redirect to login or return 302/401/403
    const isProtected = res.statusCode === 302 || res.statusCode === 401 || res.statusCode === 403;
    const location = res.headers['location'] || '';
    console.log(`  ${isProtected ? '✔' : '✖'} [${res.statusCode}] ${pr.padEnd(30)} -> Redirect to: ${location || 'NONE'}`);
  }

  // 6. Test Order Tracking Endpoint
  console.log('\n6. Checking Order Tracking Endpoint (/track-order)...');
  const trackRes = await request('/track-order?invoice=MT-NONEXISTENT-99999');
  const trackHandled = trackRes.statusCode === 200 && !trackRes.body.includes('Internal Server Error');
  console.log(`  Tracking lookup query handled safely: [${trackRes.statusCode}] (no 500 crash: ${trackHandled})`);

  console.log('\n====================================================');
  console.log('Production Business Acceptance Probe Complete.');
  console.log('====================================================');
}

auditProduction().catch(err => {
  console.error('Audit failed with unexpected error:', err);
  process.exit(1);
});
