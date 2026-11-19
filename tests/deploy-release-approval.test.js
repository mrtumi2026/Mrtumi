'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { verifyReleaseApproval } = require('../scripts/ops/verify-release-approval');

describe('Release Target Verification & Governance Gate Suite', () => {
  const approvedBaselineSha = '1b3c9a1950c2e8de7b76efb0d86717b02f64f100';
  const approvedCandidateSha = '5285d82e7e233c50561222c419fc163d79d74c5d';
  const currentHeadSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  test('Rejects missing or empty target SHA', () => {
    const res1 = verifyReleaseApproval('');
    assert.equal(res1.approved, false);
    assert.match(res1.reason, /Target commit SHA is missing/);

    const res2 = verifyReleaseApproval(null);
    assert.equal(res2.approved, false);
  });

  test('Rejects malformed, non-hex, or incorrect length SHA', () => {
    const res1 = verifyReleaseApproval('not-a-sha');
    assert.equal(res1.approved, false);
    assert.match(res1.reason, /not a valid 40-character hexadecimal/);

    const res2 = verifyReleaseApproval('12345');
    assert.equal(res2.approved, false);

    const res3 = verifyReleaseApproval('5285d82e7e233c50561222c419fc163d79d74c5d-extra');
    assert.equal(res3.approved, false);
  });

  test('Rejects valid 40-char SHA that does not exist in Git object store', () => {
    const nonexistentSha = '0000000000000000000000000000000000000000';
    const res = verifyReleaseApproval(nonexistentSha);
    assert.equal(res.approved, false);
    assert.match(res.reason, /does not exist in local Git object store/);
  });

  test('Rejects existing commit that is NOT in registry allowlist and lacks approved tag/signoff', () => {
    const res = verifyReleaseApproval(currentHeadSha);
    assert.equal(res.approved, false);
    assert.match(res.reason, /is not in approved registry/);
  });

  test('Approves commit explicitly listed in config/approved-releases.json', () => {
    const res = verifyReleaseApproval(approvedCandidateSha, { skipGitCheck: true });
    assert.equal(res.approved, true);
    assert.equal(res.method, 'COMMIT_ALLOWLIST');
    assert.equal(res.sha, approvedCandidateSha);

    const resBase = verifyReleaseApproval(approvedBaselineSha, { skipGitCheck: true });
    assert.equal(resBase.approved, true);
    assert.equal(resBase.method, 'COMMIT_ALLOWLIST');

    // Also verify with real Git object check using a temp registry containing current HEAD
    const tempConfig = path.join(os.tmpdir(), `approved-test-${Date.now()}.json`);
    try {
      fs.writeFileSync(tempConfig, JSON.stringify({
        approved_commit_allowlist: [currentHeadSha],
        approved_release_tags: [],
        governance_signoffs: []
      }));
      const resHead = verifyReleaseApproval(currentHeadSha, { configPath: tempConfig });
      assert.equal(resHead.approved, true);
      assert.equal(resHead.method, 'COMMIT_ALLOWLIST');
    } finally {
      if (fs.existsSync(tempConfig)) fs.unlinkSync(tempConfig);
    }
  });

  test('Approves unlisted commit when valid governance signoff is supplied', () => {
    const res = verifyReleaseApproval(currentHeadSha, {
      signoff: 'arena-audit-candidate'
    });
    assert.equal(res.approved, true);
    assert.equal(res.method, 'GOVERNANCE_SIGNOFF');
    assert.equal(res.signoff, 'arena-audit-candidate');
  });

  test('Approves unlisted commit when explicit operator override matching the exact target is supplied', () => {
    const res = verifyReleaseApproval(currentHeadSha, {
      allowUnlistedSha: currentHeadSha
    });
    assert.equal(res.approved, true);
    assert.equal(res.method, 'EXPLICIT_OPERATOR_OVERRIDE');
  });

  test('Rejects operator override if override SHA does not match the target commit', () => {
    const res = verifyReleaseApproval(currentHeadSha, {
      allowUnlistedSha: 'different-sha-value'
    });
    assert.equal(res.approved, false);
    assert.match(res.reason, /is not in approved registry/);
  });
});
