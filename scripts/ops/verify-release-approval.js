'use strict';

/**
 * Mr. Tumi Marketplace — Cryptographic Release Governance & Target Approval Verifier (v3.4 Hardened)
 *
 * Enforces that only cryptographically signed release candidates signed by an
 * authorized release governor's offline private key can be deployed.
 *
 * Security Guarantees:
 * 1. ZERO plaintext string signoffs or ambient bypasses (ALLOW_UNLISTED_RELEASE_SHA removed).
 * 2. Trust root verification: Supports independent out-of-band trust anchor verification
 *    (preventing in-repo trust-store tampering).
 * 3. Enforces trusted key validity window (valid_from <= now <= valid_until) and key revocation.
 * 4. Enforces release_tag syntax (^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$) and expected tag matching.
 * 5. Enforces deployment environment isolation (staging tickets cannot authorize production).
 * 6. Detached cryptographic signatures decouple release approval from candidate commits,
 *    eliminating circular self-referential git commit issues.
 * 7. Immutable historical baselines are strictly allowlisted by immutable commit SHA.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { canonicalizePayload } = require('./sign-release-ticket');

function verifyReleaseApproval(targetSha, opts = {}) {
  if (!targetSha || typeof targetSha !== 'string') {
    return { approved: false, reason: 'Target commit SHA is missing or empty' };
  }

  const cleanSha = targetSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(cleanSha)) {
    return { approved: false, reason: `Target SHA '${cleanSha}' is not a valid 40-character hexadecimal string` };
  }

  // 1. Verify commit exists in git (unless explicitly bypassed for registry-only evaluation)
  if (!opts.skipGitCheck) {
    const catCheck = spawnSync('git', ['cat-file', '-e', `${cleanSha}^{commit}`], { encoding: 'utf8' });
    if (catCheck.status !== 0) {
      return { approved: false, reason: `Commit '${cleanSha}' does not exist in local Git object store` };
    }
  }

  // 2. Load in-repo release governance configuration
  const governancePath = opts.governanceConfig ||
    opts.configPath ||
    path.resolve(__dirname, '..', '..', 'config', 'release-governance.json');

  let governance = {
    trusted_keys: [],
    revoked_key_ids: [],
    historical_baseline_allowlist: [],
    policy: { max_ticket_validity_hours: 72 }
  };

  if (fs.existsSync(governancePath)) {
    try {
      governance = JSON.parse(fs.readFileSync(governancePath, 'utf8'));
    } catch (parseErr) {
      return { approved: false, reason: `Failed to parse release governance config (${parseErr.message})` };
    }
  } else {
    return { approved: false, reason: `Release governance config not found: ${governancePath}` };
  }

  // 3. Out-Of-Band Independent Trust Anchor Validation
  const trustAnchorPath = opts.trustAnchorPath ||
    process.env.GOVERNANCE_TRUST_ANCHOR_PATH ||
    (process.env.HOME ? path.join(process.env.HOME, '.mrtumi_governance_trust_anchor.json') : null);

  const trustAnchorSha = opts.trustAnchorSha || process.env.GOVERNANCE_TRUST_ANCHOR_SHA256;

  if (trustAnchorPath && fs.existsSync(trustAnchorPath)) {
    try {
      const anchor = JSON.parse(fs.readFileSync(trustAnchorPath, 'utf8'));
      const govRaw = fs.readFileSync(governancePath);
      const govHash = crypto.createHash('sha256').update(govRaw).digest('hex');

      if (anchor.expected_governance_sha256 && anchor.expected_governance_sha256.toLowerCase() !== govHash.toLowerCase()) {
        return {
          approved: false,
          reason: `TRUST_ANCHOR_INTEGRITY_MISMATCH: In-repo release governance hash '${govHash}' does not match independent out-of-band trust anchor hash '${anchor.expected_governance_sha256}'!`
        };
      }
      if (anchor.trusted_keys && Array.isArray(anchor.trusted_keys)) {
        governance.trusted_keys = anchor.trusted_keys;
      }
      if (anchor.revoked_key_ids && Array.isArray(anchor.revoked_key_ids)) {
        governance.revoked_key_ids = Array.from(new Set([...(governance.revoked_key_ids || []), ...anchor.revoked_key_ids]));
      }
    } catch (anchorErr) {
      return { approved: false, reason: `Failed to load independent trust anchor (${trustAnchorPath}): ${anchorErr.message}` };
    }
  } else if (trustAnchorSha) {
    const govRaw = fs.readFileSync(governancePath);
    const govHash = crypto.createHash('sha256').update(govRaw).digest('hex');
    if (govHash.toLowerCase() !== trustAnchorSha.toLowerCase().trim()) {
      return {
        approved: false,
        reason: `TRUST_ANCHOR_SHA_MISMATCH: In-repo release governance hash '${govHash}' does not match GOVERNANCE_TRUST_ANCHOR_SHA256 '${trustAnchorSha}'!`
      };
    }
  }

  // 4. Check immutable historical baseline allowlist (strictly vetted pre-v3 baselines)
  const historicalBaselines = new Set(
    (governance.historical_baseline_allowlist || []).map(s => s.toLowerCase())
  );
  if (historicalBaselines.has(cleanSha)) {
    return {
      approved: true,
      method: 'HISTORICAL_BASELINE',
      sha: cleanSha,
      reason: 'Approved immutable historical production baseline'
    };
  }

  // 5. Resolve Cryptographic Release Ticket
  let ticket = opts.ticket || null;

  if (!ticket) {
    let ticketSource = opts.ticketPath || process.env.RELEASE_APPROVAL_TICKET_FILE;
    if (!ticketSource && opts.ticketArg) {
      ticketSource = opts.ticketArg;
    }

    if (ticketSource) {
      if (typeof ticketSource === 'string' && fs.existsSync(ticketSource)) {
        try {
          ticket = JSON.parse(fs.readFileSync(ticketSource, 'utf8'));
        } catch (err) {
          return { approved: false, reason: `Failed to parse ticket file '${ticketSource}': ${err.message}` };
        }
      } else if (typeof ticketSource === 'string' && ticketSource.trim().startsWith('{')) {
        try {
          ticket = JSON.parse(ticketSource);
        } catch (err) {
          return { approved: false, reason: `Failed to parse JSON ticket argument: ${err.message}` };
        }
      }
    }
  }

  if (!ticket && process.env.RELEASE_APPROVAL_TICKET) {
    try {
      ticket = JSON.parse(process.env.RELEASE_APPROVAL_TICKET);
    } catch (err) {
      return { approved: false, reason: `Failed to parse RELEASE_APPROVAL_TICKET env JSON: ${err.message}` };
    }
  }

  if (!ticket) {
    const defaultTicketPath = path.resolve(__dirname, '..', '..', 'config', 'tickets', `release-${cleanSha}.json`);
    if (fs.existsSync(defaultTicketPath)) {
      try {
        ticket = JSON.parse(fs.readFileSync(defaultTicketPath, 'utf8'));
      } catch (err) {
        return { approved: false, reason: `Failed to parse default ticket file: ${err.message}` };
      }
    }
  }

  if (!ticket) {
    return {
      approved: false,
      reason: `Target commit '${cleanSha}' is not an immutable historical baseline and lacks an authorized cryptographic release ticket.`
    };
  }

  // 6. Validate Ticket Structure
  if (!ticket.payload || typeof ticket.payload !== 'object' || !ticket.signature || !ticket.key_id) {
    return { approved: false, reason: 'Malformed cryptographic release ticket: missing payload, signature, or key_id' };
  }

  const payload = ticket.payload;

  // 7. Assert Target Commit Binding
  if (!payload.target_commit || payload.target_commit.toLowerCase() !== cleanSha) {
    return {
      approved: false,
      reason: `Ticket target_commit mismatch: ticket authorizes '${payload.target_commit || 'NONE'}', but candidate is '${cleanSha}'`
    };
  }

  // 8. Validate Release Tag Pattern & Match
  const approvedTagPattern = opts.approvedTagPattern ||
    (governance.policy && governance.policy.approved_tag_pattern) ||
    '^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc[0-9]+)?$';

  const tagRegex = new RegExp(approvedTagPattern);
  if (!payload.release_tag || typeof payload.release_tag !== 'string' || !tagRegex.test(payload.release_tag.trim())) {
    return {
      approved: false,
      reason: `Ticket release_tag '${payload.release_tag || 'MISSING'}' does not conform to approved release tag pattern: ${approvedTagPattern}`
    };
  }

  const expectedTag = opts.expectedTag || process.env.DEPLOY_RELEASE_TAG;
  if (expectedTag && payload.release_tag.trim() !== expectedTag.trim()) {
    return {
      approved: false,
      reason: `Ticket release_tag mismatch: ticket specifies '${payload.release_tag}', but target deployment tag is '${expectedTag}'`
    };
  }

  // 9. Validate Deployment Environment Binding (Prevents Cross-Environment Replay)
  const targetEnvironment = (opts.expectedEnvironment || process.env.DEPLOY_ENVIRONMENT || 'production').trim().toLowerCase();
  if (!payload.environment || typeof payload.environment !== 'string') {
    return { approved: false, reason: 'Ticket payload is missing mandatory environment field' };
  }

  const ticketEnv = payload.environment.trim().toLowerCase();
  if (ticketEnv !== targetEnvironment) {
    return {
      approved: false,
      reason: `Ticket environment mismatch: ticket is authorized for environment '${ticketEnv}', but deployment target is '${targetEnvironment}'. Cross-environment replay is forbidden.`
    };
  }

  // 10. Verify Key Authorization and Revocation Status
  const revokedKeys = new Set((governance.revoked_key_ids || []).map(k => (typeof k === 'string' ? k : k.key_id)));
  if (revokedKeys.has(ticket.key_id)) {
    return { approved: false, reason: `Signing key '${ticket.key_id}' has been REVOKED by release governance` };
  }

  const trustedKeys = governance.trusted_keys || [];
  const trustedKey = trustedKeys.find(k => k.key_id === ticket.key_id);
  if (!trustedKey) {
    return { approved: false, reason: `Signing key '${ticket.key_id}' is not in the trusted governance keyring` };
  }

  if (!trustedKey.roles || !trustedKey.roles.includes('production_release_approval')) {
    return { approved: false, reason: `Key '${ticket.key_id}' lacks the 'production_release_approval' role` };
  }

  // 11. Verify Key Validity Window (valid_from and valid_until)
  const now = opts.now || Date.now();
  if (trustedKey.valid_from) {
    const validFrom = new Date(trustedKey.valid_from).getTime();
    if (isNaN(validFrom) || now < validFrom) {
      return {
        approved: false,
        reason: `Signing key '${ticket.key_id}' is NOT YET VALID (valid_from: ${trustedKey.valid_from})`
      };
    }
  }

  if (trustedKey.valid_until) {
    const validUntil = new Date(trustedKey.valid_until).getTime();
    if (isNaN(validUntil) || now > validUntil) {
      return {
        approved: false,
        reason: `Signing key '${ticket.key_id}' has EXPIRED (valid_until: ${trustedKey.valid_until})`
      };
    }
  }

  // 12. Verify Ticket Freshness & Expiration Window
  if (payload.expires_at) {
    const expiresAt = new Date(payload.expires_at).getTime();
    if (isNaN(expiresAt) || now > expiresAt) {
      return { approved: false, reason: `Release approval ticket EXPIRED at ${payload.expires_at}` };
    }
  }

  const maxHours = governance.policy?.max_ticket_validity_hours || 72;
  if (payload.issued_at) {
    const issuedAt = new Date(payload.issued_at).getTime();
    if (isNaN(issuedAt) || now - issuedAt > maxHours * 3600 * 1000) {
      return { approved: false, reason: `Release approval ticket exceeds maximum allowable validity window of ${maxHours} hours` };
    }
    if (issuedAt > now + 300000) { // 5 min future clock skew tolerance
      return { approved: false, reason: `Release approval ticket has an invalid future issued_at timestamp` };
    }
  } else {
    return { approved: false, reason: 'Release approval ticket is missing issued_at timestamp' };
  }

  // 13. Cryptographic Signature Verification
  const canonicalBytes = Buffer.from(canonicalizePayload(payload), 'utf8');
  let signatureVerified = false;

  try {
    const signatureBuf = Buffer.from(ticket.signature, 'base64');
    signatureVerified = crypto.verify(null, canonicalBytes, trustedKey.public_key, signatureBuf);
  } catch (verifyErr) {
    return { approved: false, reason: `Cryptographic signature verification exception: ${verifyErr.message}` };
  }

  if (!signatureVerified) {
    return { approved: false, reason: 'Cryptographic signature verification FAILED. Ticket was tampered with or signed with an unauthorized key.' };
  }

  return {
    approved: true,
    method: 'CRYPTOGRAPHIC_DETACHED_TICKET',
    key_id: ticket.key_id,
    signer: trustedKey.owner,
    target_commit: cleanSha,
    release_tag: payload.release_tag,
    environment: payload.environment
  };
}

function main() {
  const targetSha = process.argv[2] || process.env.APPROVED_RELEASE_SHA;
  const ticketArg = process.argv[3];
  const result = verifyReleaseApproval(targetSha, { ticketArg });

  if (!result.approved) {
    console.error(`❌ [RELEASE_APPROVAL_REJECTED]: ${result.reason}`);
    console.error('   Deployment CANNOT proceed without valid cryptographic approval from an authorized release governor.');
    process.exit(1);
  }

  console.log(`✔ Release target verified as APPROVED via ${result.method}: ${result.target_commit || targetSha}`);
  if (result.signer) console.log(`   Signed by: ${result.signer} (${result.key_id}) [tag: ${result.release_tag}, env: ${result.environment}]`);
}

if (require.main === module) {
  main();
}

module.exports = { verifyReleaseApproval };
