const crypto = require('crypto');
const db = require('../db/database');

const COOKIE_NAME = 'pholbazar_sid';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function ensureSessionTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (_e) {
        out[k] = v;
      }
    }
  }
  return out;
}

function isValidSid(val) {
  return typeof val === 'string' && /^[a-f0-9]{24,64}$/i.test(val.trim());
}

function appendSidToUrl(targetUrl, sid) {
  if (!targetUrl || !sid) return targetUrl;
  const str = String(targetUrl);
  // Only append to relative internal paths
  if (!str.startsWith('/') || str.startsWith('//')) return str;
  const [pathAndQuery, hash] = str.split('#');
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  if (pathAndQuery.includes('_sid=')) return str;
  return `${pathAndQuery}${sep}_sid=${encodeURIComponent(sid)}${hash ? '#' + hash : ''}`;
}

function sessionManager(req, res, next) {
  ensureSessionTable();

  const cookies = parseCookies(req.headers.cookie);
  const cookieSid = cookies[COOKIE_NAME];
  const headerSid = req.headers['x-pb-sid'];
  const bodySid = req.body && typeof req.body === 'object' ? req.body._sid : undefined;
  const querySid = req.query ? req.query._sid : undefined;

  // Prefer explicit token from header/body/query if cookie was blocked in cross-origin iframe,
  // or cookie if present and valid.
  let sid = null;
  let cameWithoutCookie = false;

  for (const candidate of [headerSid, bodySid, querySid, cookieSid]) {
    if (isValidSid(candidate)) {
      sid = candidate.trim();
      break;
    }
  }

  if (!cookieSid || cookieSid !== sid) {
    cameWithoutCookie = true;
  }

  let sessionObj = {};
  if (sid) {
    const row = db.get('SELECT data FROM web_sessions WHERE sid = ?', sid);
    if (row && row.data) {
      try {
        sessionObj = JSON.parse(row.data) || {};
      } catch (_e) {
        sessionObj = {};
      }
    } else {
      db.run('INSERT OR IGNORE INTO web_sessions (sid, data) VALUES (?, ?)', sid, '{}');
    }
  } else {
    sid = crypto.randomBytes(20).toString('hex');
    cameWithoutCookie = true;
    db.run('INSERT INTO web_sessions (sid, data) VALUES (?, ?)', sid, '{}');
  }

  // Clean internal _sid from req.body so generic CRUD forms don't see it as a table field
  if (req.body && typeof req.body === 'object' && '_sid' in req.body) {
    delete req.body._sid;
  }

  req.sessionID = sid;
  req.session = sessionObj;
  req.session.save = (cb) => {
    persistSession();
    if (typeof cb === 'function') cb();
  };
  req.session.destroy = (cb) => {
    try {
      db.run('DELETE FROM web_sessions WHERE sid = ?', sid);
    } catch (_e) {}
    for (const k of Object.keys(req.session)) {
      if (k !== 'save' && k !== 'destroy') delete req.session[k];
    }
    if (typeof cb === 'function') cb();
  };

  function persistSession() {
    try {
      const clone = {};
      for (const [k, v] of Object.entries(req.session || {})) {
        if (typeof v !== 'function') clone[k] = v;
      }
      const serialized = JSON.stringify(clone);
      db.run(
        `INSERT INTO web_sessions (sid, data, updated_at)
         VALUES (?, ?, datetime('now', 'localtime'))
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        sid,
        serialized
      );
    } catch (err) {
      console.error('Session persist error:', err);
    }
  }

  // Set cross-iframe compatible cookie (SameSite=None; Secure; Partitioned on HTTPS, SameSite=Lax on HTTP)
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');

  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
  ];
  if (isHttps) {
    cookieParts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    cookieParts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  res.setHeader('X-PB-Sid', sid);

  // Wrap res.redirect so sessions survive redirects even when browser blocks 3rd-party cookies in iframe
  const origRedirect = res.redirect.bind(res);
  res.redirect = function (statusOrUrl, maybeUrl) {
    persistSession();
    if (typeof statusOrUrl === 'number') {
      const target = cameWithoutCookie ? appendSidToUrl(maybeUrl, sid) : maybeUrl;
      return origRedirect(statusOrUrl, target);
    }
    const target = cameWithoutCookie ? appendSidToUrl(statusOrUrl, sid) : statusOrUrl;
    return origRedirect(target);
  };

  // Persist session automatically before headers/body flush
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    persistSession();
    return origEnd(...args);
  };

  next();
}

module.exports = sessionManager;
