'use strict';

const https = require('https');
const http = require('http');

const baseUrl = 'https://mrtumi.com';

function fetchUrl(urlPath) {
  return new Promise((resolve) => {
    const fullUrl = urlPath.startsWith('http') ? urlPath : new URL(urlPath, baseUrl).toString();
    const parsed = new URL(fullUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(fullUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'MrTumi-CatalogInspector/1.0' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          url: fullUrl,
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: fullUrl, statusCode: 0, body: '', error: 'TIMEOUT' });
    });

    req.on('error', (err) => {
      resolve({ url: fullUrl, statusCode: 0, body: '', error: err.message });
    });
  });
}

async function runInspection() {
  console.log('=== MR TUMI LIVE CATALOG & BUSINESS SETTINGS INSPECTION ===\n');

  // 1. Inspect Homepage for Settings & Global Navigation
  console.log('Fetching Homepage...');
  const home = await fetchUrl('/');
  if (home.statusCode !== 200) {
    console.error(`Failed to fetch homepage: status ${home.statusCode}`);
    return;
  }

  // Extract Contacts & Branding
  console.log('\n--- 1. Business Branding & Contacts Found on Storefront ---');
  const phoneMatches = home.body.match(/(\+?880?1[3-9]\d{8}|01[3-9]\d{8}|01\d{3}-\d{6})/g) || [];
  const emailMatches = home.body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  console.log('Phones/Hotlines:', [...new Set(phoneMatches)]);
  console.log('Emails:', [...new Set(emailMatches)]);

  // Look for WhatsApp link
  const waMatches = [...home.body.matchAll(/href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com)[^"'\s]+)["']/g)].map(m => m[1]);
  console.log('WhatsApp links:', [...new Set(waMatches)]);

  // Look for Address
  const addressMatch = home.body.match(/<address[^>]*>([\s\S]*?)<\/address>/i) ||
                       home.body.match(/(?:House|Road|Dhanmondi|Dhaka|ঠিকানা)[\s\S]{0,100}/i);
  if (addressMatch) {
    console.log('Address snippet:', addressMatch[0].replace(/<[^>]+>/g, '').trim().slice(0, 150));
  }

  // 2. Extract All Categories & Subcategories
  console.log('\n--- 2. Categories Found on Storefront ---');
  const catMatches = [...home.body.matchAll(/href=["'](\/category\/([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/g)];
  const categories = new Map();
  for (const m of catMatches) {
    const slug = m[2];
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    if (!categories.has(slug) && text) {
      categories.set(slug, text);
    }
  }
  console.log(`Found ${categories.size} unique categories in navigation:`);
  for (const [slug, name] of categories.entries()) {
    console.log(`  - ${slug}: "${name}"`);
  }

  // 3. Extract All Products from Homepage and /all-products
  console.log('\n--- 3. Scanning for All Products on Storefront ---');
  const allProductsPage = await fetchUrl('/all-products');
  const flashSalesPage = await fetchUrl('/flash-sales');

  const combinedHtml = home.body + ' ' + allProductsPage.body + ' ' + flashSalesPage.body;
  const prodMatches = [...combinedHtml.matchAll(/href=["'](\/product\/([a-zA-Z0-9_-]+))["']/g)];
  const productSlugs = [...new Set(prodMatches.map(m => m[2]))];
  console.log(`Found ${productSlugs.length} unique products on catalog pages:`, productSlugs);

  // 4. Detailed Inspection for Each Product
  console.log('\n--- 4. Detailed Inspection for Each Product ---');
  const productDetails = [];

  for (const slug of productSlugs) {
    const prodRes = await fetchUrl(`/product/${slug}`);
    if (prodRes.statusCode !== 200) {
      console.log(`Product /product/${slug}: FAILED (status ${prodRes.statusCode})`);
      continue;
    }

    const html = prodRes.body;
    
    // Title
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown Title';

    // Prices
    const priceMatches = [...html.matchAll(/৳\s*([0-9,]+(?:\.[0-9]+)?)/g)].map(m => m[1]);
    
    // Images
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)]
      .map(m => m[1])
      .filter(src => src.includes('/uploads/') || src.includes('product') || src.includes('cdn'));

    // Category / Breadcrumb
    const breadcrumbMatches = [...html.matchAll(/<li[^>]*class=["'][^"']*breadcrumb-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    // Variants / Units
    const unitMatches = html.match(/(?:কেজি|গ্রাম|লিটার|মিলি|পিস|ডজন|বক্স|প্যাকেট|kg|g|litre|ml|pcs|piece|dozen|packet|box)/gi) || [];
    const variantSelect = html.match(/<select[^>]*name=["'](?:variant|size|unit)[^"']*["'][^>]*>([\s\S]*?)<\/select>/i);
    const variantOptions = variantSelect ? [...variantSelect[1].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)].map(m => m[1].trim()) : [];

    // Stock
    const stockMatch = html.match(/(?:ইন স্টক|আউট অব স্টক|স্টক|Stock|In Stock|Out of Stock)[\s\S]{0,40}/i);

    // SKU
    const skuMatch = html.match(/SKU:\s*([A-Za-z0-9_-]+)/i);

    // Form inputs and action
    const formActionMatch = html.match(/<form[^>]+action=["']([^"']+)["'][^>]*>/i);
    const hiddenInputs = [...html.matchAll(/<input[^>]+type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi)]
      .map(m => `${m[1]}=${m[2]}`);

    // Check images HTTP status
    const imageStatuses = [];
    for (const imgUrl of [...new Set(imgMatches)].slice(0, 3)) {
      const imgRes = await fetchUrl(imgUrl);
      imageStatuses.push({ url: imgUrl, status: imgRes.statusCode });
    }

    const detail = {
      slug,
      title,
      breadcrumb: breadcrumbMatches,
      prices: [...new Set(priceMatches)],
      unitsFound: [...new Set(unitMatches)],
      variantOptions,
      stockSnippet: stockMatch ? stockMatch[0].replace(/<[^>]+>/g, '').trim() : 'Not visible',
      sku: skuMatch ? skuMatch[1] : 'N/A',
      formAction: formActionMatch ? formActionMatch[1] : 'N/A',
      hiddenInputs: hiddenInputs.slice(0, 8),
      images: imageStatuses
    };
    productDetails.push(detail);

    console.log(`\nProduct: ${slug}`);
    console.log(`  Title: ${title}`);
    console.log(`  Breadcrumb: ${breadcrumbMatches.join(' > ')}`);
    console.log(`  SKU: ${detail.sku}`);
    console.log(`  Prices: ${detail.prices.join(', ')}`);
    console.log(`  Units detected: ${detail.unitsFound.join(', ')}`);
    console.log(`  Variant Options: ${variantOptions.length ? variantOptions.join(' | ') : 'None'}`);
    console.log(`  Stock: ${detail.stockSnippet}`);
    console.log(`  Form: ${detail.formAction} (${detail.hiddenInputs.join(', ')})`);
    console.log(`  Images: ${imageStatuses.map(i => `${i.url} [${i.status}]`).join(', ')}`);
  }

  // 5. Checkout Settings Inspection
  console.log('\n--- 5. Checkout Delivery & Payment Settings ---');
  const checkoutRes = await fetchUrl('/customer/checkout');
  if (checkoutRes.statusCode === 200) {
    const chkHtml = checkoutRes.body;
    // Delivery fees
    const insideDhakaMatch = chkHtml.match(/ঢাকার ভিতরে[\s\S]{0,50}৳?\s*([0-9]+)/i);
    const outsideDhakaMatch = chkHtml.match(/ঢাকার বাইরে[\s\S]{0,50}৳?\s*([0-9]+)/i);
    console.log('Inside Dhaka Fee snippet:', insideDhakaMatch ? insideDhakaMatch[0].replace(/<[^>]+>/g, '').trim() : 'Not parsed');
    console.log('Outside Dhaka Fee snippet:', outsideDhakaMatch ? outsideDhakaMatch[0].replace(/<[^>]+>/g, '').trim() : 'Not parsed');

    // Payment methods
    const paymentMethods = [];
    if (chkHtml.includes('Cash On Delivery') || chkHtml.includes('ক্যাশ অন ডেলিভারি')) paymentMethods.push('Cash on Delivery (COD)');
    if (chkHtml.includes('bKash') || chkHtml.includes('বিকাশ')) paymentMethods.push('bKash');
    if (chkHtml.includes('Nagad') || chkHtml.includes('নগদ')) paymentMethods.push('Nagad');
    if (chkHtml.includes('Rocket') || chkHtml.includes('রকেট')) paymentMethods.push('Rocket');
    console.log('Payment Methods available at checkout:', paymentMethods);
  }

  // 6. Policy & Footer Pages
  console.log('\n--- 6. Policy & Footer Pages ---');
  const footerMatch = home.body.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  if (footerMatch) {
    const footerLinks = [...footerMatch[1].matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() }));
    console.log(`Found ${footerLinks.length} links in footer:`);
    for (const l of footerLinks) {
      if (l.text && !l.href.startsWith('javascript')) {
        const pageRes = await fetchUrl(l.href);
        console.log(`  ${l.href} (${l.text}) -> [${pageRes.statusCode}]`);
      }
    }
  }

  console.log('\n=== INSPECTION SCRIPT FINISHED ===');
}

runInspection().catch(err => {
  console.error('Inspection failed:', err);
});
