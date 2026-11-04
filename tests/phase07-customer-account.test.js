'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBdPhone, validatePassword, saveAddress } = require('../src/repositories/customerRepository');
const checkoutRepository = require('../src/repositories/checkoutRepository');
const { loadMigrationPairs } = require('../src/db/migrator');
const { createErrorHandler } = require('../src/middleware/errorHandler');

test('Phase 07 validates Bangladesh mobile number forms without accepting malformed values', () => {
  assert.equal(normalizeBdPhone('01712345678'), '01712345678');
  assert.equal(normalizeBdPhone('+8801712345678'), '01712345678');
  assert.equal(normalizeBdPhone('880 1712345678'), '01712345678');
  for (const value of ['0171234567', '02123456789', '017123456789', '']) {
    assert.throws(() => normalizeBdPhone(value), { code: 'VALIDATION_ERROR' });
  }
});

test('Phase 07 checkout rejects malformed server-cart entries as validation errors, not TypeErrors', () => {
  for (const invalidLine of [null, undefined]) {
    assert.throws(
      () => checkoutRepository.normalizeLines([invalidLine]),
      (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400,
      'malformed cart lines should fail closed as HTTP 400 validation errors, not raw TypeErrors'
    );
  }
});

test('Phase 07 malformed address payloads and structured text fields fail before database access', async () => {
  for (const malformed of [null, undefined]) {
    await assert.rejects(
      () => saveAddress(1, malformed),
      (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400,
      'malformed address payloads must not leak a TypeError or become a server error'
    );
  }
  const valid = { label: 'Home', recipient_name: 'Owner', recipient_phone: '01712345678', division: 'Dhaka', district: 'Dhaka', upazila: 'Dhanmondi', street_address: 'House 1, Road 2' };
  for (const field of Object.keys(valid)) {
    for (const malformed of [{ unexpected: true }, ['unexpected'], true]) {
      await assert.rejects(
        () => saveAddress(1, { ...valid, [field]: malformed }),
        (err) => err.code === 'VALIDATION_ERROR' && err.statusCode === 400 && err.message === 'Address fields must be text.',
        `structured ${field} value must fail field validation before database access`
      );
    }
  }
});

test('Malformed JSON request bodies return a client error instead of HTTP 500', () => {
  const req = { requestId: 'phase07-malformed-json', method: 'POST', originalUrl: '/customer/account/addresses', path: '/customer/account/addresses', headers: { accept: 'application/json' }, xhr: false };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  createErrorHandler()({ type: 'entity.parse.failed', status: 400, message: 'malformed JSON' }, req, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_REQUEST_BODY');
});

test('Phase 07 customer order reads reject invalid or unsafe identifiers and page numbers before database access', async () => {
  const customerRepository = require('../src/repositories/customerRepository');
  for (const id of [0, -1, 'not-an-id', '9007199254740992']) {
    await assert.rejects(() => customerRepository.getProfile(id), (err) => err.code === 'VALIDATION_ERROR');
    await assert.rejects(() => customerRepository.getOrderDetails(1, id), (err) => err.code === 'VALIDATION_ERROR');
  }
  for (const page of [0, -1, 1.5, '2tail', [], {}]) {
    await assert.rejects(() => customerRepository.listOrders(1, page), (err) => err.code === 'VALIDATION_ERROR');
  }
});

test('customer order details return stable order-item IDs needed for exact return claims', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/repositories/customerRepository.js'), 'utf8');
  assert.match(source, /SELECT id, product_name, qty, unit_price_paisa, line_total_paisa, size_label, color_label\s+FROM order_items WHERE order_id = \? ORDER BY id/);
});

test('multipart return requests parse the CSRF field after upload and remove untrusted evidence on CSRF failure', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/customerAccount.js'), 'utf8');
  assert.match(route, /router\.post\('\/customer\/account\/orders\/:id\/returns',\s*requireCustomer,\s*customerReturnEvidence\.single,\s*requireCsrfAfterEvidenceUpload/);
  assert.match(route, /if \(error && req\.file\) customerReturnEvidence\.removeUploadedEvidence\(req\.file\)/);
});

test('customer return evidence uses a private directory and rejects arbitrary filesystem paths', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const evidence = require('../src/middleware/customerReturnEvidence');
  const original = process.env.CUSTOMER_RETURN_EVIDENCE_DIR;
  const privateDir = path.join(process.cwd(), 'tmp', `customer-return-evidence-${process.pid}-${Date.now()}`);
  process.env.CUSTOMER_RETURN_EVIDENCE_DIR = privateDir;
  try {
    const resolved = evidence.resolveEvidencePath('return-evidence/1-abcd.jpg');
    assert.equal(path.dirname(resolved), fs.realpathSync(privateDir));
    const relativeToPublic = path.relative(fs.realpathSync(path.join(process.cwd(), 'public')), fs.realpathSync(privateDir));
    assert.ok(relativeToPublic.startsWith('..') || path.isAbsolute(relativeToPublic), 'private evidence must remain outside the public tree');
    for (const key of ['../secret.jpg', 'return-evidence/../../secret.jpg', '/etc/passwd', '']) {
      assert.throws(() => evidence.resolveEvidencePath(key), { code: 'VALIDATION_ERROR' });
    }
  } finally {
    if (original === undefined) delete process.env.CUSTOMER_RETURN_EVIDENCE_DIR;
    else process.env.CUSTOMER_RETURN_EVIDENCE_DIR = original;
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});

test('legacy public return-evidence URLs are checked before public static serving', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  const guard = server.indexOf("app.use('/uploads/custom', async (req, res, next)");
  const publicStatic = server.indexOf("app.use(express.static(path.join(__dirname, 'public')))");
  assert.ok(guard >= 0 && publicStatic > guard, 'evidence guard runs before the public static middleware');
  assert.match(server, /SELECT id FROM customer_return_requests WHERE evidence_path IN \(\?, \?\) LIMIT 1/);
  assert.match(server, /if \(legacyEvidence\) return res\.sendStatus\(404\)/);
});

test('Phase 07 enforces password bounds compatible with bcrypt', () => {
  assert.equal(validatePassword('correct horse battery'), 'correct horse battery');
  assert.throws(() => validatePassword('short'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePassword('x'.repeat(73)), { code: 'VALIDATION_ERROR' });
});

test('Phase 07 cart migration is reversible and registered in ordered pairs', () => {
  const pairs = loadMigrationPairs();
  const pair = pairs.find((item) => item.version === '0005');
  assert.ok(pair);
  assert.match(pair.upSql, /CREATE TABLE IF NOT EXISTS `customer_cart_items`/);
  assert.match(pair.downSql, /DROP TABLE IF EXISTS `customer_cart_items`/);
});
