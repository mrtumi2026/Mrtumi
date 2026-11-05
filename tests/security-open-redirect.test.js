'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeReferrer } = require('../src/utils/urlSecurity');
const { app } = require('../server');

test('safeReferrer unit tests: open redirect prevention and edge cases', () => {
  // 1. External malicious URLs must fail closed to fallback
  const mockReqEvil = {
    get(header) {
      if (/referer|referrer/i.test(header)) return 'https://attacker.evil.com/phish?target=mrtumi';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqEvil, '/contact'), '/contact', 'Must block external domain and return fallback');
  assert.equal(safeReferrer(mockReqEvil, '/'), '/', 'Must block external domain and return root fallback');

  // 2. Protocol-relative URLs ('//evil.com') must fail closed
  const mockReqProtoRel = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '//evil.com/steal-creds';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqProtoRel, '/contact'), '/contact', 'Must block protocol-relative URL');

  // 3. Same-host absolute URL whose extracted pathname starts with '//' (CRITICAL ARENA AUDIT FINDING)
  const mockReqSameHostProtoRel = {
    get(header) {
      if (/referer|referrer/i.test(header)) return 'https://mrtumi.com//evil.com/phishing';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqSameHostProtoRel, '/contact'), '/contact', 'Must reject same-host URL whose pathname begins with //');
  assert.equal(safeReferrer(mockReqSameHostProtoRel, '/'), '/', 'Must reject same-host URL whose pathname begins with // for root fallback');

  // 4. Backslash evasion ('/\\evil.com' or 'https://mrtumi.com/\\evil.com') must fail closed
  const mockReqBackslash = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/\\evil.com';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqBackslash, '/contact'), '/contact', 'Must block backslash relative evasion');

  const mockReqSameHostBackslash = {
    get(header) {
      if (/referer|referrer/i.test(header)) return 'https://mrtumi.com/\\evil.com';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqSameHostBackslash, '/contact'), '/contact', 'Must block backslash in same-host URL');

  // 5. CRLF injection attempt must fail closed
  const mockReqCrlf = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/contact\r\nSet-Cookie: session=evil';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqCrlf, '/contact'), '/contact', 'Must block CRLF in referrer');

  // 6. Valid relative internal path must be preserved
  const mockReqValidRel = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/products/fresh-mango?category=fruits';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqValidRel, '/contact'), '/products/fresh-mango?category=fruits', 'Must allow valid relative internal path');

  // 7. Absolute URL matching exact Host header with normal path must be converted to safe relative path
  const mockReqMatchingHost = {
    get(header) {
      if (/referer|referrer/i.test(header)) return 'https://mrtumi.com/contact?step=2';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqMatchingHost, '/contact'), '/contact?step=2', 'Must extract relative path from same-origin absolute URL');

  // 8. Missing or empty referrer must return fallback
  const mockReqEmpty = {
    get() { return null; }
  };
  assert.equal(safeReferrer(mockReqEmpty, '/contact'), '/contact');
  assert.equal(safeReferrer(mockReqEmpty, '/'), '/');
});

test('HTTP integration: open redirect prevention across contact, newsletter, review, and wishlist routes', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;

  try {
    // 1. POST /api/newsletter with external Referer
    const newsRes = await fetch(`${baseUrl}/api/newsletter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://evil-attacker.com/malicious-login',
        'Host': host
      },
      body: 'email_or_phone=test_subscriber@example.com',
      redirect: 'manual'
    });
    assert.equal(newsRes.status, 302);
    const newsLoc = (newsRes.headers.get('location') || '').split('?')[0];
    assert.equal(newsLoc, '/', 'Newsletter with external Referer must redirect to /');

    // 2. POST /api/newsletter with same-host protocol-relative '//evil.com'
    const newsSameHostEvil = await fetch(`${baseUrl}/api/newsletter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `http://${host}//evil.com/phishing`,
        'Host': host
      },
      body: 'email_or_phone=test_subscriber@example.com',
      redirect: 'manual'
    });
    assert.equal(newsSameHostEvil.status, 302);
    const newsEvilLoc = (newsSameHostEvil.headers.get('location') || '').split('?')[0];
    assert.equal(newsEvilLoc, '/', 'Newsletter with same-host //evil must fail closed to /');

    // 3. POST /api/contact with external Referer
    const contactRes = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://attacker.site/phishing',
        'Host': host
      },
      body: 'name=Test+User&phone=01711111111&email=test@example.com&subject=Inquiry&message=Hello+World',
      redirect: 'manual'
    });
    assert.equal(contactRes.status, 302);
    const contactLoc = (contactRes.headers.get('location') || '').split('?')[0];
    assert.equal(contactLoc, '/contact', 'Contact with external Referer must redirect to /contact');

    // 4. POST /api/contact with same-host protocol-relative '//evil.com'
    const contactSameHostEvil = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `http://${host}//attacker.site/phishing`,
        'Host': host
      },
      body: 'name=Test+User&phone=01711111111&email=test@example.com&subject=Inquiry&message=Hello+World',
      redirect: 'manual'
    });
    assert.equal(contactSameHostEvil.status, 302);
    const contactEvilLoc = (contactSameHostEvil.headers.get('location') || '').split('?')[0];
    assert.equal(contactEvilLoc, '/contact', 'Contact with same-host //attacker must fail closed to /contact');

    // 5. POST /api/review validation failure with same-host protocol-relative Referer
    const reviewRes = await fetch(`${baseUrl}/api/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `http://${host}//malicious.com/steal`,
        'Host': host
      },
      body: 'product_id=&rating=&comment=',
      redirect: 'manual'
    });
    assert.equal(reviewRes.status, 302);
    const reviewLoc = (reviewRes.headers.get('location') || '').split('?')[0];
    assert.equal(reviewLoc, '/all-products', 'Review failure must fail closed to /all-products');

    // 6. POST /customer/account/wishlist/add without CSRF (or invalid product) with malicious Referer
    // First obtain session and CSRF
    const sessionRes = await fetch(`${baseUrl}/customer/account/wishlist`, {
      headers: { 'Host': host }
    });
    const setCookie = sessionRes.headers.get('set-cookie');
    const html = await sessionRes.text();
    const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';

    const wishlistRes = await fetch(`${baseUrl}/customer/account/wishlist/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `http://${host}//evil-phish.com`,
        'Host': host,
        ...(setCookie ? { 'Cookie': setCookie } : {})
      },
      body: `product_id=9999&_csrf=${encodeURIComponent(csrfToken)}`,
      redirect: 'manual'
    });
    assert.equal(wishlistRes.status, 302);
    const wishLoc = (wishlistRes.headers.get('location') || '').split('?')[0];
    assert.equal(wishLoc, '/customer/account/wishlist', 'Wishlist add with //evil must fail closed to /customer/account/wishlist');

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
