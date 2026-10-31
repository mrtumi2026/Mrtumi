'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const {
  getActiveSession,
  upsertSession,
  deleteSession,
  purgeExpiredSessions,
} = require('../repositories/sessionRepository');
const { getClientIp } = require('./rateLimit');

const COOKIE_NAME = 'pholbazar_sid';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const TTL_MS = MAX_AGE_SECONDS * 1000;

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
  if (!str.startsWith('/') || str.startsWith('//')) return str;
  const [pathAndQuery, hash] = str.split('#');
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  if (pathAndQuery.includes('_sid=')) return str;
  return `${pathAndQuery}${sep}_sid=${encodeURIComponent(sid)}${hash ? '#' + hash : ''}`;
}

function buildCookieHeader(req, sid) {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');

  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
  ];

  if (env.isProduction) {
    cookieParts.push('SameSite=Lax', 'Secure');
  } else if (isHttps) {
    cookieParts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    cookieParts.push('SameSite=Lax');
  }
  return cookieParts.join('; ');
}

function detectSessionActor(sess) {
  if (!sess) return { actorType: null, actorId: null };
  if (sess.adminUser && sess.adminUser.id) {
    return { actorType: 'admin', actorId: Number(sess.adminUser.id) };
  }
  if (sess.vendorUser && sess.vendorUser.id) {
    return { actorType: 'vendor', actorId: Number(sess.vendorUser.id) };
  }
  if (sess.resellerUser && sess.resellerUser.id) {
    return { actorType: 'reseller', actorId: Number(sess.resellerUser.id) };
  }
  if (sess.customerUser && sess.customerUser.id) {
    return { actorType: 'customer', actorId: Number(sess.customerUser.id) };
  }
  return { actorType: null, actorId: null };
}

/**
 * Async database-backed session middleware supporting MySQL (`web_sessions`) in production/CI
 * and SQLite (`web_sessions`) in local non-production fallback.
 */
async function sessionManager(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const cookieSid = cookies[COOKIE_NAME];
    const headerSid = !env.isProduction ? req.headers['x-pb-sid'] : undefined;
    const bodySid =
      !env.isProduction && req.body && typeof req.body === 'object' ? req.body._sid : undefined;
    const querySid = !env.isProduction && req.query ? req.query._sid : undefined;

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

    const now = Date.now();
    let sessionObj = {};

    if (sid) {
      const existing = await getActiveSession(sid, now);
      if (existing && existing.dataJson) {
        try {
          sessionObj = JSON.parse(existing.dataJson) || {};
        } catch (_e) {
          sessionObj = {};
        }
      }
    } else {
      sid = crypto.randomBytes(20).toString('hex');
      cameWithoutCookie = true;
    }

    // Clean internal _sid from req.body so generic CRUD forms never see it as a table field
    if (req.body && typeof req.body === 'object' && '_sid' in req.body) {
      delete req.body._sid;
    }

    let destroyed = false;
    let lastPersistedSnapshot = null;

    const persistSession = async () => {
      if (destroyed) return;
      const clone = {};
      for (const [k, v] of Object.entries(req.session || {})) {
        if (typeof v !== 'function') clone[k] = v;
      }
      const serialized = JSON.stringify(clone);
      if (serialized === lastPersistedSnapshot) {
        return;
      }
      const { actorType, actorId } = detectSessionActor(clone);
      await upsertSession({
        sid,
        dataJson: serialized,
        expiresAtMs: Date.now() + TTL_MS,
        ipAddress: getClientIp(req),
        actorType,
        actorId,
      });
      lastPersistedSnapshot = serialized;
    };

    function attachSessionMethods(targetObj) {
      Object.defineProperty(targetObj, 'save', {
        enumerable: false,
        configurable: true,
        value(cb) {
          return persistSession()
            .then(() => {
              if (typeof cb === 'function') cb(null);
            })
            .catch((err) => {
              if (typeof cb === 'function') cb(err);
              else throw err;
            });
        },
      });

      Object.defineProperty(targetObj, 'destroy', {
        enumerable: false,
        configurable: true,
        value(cb) {
          destroyed = true;
          return deleteSession(sid)
            .then(() => {
              for (const k of Object.keys(req.session)) {
                delete req.session[k];
              }
              if (typeof cb === 'function') cb(null);
            })
            .catch((err) => {
              if (typeof cb === 'function') cb(err);
              else throw err;
            });
        },
      });

      Object.defineProperty(targetObj, 'regenerate', {
        enumerable: false,
        configurable: true,
        value(cb) {
          const oldSid = sid;
          sid = crypto.randomBytes(20).toString('hex');
          req.sessionID = sid;
          res.locals.sessionToken = sid;
          lastPersistedSnapshot = null;
          if (!res.headersSent) {
            res.setHeader('Set-Cookie', buildCookieHeader(req, sid));
          }
          return deleteSession(oldSid)
            .then(() => persistSession())
            .then(() => {
              if (typeof cb === 'function') cb(null);
            })
            .catch((err) => {
              if (typeof cb === 'function') cb(err);
              else throw err;
            });
        },
      });
    }

    attachSessionMethods(sessionObj);
    req.sessionID = sid;
    req.session = sessionObj;

    res.setHeader('Set-Cookie', buildCookieHeader(req, sid));
    if (!env.isProduction) {
      res.setHeader('X-PB-Sid', sid);
    }

    const origRedirect = res.redirect.bind(res);
    res.redirect = function patchedRedirect(statusOrUrl, maybeUrl) {
      persistSession()
        .then(() => {
          if (typeof statusOrUrl === 'number') {
            const target =
              !env.isProduction && cameWithoutCookie ? appendSidToUrl(maybeUrl, sid) : maybeUrl;
            return origRedirect(statusOrUrl, target);
          }
          const target =
            !env.isProduction && cameWithoutCookie
              ? appendSidToUrl(statusOrUrl, sid)
              : statusOrUrl;
          return origRedirect(target);
        })
        .catch(next);
    };

    const origRender = res.render.bind(res);
    res.render = function patchedRender(...args) {
      persistSession()
        .then(() => origRender(...args))
        .catch(next);
    };

    const origJson = res.json.bind(res);
    res.json = function patchedJson(body) {
      persistSession()
        .then(() => origJson(body))
        .catch(next);
    };

    const origEnd = res.end.bind(res);
    res.end = function patchedEnd(...args) {
      persistSession().catch(() => {});
      return origEnd(...args);
    };

    if (Math.random() < 0.01) {
      purgeExpiredSessions(now).catch(() => {});
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = sessionManager;
