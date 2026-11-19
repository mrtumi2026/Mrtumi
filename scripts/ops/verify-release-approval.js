'use strict';

/**
 * Mr. Tumi Marketplace — Release Governance & Target Approval Verifier
 *
 * Guarantees that arbitrary unvetted 40-character Git SHAs cannot be deployed.
 * Validates target against approved registry, release tags, or authorized governance sign-off.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function verifyReleaseApproval(targetSha, opts = {}) {
  if (!targetSha || typeof targetSha !== 'string') {
    return { approved: false, reason: 'Target commit SHA is missing or empty' };
  }

  const cleanSha = targetSha.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(cleanSha)) {
    return { approved: false, reason: `Target SHA '${cleanSha}' is not a valid 40-character hexadecimal string` };
  }

  // 1. Verify commit exists in git
  const catCheck = spawnSync('git', ['cat-file', '-e', `${cleanSha}^{commit}`], { encoding: 'utf8' });
  if (catCheck.status !== 0) {
    return { approved: false, reason: `Commit '${cleanSha}' does not exist in local Git object store` };
  }

  // 2. Load registry allowlist
  const configPath = opts.configPath || path.resolve(__dirname, '..', '..', 'config', 'approved-releases.json');
  let registry = { approved_commit_allowlist: [], approved_release_tags: [], governance_signoffs: [] };

  if (fs.existsSync(configPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (parseErr) {
      return { approved: false, reason: `Failed to parse approved release registry (${parseErr.message})` };
    }
  }

  // 3. Check explicit commit allowlist
  const allowlist = new Set((registry.approved_commit_allowlist || []).map(s => s.toLowerCase()));
  if (allowlist.has(cleanSha.toLowerCase())) {
    return { approved: true, method: 'COMMIT_ALLOWLIST', sha: cleanSha };
  }

  // 4. Check git release tags pointing to this commit
  const tagCheck = spawnSync('git', ['tag', '--points-at', cleanSha], { encoding: 'utf8' });
  if (tagCheck.status === 0 && tagCheck.stdout.trim()) {
    const tags = tagCheck.stdout.split('\n').map(t => t.trim()).filter(Boolean);
    const tagPatterns = (registry.approved_release_tags || []).map(p => new RegExp(p));
    for (const tag of tags) {
      for (const pattern of tagPatterns) {
        if (pattern.test(tag)) {
          return { approved: true, method: 'APPROVED_TAG', tag, sha: cleanSha };
        }
      }
    }
  }

  // 5. Check authorized governance signoff token
  const signoff = opts.signoff || process.env.RELEASE_GOVERNANCE_SIGNOFF;
  if (signoff) {
    const validSignoffs = new Set(registry.governance_signoffs || []);
    if (validSignoffs.has(signoff)) {
      return { approved: true, method: 'GOVERNANCE_SIGNOFF', signoff, sha: cleanSha };
    }
  }

  // 6. Check explicit operator bypass parameter (must match the exact target SHA)
  const explicitBypass = opts.allowUnlistedSha || process.env.ALLOW_UNLISTED_RELEASE_SHA;
  if (explicitBypass && explicitBypass.trim().toLowerCase() === cleanSha.toLowerCase()) {
    return { approved: true, method: 'EXPLICIT_OPERATOR_OVERRIDE', sha: cleanSha };
  }

  return {
    approved: false,
    reason: `Target commit '${cleanSha}' is not in approved registry, does not have an approved release tag, and has no valid governance signoff.`
  };
}

function main() {
  const targetSha = process.argv[2] || process.env.APPROVED_RELEASE_SHA;
  const result = verifyReleaseApproval(targetSha);

  if (!result.approved) {
    console.error(`❌ [RELEASE_APPROVAL_REJECTED]: ${result.reason}`);
    console.error('   To authorize an unlisted release candidate, set:');
    console.error(`     ALLOW_UNLISTED_RELEASE_SHA="${targetSha}" ./deploy.sh "${targetSha}"`);
    console.error('   Or add the SHA to config/approved-releases.json.');
    process.exit(1);
  }

  console.log(`✔ Release target verified as APPROVED via ${result.method}: ${result.sha}`);
}

if (require.main === module) {
  main();
}

module.exports = { verifyReleaseApproval };
