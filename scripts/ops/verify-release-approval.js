'use strict';

/**
 * Mr. Tumi Marketplace — Cryptographic Release Governance & Target Approval Verifier
 *
 * Enforces that only cryptographically signed release candidates signed by an
 * authorized release governor's offline private key can be deployed.
 *
 * Security Guarantees:
 * 1. ZERO plaintext string signoffs or ambient bypasses (ALLOW_UNLISTED_RELEASE_SHA removed).
 * 2. Trust root resides exclusively in authorized public keys within config/release-governance.json.
 * 3. Detached cryptographic signatures decouple release approval from candidate commits,
 *    eliminating circular self-referential git commit issues.
 * 4. Immutable historical baselines are strictly allowlisted by immutable commit SHA.
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

  // 2. Load release governance configuration
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

  // 3. Check immutable historical baseline allowlist (strictly vetted pre-v3 baselines)
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

  // 4. Resolve Cryptographic Release Ticket
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

  // 5. Validate Ticket Structure
  if (!ticket.payload || typeof ticket.payload !== 'object' || !ticket.signature || !ticket.key_id) {
    return { approved: false, reason: 'Malformed cryptographic release ticket: missing payload, signature, or key_id' };
  }

  const payload = ticket.payload;

  // 6. Assert Target Commit Binding
  if (!payload.target_commit || payload.target_commit.toLowerCase() !== cleanSha) {
    return {
      approved: false,
      reason: `Ticket target_commit mismatch: ticket authorizes '${payload.target_commit || 'NONE'}', but candidate is '${cleanSha}'`
    };
  }

  // 7. Verify Key Authorization and Revocation Status
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

  // 8. Verify Freshness & Expiration Window
  const now = opts.now || Date.now();
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

  // 9. Cryptographic Signature Verification
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
    release_tag: payload.release_tag || 'release'
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
  if (result.signer) console.log(`   Signed by: ${result.signer} (${result.key_id})`);
}

if (require.main === module) {
  main();
}

module.exports = { verifyReleaseApproval };
