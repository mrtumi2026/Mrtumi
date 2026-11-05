'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeReferrer } = require('../src/utils/urlSecurity');
const { app } = require('../server');

test('safeReferrer unit tests: open redirect prevention', () => {
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

  // 3. Backslash evasion ('/\\evil.com') must fail closed
  const mockReqBackslash = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/\\evil.com';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqBackslash, '/contact'), '/contact', 'Must block backslash evasion');

  // 4. CRLF injection attempt must fail closed
  const mockReqCrlf = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/contact\r\nSet-Cookie: session=evil';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqCrlf, '/contact'), '/contact', 'Must block CRLF in referrer');

  // 5. Valid relative internal path must be preserved
  const mockReqValidRel = {
    get(header) {
      if (/referer|referrer/i.test(header)) return '/products/fresh-mango?category=fruits';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqValidRel, '/contact'), '/products/fresh-mango?category=fruits', 'Must allow valid relative internal path');

  // 6. Absolute URL matching exact Host header must be converted to safe relative path
  const mockReqMatchingHost = {
    get(header) {
      if (/referer|referrer/i.test(header)) return 'https://mrtumi.com/contact?step=2';
      if (/host/i.test(header)) return 'mrtumi.com';
      return null;
    }
  };
  assert.equal(safeReferrer(mockReqMatchingHost, '/contact'), '/contact?step=2', 'Must extract relative path from same-origin absolute URL');

  // 7. Missing or empty referrer must return fallback
  const mockReqEmpty = {
    get() { return null; }
  };
  assert.equal(safeReferrer(mockReqEmpty, '/contact'), '/contact');
  assert.equal(safeReferrer(mockReqEmpty, '/'), '/');
});

test('HTTP integration: public newsletter and contact route open redirect prevention', async () => {
  // Start ephemeral server
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. POST /api/newsletter with external Referer
    const newsRes = await fetch(`${baseUrl}/api/newsletter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://evil-attacker.com/malicious-login',
        'Host': `127.0.0.1:${port}`
      },
      body: 'email_or_phone=test_subscriber@example.com',
      redirect: 'manual'
    });

    assert.equal(newsRes.status, 302, 'Newsletter redirect must be 302');
    const newsLocation = newsRes.headers.get('location') || '';
    assert.equal(newsLocation.split('?')[0], '/', 'Must redirect safely to / and NOT to evil-attacker.com');
    assert.doesNotMatch(newsLocation, /evil-attacker/i, 'Location must never contain external origin');

    // 2. POST /api/contact with external Referer
    const contactRes = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://attacker.site/phishing',
        'Host': `127.0.0.1:${port}`
      },
      body: 'name=Test+User&phone=01711111111&email=test@example.com&subject=Inquiry&message=Hello+World',
      redirect: 'manual'
    });

    assert.equal(contactRes.status, 302, 'Contact redirect must be 302');
    const contactLocation = contactRes.headers.get('location') || '';
    assert.equal(contactLocation.split('?')[0], '/contact', 'Must redirect safely to /contact and NOT to attacker.site');
    assert.doesNotMatch(contactLocation, /attacker\.site/i, 'Location must never contain external origin');

    // 3. POST /api/contact with valid local Referer
    const localContactRes = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${baseUrl}/contact?topic=order`,
        'Host': `127.0.0.1:${port}`
      },
      body: 'name=Test+User&phone=01711111111&email=test@example.com&subject=Inquiry&message=Hello+World',
      redirect: 'manual'
    });

    assert.equal(localContactRes.status, 302);
    const localLocation = localContactRes.headers.get('location') || '';
    assert.equal(localLocation.split('?')[0], '/contact', 'Must preserve legitimate local relative path');
    assert.match(localLocation, /topic=order/, 'Must preserve local query parameters');

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
