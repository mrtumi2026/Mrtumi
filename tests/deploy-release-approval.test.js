'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { verifyReleaseApproval } = require('../scripts/ops/verify-release-approval');
const { createSignedTicket } = require('../scripts/ops/sign-release-ticket');

describe('Cryptographic Release Governance & Approval Gate Suite (v3.4 Hardened)', () => {
  const currentHeadSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().toLowerCase();
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
      schema_version: '3.4',
      policy: {
        require_cryptographic_signature: true,
        approved_tag_pattern: '^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc[0-9]+)?$',
        max_ticket_validity_hours: 72
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
  });

  after(() => {
    if (tempGovConfigPath && fs.existsSync(tempGovConfigPath)) fs.unlinkSync(tempGovConfigPath);
    if (tempAnchorPath && fs.existsSync(tempAnchorPath)) fs.unlinkSync(tempAnchorPath);
  });

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
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026',
      environment: 'production',
      validity_hours: 48
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      trustAnchorPath: tempAnchorPath
    });

    assert.equal(res.approved, true);
    assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    assert.equal(res.key_id, 'test-gov-board-2026');
    assert.equal(res.target_commit, currentHeadSha);
    assert.equal(res.release_tag, 'v3.4.0');
    assert.equal(res.environment, 'production');
  });

  test('Rejects ticket when release_tag is missing or does not conform to pattern', () => {
    // Construct ticket with non-conforming tag
    const malformedTagTicket = {
      ticket_version: '1.0',
      key_id: 'test-gov-board-2026',
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
      governanceConfig: tempGovConfigPath
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /does not conform to approved release tag pattern/);
  });

  test('Rejects ticket when release_tag does not match expected deployment tag', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026',
      environment: 'production'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath,
      expectedTag: 'v3.4.1'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Ticket release_tag mismatch/);
  });

  test('Rejects staging-to-production replay (staging ticket cannot authorize production)', () => {
    const stagingTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0-rc1',
      environment: 'staging',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: stagingTicket,
      governanceConfig: tempGovConfigPath,
      expectedEnvironment: 'production'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Cross-environment replay is forbidden/);
  });

  test('Rejects production ticket deployed to staging (environment mismatch)', () => {
    const prodTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      environment: 'production',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: prodTicket,
      governanceConfig: tempGovConfigPath,
      expectedEnvironment: 'staging'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /Ticket environment mismatch/);
  });

  test('Rejects ticket signed by key that is NOT YET VALID (valid_from in future)', () => {
    const futureTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'future-key-2027',
      environment: 'production'
    }, futureKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: futureTicket,
      governanceConfig: tempGovConfigPath
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /is NOT YET VALID/);
  });

  test('Rejects ticket signed by key that has EXPIRED (valid_until in past)', () => {
    const expiredTicket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'expired-key-2025',
      environment: 'production'
    }, expiredKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket: expiredTicket,
      governanceConfig: tempGovConfigPath
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /has EXPIRED/);
  });

  test('Rejects ticket when independent out-of-band trust anchor detects repository tampering', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026',
      environment: 'production'
    }, testGovPrivateKeyPem);

    // Tampered anchor with conflicting expected hash
    const tamperedAnchor = path.join(os.tmpdir(), `tampered-anchor-${Date.now()}.json`);
    try {
      fs.writeFileSync(tamperedAnchor, JSON.stringify({
        expected_governance_sha256: '0000000000000000000000000000000000000000000000000000000000000000'
      }));

      const res = verifyReleaseApproval(currentHeadSha, {
        ticket,
        governanceConfig: tempGovConfigPath,
        trustAnchorPath: tamperedAnchor
      });
      assert.equal(res.approved, false);
      assert.match(res.reason, /TRUST_ANCHOR_INTEGRITY_MISMATCH/);
    } finally {
      if (fs.existsSync(tamperedAnchor)) fs.unlinkSync(tamperedAnchor);
    }
  });

  test('Rejects ticket when payload has been tampered with post-signing', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    ticket.payload.release_tag = 'v3.4.1';

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /signature verification FAILED/);
  });

  test('Rejects ticket signed by untrusted key not in keyring', () => {
    const untrustedKey = crypto.generateKeyPairSync('ed25519');
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'unknown-intruder-key'
    }, untrustedKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /not in the trusted governance keyring/);
  });

  test('Rejects ticket signed by a REVOKED key', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'revoked-key-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /has been REVOKED/);
  });

  test('Rejects ticket with corrupted signature buffer', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    ticket.signature = Buffer.from('corrupted_signature_data').toString('base64');

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /signature verification FAILED|exception/);
  });

  test('Loads ticket from file path argument cleanly (shallow clone and CI compatibility)', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.4.0',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const ticketFile = path.join(os.tmpdir(), `ticket-${Date.now()}.json`);
    try {
      fs.writeFileSync(ticketFile, JSON.stringify(ticket, null, 2));

      const res = verifyReleaseApproval(currentHeadSha, {
        ticketArg: ticketFile,
        governanceConfig: tempGovConfigPath
      });

      assert.equal(res.approved, true);
      assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    } finally {
      if (fs.existsSync(ticketFile)) fs.unlinkSync(ticketFile);
    }
  });
});
