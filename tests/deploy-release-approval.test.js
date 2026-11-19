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

describe('Cryptographic Release Governance & Approval Gate Suite (v3.3)', () => {
  const currentHeadSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().toLowerCase();
  const approvedBaselineSha = '1b3c9a1950c2e8de7b76efb0d86717b02f64f100';
  const approvedCandidateBaseline = '5285d82e7e233c50561222c419fc163d79d74c5d';

  let testGovKey;
  let testGovPublicKeyPem;
  let testGovPrivateKeyPem;
  let tempGovConfigPath;

  before(() => {
    // Generate a fresh disposable Ed25519 keypair for tests
    testGovKey = crypto.generateKeyPairSync('ed25519');
    testGovPublicKeyPem = testGovKey.publicKey.export({ type: 'spki', format: 'pem' });
    testGovPrivateKeyPem = testGovKey.privateKey.export({ type: 'pkcs8', format: 'pem' });

    // Generate a revoked keypair
    const revokedKey = crypto.generateKeyPairSync('ed25519');
    const revokedPubPem = revokedKey.publicKey.export({ type: 'spki', format: 'pem' });

    const testGovernanceData = {
      schema_version: '3.3',
      policy: {
        require_cryptographic_signature: true,
        max_ticket_validity_hours: 72
      },
      trusted_keys: [
        {
          key_id: 'test-gov-board-2026',
          algorithm: 'ed25519',
          public_key: testGovPublicKeyPem,
          owner: 'Test Governance Board',
          roles: ['production_release_approval']
        },
        {
          key_id: 'revoked-key-2026',
          algorithm: 'ed25519',
          public_key: revokedPubPem,
          owner: 'Compromised Signer',
          roles: ['production_release_approval']
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
  });

  after(() => {
    if (tempGovConfigPath && fs.existsSync(tempGovConfigPath)) {
      fs.unlinkSync(tempGovConfigPath);
    }
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
      release_tag: 'v3.3.0',
      key_id: 'test-gov-board-2026',
      environment: 'production',
      validity_hours: 48
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, true);
    assert.equal(res.method, 'CRYPTOGRAPHIC_DETACHED_TICKET');
    assert.equal(res.key_id, 'test-gov-board-2026');
    assert.equal(res.target_commit, currentHeadSha);
  });

  test('Rejects ticket when target_commit in payload does not match candidate SHA', () => {
    const ticket = createSignedTicket({
      target_commit: '1111111111111111111111111111111111111111',
      release_tag: 'v3.3.0',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /Ticket target_commit mismatch/);
  });

  test('Rejects ticket when payload has been tampered with post-signing', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.3.0',
      key_id: 'test-gov-board-2026'
    }, testGovPrivateKeyPem);

    // Tamper with environment after signing
    ticket.payload.environment = 'staging';

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
      release_tag: 'v3.3.0',
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
      release_tag: 'v3.3.0',
      key_id: 'revoked-key-2026'
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /has been REVOKED/);
  });

  test('Rejects EXPIRED release ticket', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.3.0',
      key_id: 'test-gov-board-2026',
      issued_at: new Date(Date.now() - 50 * 3600 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString()
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /EXPIRED/);
  });

  test('Rejects ticket exceeding maximum allowable validity window', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.3.0',
      key_id: 'test-gov-board-2026',
      issued_at: new Date(Date.now() - 80 * 3600 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString()
    }, testGovPrivateKeyPem);

    const res = verifyReleaseApproval(currentHeadSha, {
      ticket,
      governanceConfig: tempGovConfigPath
    });

    assert.equal(res.approved, false);
    assert.match(res.reason, /exceeds maximum allowable validity window/);
  });

  test('Rejects ticket with corrupted signature buffer', () => {
    const ticket = createSignedTicket({
      target_commit: currentHeadSha,
      release_tag: 'v3.3.0',
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
      release_tag: 'v3.3.0',
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
