'use strict';

const net = require('net');
const dns = require('dns').promises;
const { ValidationError } = require('./errors');

/**
 * Approved top-level root domains for courier API integrations.
 * Subdomains (e.g. portal.packzy.com, api-hermes.pathao.com, openapi.redx.com.bd) are allowed.
 */
const APPROVED_COURIER_ROOT_DOMAINS = [
  'steadfast.com.bd',
  'packzy.com',
  'pathao.com',
  'redx.com.bd',
  'paperfly.com.bd',
  'ecourier.com.bd',
  'bdcourier.com',
];

/**
 * Checks whether an IPv4 or IPv6 address belongs to private, loopback, link-local,
 * metadata (e.g. AWS/GCP/Azure 169.254.169.254), carrier NAT, or reserved ranges.
 */
function isPrivateOrReservedIp(ipString) {
  if (typeof ipString !== 'string') return true;
  const ip = ipString.trim();

  // Handle IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 or ::ffff:10.0.0.1)
  if (ip.startsWith('::ffff:')) {
    const v4Part = ip.slice(7);
    if (net.isIPv4(v4Part)) {
      return isPrivateOrReservedIp(v4Part);
    }
  }

  const kind = net.isIP(ip);
  if (kind === 0) return true; // not a valid IP

  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b, c] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;

    // 10.0.0.0/8 (Private Class A)
    if (a === 10) return true;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;

    // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 169.254.0.0/16 (Link-local & cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 172.16.0.0/12 (Private Class B)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;

    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return true;

    // 192.168.0.0/16 (Private Class C)
    if (a === 192 && b === 168) return true;

    // 198.18.0.0/15 (Network benchmark tests)
    if (a === 198 && (b === 18 || b === 19)) return true;

    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;

    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
    if (a >= 224) return true;

    return false;
  }

  if (kind === 6) {
    const lower = ip.toLowerCase();

    // ::1 (Loopback) & :: (Unspecified)
    if (lower === '::1' || lower === '::') return true;

    // fc00::/7 (Unique Local Address)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

    // fe80::/10 (Link-Local unicast)
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }

    // ff00::/8 (Multicast)
    if (lower.startsWith('ff')) return true;

    return false;
  }

  return true;
}

/**
 * Checks if a hostname matches an approved courier provider domain.
 */
function isApprovedCourierDomain(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase().trim();

  // Reject IP literals immediately
  if (net.isIP(host) !== 0) return false;

  // Reject local/internal domain suffixes
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.test') ||
    host.endsWith('.example')
  ) {
    return false;
  }

  // Must match one of the approved courier root domains
  return APPROVED_COURIER_ROOT_DOMAINS.some(
    (root) => host === root || host.endsWith('.' + root)
  );
}

/**
 * Validates a courier API base URL against SSRF threats.
 * Checks protocol, credentials, hostname whitelist, and resolves DNS to ensure
 * destination addresses are strictly public and non-private.
 */
async function validateCourierBaseUrl(candidateUrl, { dnsResolver = null } = {}) {
  if (!candidateUrl || typeof candidateUrl !== 'string') {
    return '';
  }
  const trimmed = candidateUrl.trim();
  if (trimmed === '') return '';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_e) {
    throw new ValidationError('Invalid Courier API URL format.');
  }

  // 1. Enforce HTTPS only (reject HTTP, FTP, file, gopher, etc.)
  if (parsed.protocol !== 'https:') {
    throw new ValidationError('Courier API URL must use secure HTTPS protocol.');
  }

  // 2. Reject embedded credentials in authority
  if (parsed.username || parsed.password) {
    throw new ValidationError('Courier API URL cannot contain embedded credentials.');
  }

  // 3. Reject non-standard ports
  if (parsed.port && parsed.port !== '443') {
    throw new ValidationError('Courier API URL must use standard HTTPS port 443.');
  }

  const hostname = parsed.hostname.toLowerCase();

  // 4. Check hostname against approved courier domains
  if (!isApprovedCourierDomain(hostname)) {
    throw new ValidationError(
      `Courier API domain "${hostname}" is not an approved provider host. Approved providers: Steadfast, Pathao, RedX, Paperfly, eCourier, BD Courier.`
    );
  }

  // 5. DNS Resolution and IP validation to prevent DNS rebinding and internal network targets
  const lookupFn = dnsResolver || dns.lookup;
  let addresses = [];
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch (err) {
    throw new ValidationError(`Failed to resolve Courier API domain "${hostname}": ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new ValidationError(`Courier API domain "${hostname}" did not resolve to any IP address.`);
  }

  for (const record of addresses) {
    const resolvedIp = typeof record === 'string' ? record : record.address;
    if (isPrivateOrReservedIp(resolvedIp)) {
      throw new ValidationError(
        `Security violation: Courier API domain resolved to a restricted internal/private IP address.`
      );
    }
  }

  return trimmed;
}

module.exports = {
  isPrivateOrReservedIp,
  isApprovedCourierDomain,
  validateCourierBaseUrl,
  APPROVED_COURIER_ROOT_DOMAINS,
};
