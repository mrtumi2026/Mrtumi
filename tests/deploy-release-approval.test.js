'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { verifyReleaseApproval } = require('../scripts/ops/verify-release-approval');
const { createSignedTicket } = require('../scripts/ops/sign-release-ticket');

describe('Cryptographic Release Governance & Approval Gate Suite (v3.5 Hardened)', () => {
  const currentHeadSha = execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim().toLowerCase();
  const approvedBaselineSha = '1b3c9a1950c2e8de7b76efb0d86717b02f64f100';
  const approvedCandidateBaseline = '5285d82e7e233c50561222c419fc163d79d74c5d';

  let testGovKey;
  let testGovPublicKeyPem;
  let testGovPrivateKeyPem;
  let futureKey;
  let expiredKey;
  let tempGovConfigPath;
  let tempAnchorPath;

  before(() => {
    // 1. Valid keypair (currently valid)
    testGovKey = crypto.generateKeyPairSync('ed25519');
    testGovPublicKeyPem = testGovKey.publicKey.export({ type: 'spki', format: 'pem' });
    testGovPrivateKeyPem = testGovKey.privateKey.export({ type: 'pkcs8', format: 'pem' });

    // 2. Future keypair (not yet valid)
    futureKey = crypto.generateKeyPairSync('ed25519');
    const futurePubPem = futureKey.publicKey.export({ type: 'spki', format: 'pem' });

    // 3. Expired keypair (valid_until in past)
    expiredKey = crypto.generateKeyPairSync('ed25519');
    const expiredPubPem = expiredKey.publicKey.export({ type: 'spki', format: 'pem' });

    // 4. Revoked keypair
    const revokedKey = crypto.generateKeyPairSync('ed25519');
    const revokedPubPem = revokedKey.publicKey.export({ type: 'spki', format: 'pem' });

    const testGovernanceData = {
      schema_version: '3.5',
      policy: {
        require_cryptographic_signature: true,
        allowed_signature_algorithms: ['ed25519'],
        approved_tag_pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc[0-9]+)?$',
        max_ticket_validity_hours: 72,
        allow_ambient_signoffs: false,
        allow_unlisted_sha_bypass: false
      },
      trusted_keys: [
        {
          key_id: 'test-gov-board-2026',
          algorithm: 'ed25519',
          public_key: testGovPublicKeyPem,
          owner: 'Test Governance Board',
          roles: ['production_release_approval'],
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: '2027-01-01T00:00:00Z'
        },
        {
          key_id: 'future-key-2027',
          algorithm: 'ed25519',
          public_key: futurePubPem,
          owner: 'Future Rotated Key',
          roles: ['production_release_approval'],
          valid_from: '2027-01-01T00:00:00Z',
          valid_until: '2028-01-01T00:00:00Z'
        },
        {
          key_id: 'expired-key-2025',
          algorithm: 'ed25519',
          public_key: expiredPubPem,
          owner: 'Old Rotated Key',
          roles: ['production_release_approval'],
          valid_from: '2025-01-01T00:00:00Z',
          valid_until: '2025-12-31T23:59:59Z'
        },
        {
          key_id: 'revoked-key-2026',
          algorithm: 'ed25519',
          public_key: revokedPubPem,
          owner: 'Compromised Signer',
          roles: ['production_release_approval'],
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: '2027-01-01T00:00:00Z'
        }
      ],
      revoked_key_ids: ['revoked-key-2026'],
      historical_baseline_allowlist: [
        approvedBaselineSha,
        approvedCandidateBaseline
      ]
    };

    tempGovConfigPath = path.join(os.tmpdir(), `test-gov-config-${Date.now()}.json`);
    fs.writeFileSync(tempGovConfigPath, JSON.stringify(testGovernanceData, null, 2));

    // Independent out-of-band trust anchor
    const govRaw = fs.readFileSync(tempGovConfigPath);
    const govSha = crypto.createHash('sha256').update(govRaw).digest('hex');
    tempAnchorPath = path.join(os.tmpdir(), `test-trust-anchor-${Date.now()}.json`);
    fs.writeFileSync(tempAnchorPath, JSON.stringify({
      schema_version: '1.0',
      description: 'Independent Out-Of-Band Trust Anchor',
      expected_governance_sha256: govSha
    }, null, 2));

    process.env.GOVERNANCE_TRUST_ANCHOR_PATH = tempAnchorPath;
    process.env.DEPLOY_RELEASE_TAG = 'v3.5.0';
  });

  after(() => {
    delete process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_SHA256;
    delete process.env.DEPLOY_RELEASE_TAG;
    if (tempGovConfigPath && fs.existsSync(tempGovConfigPath)) fs.unlinkSync(tempGovConfigPath);
    if (tempAnchorPath && fs.existsSync(tempAnchorPath)) fs.unlinkSync(tempAnchorPath);
  });

  // ---------------------------------------------------------------------------
  // PART 1: MANDATORY OUT-OF-BAND TRUST ANCHOR SUITE (Finding C1 & C2)
  // ---------------------------------------------------------------------------

  test('Fails closed when both trust anchor file and environment SHA are missing (TRUST_ANCHOR_REQUIRED)', () => {
    const savedPath = process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    const savedSha = process.env.GOVERNANCE_TRUST_ANCHOR_SHA256;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_SHA256;
    try {
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: null,
        trustAnchorSha: null
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_REQUIRED/);
    } finally {
      process.env.GOVERNANCE_TRUST_ANCHOR_PATH = savedPath;
      if (savedSha) process.env.GOVERNANCE_TRUST_ANCHOR_SHA256 = savedSha;
    }
  });

  test('Fails closed when specified trust anchor file does not exist (TRUST_ANCHOR_NOT_FOUND)', () => {
    const res = verifyReleaseApproval(currentHeadSha, {
      governanceConfig: tempGovConfigPath,
      trustAnchorPath: path.join(os.tmpdir(), 'nonexistent-trust-anchor-file-12345.json')
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /TRUST_ANCHOR_NOT_FOUND/);
  });

  test('Fails closed when trust anchor file is a symbolic link (TRUST_ANCHOR_SYMLINK_FORBIDDEN)', () => {
    const symlinkPath = path.join(os.tmpdir(), `test-anchor-symlink-${Date.now()}.json`);
    try {
      try {
        fs.symlinkSync(tempAnchorPath, symlinkPath);
      } catch (e) {
        // Skip if OS permission disallows symlink creation without admin
        return;
      }
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: symlinkPath
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_SYMLINK_FORBIDDEN/);
    } finally {
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    }
  });

  test('Fails closed when trust anchor file is empty (TRUST_ANCHOR_EMPTY)', () => {
    const emptyAnchor = path.join(os.tmpdir(), `test-anchor-empty-${Date.now()}.json`);
    try {
      fs.writeFileSync(emptyAnchor, '   ');
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: emptyAnchor
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_EMPTY/);
    } finally {
      if (fs.existsSync(emptyAnchor)) fs.unlinkSync(emptyAnchor);
    }
  });

  test('Fails closed when trust anchor file is malformed JSON (TRUST_ANCHOR_MALFORMED)', () => {
    const malformedAnchor = path.join(os.tmpdir(), `test-anchor-malformed-${Date.now()}.json`);
    try {
      fs.writeFileSync(malformedAnchor, '{ invalid_json_here: ');
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: malformedAnchor
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_MALFORMED/);
    } finally {
      if (fs.existsSync(malformedAnchor)) fs.unlinkSync(malformedAnchor);
    }
  });

  test('Fails closed when trust anchor file is missing expected_governance_sha256 (TRUST_ANCHOR_INVALID)', () => {
    const invalidAnchor = path.join(os.tmpdir(), `test-anchor-invalid-${Date.now()}.json`);
    try {
      fs.writeFileSync(invalidAnchor, JSON.stringify({ schema_version: '1.0' }));
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: invalidAnchor
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_INVALID/);
    } finally {
      if (fs.existsSync(invalidAnchor)) fs.unlinkSync(invalidAnchor);
    }
  });

  test('Fails closed when environment SHA is not a 64-char hex string (TRUST_ANCHOR_INVALID_SHA)', () => {
    const savedPath = process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    try {
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: null,
        trustAnchorSha: 'not-a-sha256-string'
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_INVALID_SHA/);
    } finally {
      process.env.GOVERNANCE_TRUST_ANCHOR_PATH = savedPath;
    }
  });

  test('Fails closed when anchor file and environment SHA conflict with each other (TRUST_ANCHOR_CONFLICT)', () => {
    const res = verifyReleaseApproval(currentHeadSha, {
      governanceConfig: tempGovConfigPath,
      trustAnchorPath: tempAnchorPath,
      trustAnchorSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /TRUST_ANCHOR_CONFLICT/);
  });

  test('Fails closed when in-repo governance hash does not match anchor (TRUST_ANCHOR_INTEGRITY_MISMATCH)', () => {
    const tamperedAnchor = path.join(os.tmpdir(), `tampered-anchor-${Date.now()}.json`);
    try {
      fs.writeFileSync(tamperedAnchor, JSON.stringify({
        expected_governance_sha256: '0000000000000000000000000000000000000000000000000000000000000000'
      }));

      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: tamperedAnchor
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_INTEGRITY_MISMATCH/);
    } finally {
      if (fs.existsSync(tamperedAnchor)) fs.unlinkSync(tamperedAnchor);
    }
  });

  test('Fails closed when GOVERNANCE_TRUST_ANCHOR_SHA256 does not match (TRUST_ANCHOR_SHA_MISMATCH)', () => {
    const savedPath = process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    try {
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: null,
        trustAnchorSha: '1111111111111111111111111111111111111111111111111111111111111111'
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_SHA_MISMATCH/);
    } finally {
      process.env.GOVERNANCE_TRUST_ANCHOR_PATH = savedPath;
    }
  });

  test('Approves verification when valid GOVERNANCE_TRUST_ANCHOR_SHA256 environment variable is provided', () => {
    const savedPath = process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    delete process.env.GOVERNANCE_TRUST_ANCHOR_PATH;
    try {
      const govRaw = fs.readFileSync(tempGovConfigPath);
      const govSha = crypto.createHash('sha256').update(govRaw).digest('hex');

      const ticket = createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);

      const res = verifyReleaseApproval(currentHeadSha, {
        ticket,
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: null,
        trustAnchorSha: govSha,
        expectedTag: 'v3.5.0'
      });
      assert.equal(res.approved, true);
      assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    } finally {
      process.env.GOVERNANCE_TRUST_ANCHOR_PATH = savedPath;
    }
  });

  // ---------------------------------------------------------------------------
  // PART 2: POLICY ENFORCEMENT & ALGORITHMS (Finding C4)
  // ---------------------------------------------------------------------------

  test('Fails closed on ambient sign-off attempts (SECURITY_POLICY_VIOLATION)', () => {
    process.env.RELEASE_GOVERNANCE_SIGNOFF = 'unauthorized_signoff_attempt';
    try {
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /SECURITY_POLICY_VIOLATION/);
    } finally {
      delete process.env.RELEASE_GOVERNANCE_SIGNOFF;
    }
  });

  test('Fails closed on unlisted SHA bypass variable attempts (SECURITY_POLICY_VIOLATION)', () => {
    process.env.ALLOW_UNLISTED_RELEASE_SHA = 'true';
    try {
      const res = verifyReleaseApproval(currentHeadSha, {
        governanceConfig: tempGovConfigPath
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /SECURITY_POLICY_VIOLATION/);
    } finally {
      delete process.env.ALLOW_UNLISTED_RELEASE_SHA;
    }
  });

  test('Rejects ticket when key algorithm is unsupported (UNSUPPORTED_SIGNATURE_ALGORITHM)', () => {
    const customGovData = JSON.parse(fs.readFileSync(tempGovConfigPath, 'utf8'));
    customGovData.trusted_keys[0].algorithm = 'rsa';
    const customGovPath = path.join(os.tmpdir(), `custom-gov-${Date.now()}.json`);
    const customAnchorPath = path.join(os.tmpdir(), `custom-anchor-${Date.now()}.json`);
    try {
      fs.writeFileSync(customGovPath, JSON.stringify(customGovData, null, 2));
      const govSha = crypto.createHash('sha256').update(fs.readFileSync(customGovPath)).digest('hex');
      fs.writeFileSync(customAnchorPath, JSON.stringify({ expected_governance_sha256: govSha }));

      const ticket = createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);

      const res = verifyReleaseApproval(currentHeadSha, {
        ticket,
        governanceConfig: customGovPath,
        trustAnchorPath: customAnchorPath,
        expectedTag: 'v3.5.0'
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /UNSUPPORTED_SIGNATURE_ALGORITHM/);
    } finally {
      if (fs.existsSync(customGovPath)) fs.unlinkSync(customGovPath);
      if (fs.existsSync(customAnchorPath)) fs.unlinkSync(customAnchorPath);
    }
  });

  test('Rejects ticket when ticket algorithm differs from key algorithm (ALGORITHM_MISMATCH)', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    ticket.algorithm = 'secp256k1';

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /UNSUPPORTED_SIGNATURE_ALGORITHM|ALGORITHM_MISMATCH/);
  });

  // ---------------------------------------------------------------------------
  // PART 3: RELEASE TAG MATCHING & DEPLOY ENVIRONMENT (Finding H2)
  // ---------------------------------------------------------------------------

  test('Fails closed when expectedTag is missing for production deployment (MISSING_EXPECTED_TAG)', () => {
    const savedTag = process.env.DEPLOY_RELEASE_TAG;
    delete process.env.DEPLOY_RELEASE_TAG;
    try {
      const ticket = createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);

      const res = verifyReleaseApproval(currentHeadSha, {
        ticket,
        governanceConfig: tempGovConfigPath,
        expectedEnvironment: 'production'
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /MISSING_EXPECTED_TAG/);
    } finally {
      process.env.DEPLOY_RELEASE_TAG = savedTag;
    }
  });

  test('Fails closed when ticket release_tag does not match deployment expectedTag', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.1'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Ticket release_tag mismatch/);
  });

  test('Approves ticket when release_tag exactly matches deployment expectedTag', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, true);
    assert.equal(res.release_tag, 'v3.5.0');
  });

  // ---------------------------------------------------------------------------
  // PART 4: SIGN-RELEASE-TICKET MANDATORY ARGUMENTS (Finding H3)
  // ---------------------------------------------------------------------------

  test('createSignedTicket throws when release_tag is missing (no silent defaults)', () => {
    assert.throws(() => {
      createSignedTicket({
        target_commit: currentHeadSha,
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);
    }, /Missing mandatory release_tag/);
  });

  test('createSignedTicket throws when environment is missing (no silent defaults)', () => {
    assert.throws(() => {
      createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);
    }, /Missing mandatory environment/);
  });

  test('createSignedTicket throws when target_commit is missing or invalid', () => {
    assert.throws(() => {
      createSignedTicket({
        target_commit: 'invalid_sha',
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);
    }, /Invalid or missing mandatory target_commit/);
  });

  test('createSignedTicket throws when key_id is missing', () => {
    assert.throws(() => {
      createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production'
      }, testGovPrivateKeyPem);
    }, /Missing mandatory key_id/);
  });

  test('createSignedTicket throws when privateKeyPem is missing', () => {
    assert.throws(() => {
      createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, '');
    }, /Missing mandatory privateKeyPem/);
  });

  // ---------------------------------------------------------------------------
  // PART 5: EXECUTABLE KEY ROTATION WORKFLOW (Finding H4)
  // ---------------------------------------------------------------------------

  test('Executes end-to-end key rotation: new key accepted, old key revoked, anchor updated', () => {
    // 1. Generate new active keypair (Key 2)
    const newGovKey = crypto.generateKeyPairSync('ed25519');
    const newPubPem = newGovKey.publicKey.export({ type: 'spki', format: 'pem' });
    const newPrivPem = newGovKey.privateKey.export({ type: 'pkcs8', format: 'pem' });

    // 2. Build rotated governance store: add Key 2 to trusted_keys, move Key 1 to revoked_key_ids
    const rotatedGovData = {
      schema_version: '3.5',
      policy: {
        require_cryptographic_signature: true,
        allowed_signature_algorithms: ['ed25519'],
        approved_tag_pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc[0-9]+)?$',
        max_ticket_validity_hours: 72
      },
      trusted_keys: [
        {
          key_id: 'new-gov-board-2026',
          algorithm: 'ed25519',
          public_key: newPubPem,
          owner: 'Rotated Governance Board',
          roles: ['production_release_approval'],
          valid_from: '2026-01-01T00:00:00Z',
          valid_until: '2027-01-01T00:00:00Z'
        }
      ],
      revoked_key_ids: ['test-gov-board-2026'],
      historical_baseline_allowlist: [approvedBaselineSha]
    };

    const rotatedGovPath = path.join(os.tmpdir(), `rotated-gov-${Date.now()}.json`);
    const rotatedAnchorPath = path.join(os.tmpdir(), `rotated-anchor-${Date.now()}.json`);

    try {
      fs.writeFileSync(rotatedGovPath, JSON.stringify(rotatedGovData, null, 2));
      const rotSha = crypto.createHash('sha256').update(fs.readFileSync(rotatedGovPath)).digest('hex');
      fs.writeFileSync(rotatedAnchorPath, JSON.stringify({ expected_governance_sha256: rotSha }));

      // 3. Ticket signed by Old Key (test-gov-board-2026) must be REJECTED as REVOKED
      const oldKeyTicket = createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'test-gov-board-2026'
      }, testGovPrivateKeyPem);

      const oldRes = verifyReleaseApproval(currentHeadSha, {
        ticket: oldKeyTicket,
        governanceConfig: rotatedGovPath,
        trustAnchorPath: rotatedAnchorPath,
        expectedTag: 'v3.5.0'
      });
      assert.equal(oldRes.approved, false);
      assert.match(oldRes.reason, /REVOKED/);

      // 4. Ticket signed by New Key (new-gov-board-2026) must be APPROVED
      const newKeyTicket = createSignedTicket({
        target_commit: currentHeadSha,
        release_tag: 'v3.5.0',
        environment: 'production',
        key_id: 'new-gov-board-2026'
      }, newPrivPem);

      const newRes = verifyReleaseApproval(currentHeadSha, {
        ticket: newKeyTicket,
        governanceConfig: rotatedGovPath,
        trustAnchorPath: rotatedAnchorPath,
        expectedTag: 'v3.5.0'
      });
      assert.equal(newRes.approved, true);
      assert.equal(newRes.key_id, 'new-gov-board-2026');
      assert.equal(newRes.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    } finally {
      if (fs.existsSync(rotatedGovPath)) fs.unlinkSync(rotatedGovPath);
      if (fs.existsSync(rotatedAnchorPath)) fs.unlinkSync(rotatedAnchorPath);
    }
  });

  // ---------------------------------------------------------------------------
  // PART 6: STANDARD RELEASE & INTEGRITY GATES (PRESERVED)
  // ---------------------------------------------------------------------------

  test('Rejects missing or empty target SHA', () => {
    const res1 = verifyReleaseApproval('', { governanceConfig: tempGovConfigPath });
    assert.equal(res1.approved, false);
    assert.match(res1.reason, /Target commit SHA is missing/);

    const res2 = verifyReleaseApproval(null, { governanceConfig: tempGovConfigPath });
    assert.equal(res2.approved, false);
  });

  test('Rejects malformed, non-hex, or incorrect length SHA', () => {
    const res1 = verifyReleaseApproval('not-a-sha', { governanceConfig: tempGovConfigPath });
    assert.equal(res1.approved, false);
    assert.match(res1.reason, /not a valid 40-character hexadecimal/);

    const res2 = verifyReleaseApproval('12345', { governanceConfig: tempGovConfigPath });
    assert.equal(res2.approved, false);

    const res3 = verifyReleaseApproval('5285d82e7e233c50561222c419fc163d79d74c5d-extra', { governanceConfig: tempGovConfigPath });
    assert.equal(res3.approved, false);
  });

  test('Rejects valid 40-char SHA that does not exist in Git object store', () => {
    const nonexistentSha = '0000000000000000000000000000000000000000';
    const res = verifyReleaseApproval(nonexistentSha, { governanceConfig: tempGovConfigPath });
    assert.equal(res.approved, false);
    assert.match(res.reason, /does not exist in local Git object store/);
  });

  test('Approves immutable historical production baselines without ticket', () => {
    const res1 = verifyReleaseApproval(approvedBaselineSha, { skipGitCheck: true, governanceConfig: tempGovConfigPath });
    assert.equal(res1.approved, true);
    assert.equal(res1.method, 'HISTORICAL_BASELINE');

    const res2 = verifyReleaseApproval(approvedCandidateBaseline, { skipGitCheck: true, governanceConfig: tempGovConfigPath });
    assert.equal(res2.approved, true);
    assert.equal(res2.method, 'HISTORICAL_BASELINE');
  });

  test('Rejects unapproved current HEAD when no cryptographic ticket is provided', () => {
    const res = verifyReleaseApproval(currentHeadSha, { governanceConfig: tempGovConfigPath });
    assert.equal(res.approved, false);
    assert.match(res.reason, /lacks an authorized cryptographic release ticket/);
  });

  test('Approves valid cryptographic ticket signed by authorized offline governance key', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      key_id: 'test-gov-board-2026',
      environment: 'production',
      validity_hours: 48
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      trustAnchorPath: tempAnchorPath,
      expectedTag: 'v3.5.0'
    });

    assert.equal(res.approved, true);
    assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    assert.equal(res.key_id, 'test-gov-board-2026');
    assert.equal(res.target_commit, currentHeadSha);
    assert.equal(res.release_tag, 'v3.5.0');
    assert.equal(res.environment, 'production');
  });

  test('Rejects ticket when release_tag is missing or does not conform to pattern', () => {
    const malformedTagTicket = {
      ticket_version: '1.0',
      key_id: 'test-gov-board-2026',
      algorithm: 'ed25519',
      payload: {
        target_commit: currentHeadSha,
        release_tag: 'invalid-tag-no-v',
        environment: 'production',
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        key_id: 'test-gov-board-2026'
      },
      signature: 'dummy'
    };

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: malformedTagTicket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /does not conform to approved release tag pattern/);
  });

  test('Rejects ticket when target_commit does not match candidate commit', () => {
    const otherSha = '1111111111111111111111111111111111111111';
    const ticket = createSignedTicket({
      target_commit: otherSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Ticket target_commit mismatch/);
  });

  test('Rejects ticket when environment does not match target environment (Prevents Cross-Environment Replay)', () => {
    const stagingTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'staging',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: stagingTicket,
      governanceConfig: tempGovConfigPath,
      expectedEnvironment: 'production',
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Cross-environment replay is forbidden/);
  });

  test('Rejects production ticket if attempted on staging deployment target', () => {
    const prodTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: prodTicket,
      governanceConfig: tempGovConfigPath,
      expectedEnvironment: 'staging',
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Cross-environment replay is forbidden/);
  });

  test('Rejects ticket signed by key whose valid_from window is in the future', () => {
    const futurePrivPem = futureKey.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const futureTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'future-key-2027'
    }, futurePrivPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: futureTicket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /is NOT YET VALID/);
  });

  test('Rejects ticket signed by key whose valid_until window has expired', () => {
    const expiredPrivPem = expiredKey.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const expiredTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'expired-key-2025'
    }, expiredPrivPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: expiredTicket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /has EXPIRED/);
  });

  test('Rejects ticket when payload has been tampered with post-signing', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    ticket.payload.release_tag = 'v3.5.1';

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.1'
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /signature verification FAILED/);
  });

  test('Rejects ticket signed by untrusted key not in keyring', () => {
    const untrustedKey = crypto.generateKeyPairSync('ed25519');
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'unknown-intruder-key'
    }, untrustedKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /not in the trusted governance keyring/);
  });

  test('Rejects ticket signed by a REVOKED key', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'revoked-key-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /has been REVOKED/);
  });

  test('Rejects ticket with corrupted signature buffer', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    ticket.signature = Buffer.from('corrupted_signature_data').toString('base64');

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.5.0'
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /signature verification FAILED|exception/);
  });

  test('Loads ticket from file path argument cleanly (shallow clone and CI compatibility)', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.5.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const ticketFile = path.join(os.tmpdir(), `ticket-${Date.now()}.json`);
    try {
      fs.writeFileSync(ticketFile, JSON.stringify(ticket, null, 2));

      const res = verifyReleaseApproval(currentHeadSha, {
        ticketArg: ticketFile,
        governanceConfig: tempGovConfigPath,
        expectedTag: 'v3.5.0'
      });

      assert.equal(res.approved, true);
      assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    } finally {
      if (fs.existsSync(ticketFile)) fs.unlinkSync(ticketFile);
    }
  });
});
