'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const sqliteDb = require('../db/database');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { logger } = require('../utils/logger');

function isMysql() {
  return env.db.client === 'mysql';
}

function parseDevice(userAgent = '') {
  const ua = String(userAgent || '').toLowerCase();

  // 1. Device Type
  let deviceType = 'Desktop';
  if (/(ipad|playbook|tablet|(android(?!.*mobile)))/i.test(ua)) {
    deviceType = 'Tablet';
  } else if (/(mobile|iphone|ipod|android|blackberry|iemobile|opera mini|webos|windows phone)/i.test(ua)) {
    deviceType = 'Mobile';
  }

  // 2. Browser Detection (Specific to generic)
  let browser = 'Other';
  if (ua.includes('fbav') || ua.includes('fban')) {
    browser = 'Facebook In-App';
  } else if (ua.includes('instagram')) {
    browser = 'Instagram In-App';
  } else if (ua.includes('bytedance') || ua.includes('tiktok') || ua.includes('musical_ly')) {
    browser = 'TikTok In-App';
  } else if (ua.includes('samsungbrowser')) {
    browser = 'Samsung Internet';
  } else if (ua.includes('edg/') || ua.includes('edge/')) {
    browser = 'Edge';
  } else if (ua.includes('opr/') || ua.includes('opera')) {
    browser = 'Opera';
  } else if (ua.includes('firefox/') || ua.includes('fxios/')) {
    browser = 'Firefox';
  } else if (ua.includes('chrome/') || ua.includes('crios/')) {
    browser = 'Chrome';
  } else if (ua.includes('safari/') && !ua.includes('chrome')) {
    browser = 'Safari';
  }

  // 3. Operating System
  let os = 'Other';
  if (ua.includes('windows')) {
    os = 'Windows';
  } else if (ua.includes('android')) {
    os = 'Android';
  } else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) {
    os = 'iOS';
  } else if (ua.includes('macintosh') || ua.includes('mac os')) {
    os = 'macOS';
  } else if (ua.includes('linux')) {
    os = 'Linux';
  }

  return { deviceType, browser, os };
}

function parsePlatform(referrerHeader = '', query = {}, host = '') {
  const ref = String(referrerHeader || '').trim();
  const utmSource = String(query.utm_source || '').toLowerCase().trim();
  const utmMedium = String(query.utm_medium || '').toLowerCase().trim();
  const utmCampaign = String(query.utm_campaign || '').toLowerCase().trim();

  let referrerDomain = '';
  if (ref) {
    try {
      const u = new URL(ref.startsWith('http') ? ref : `https://${ref}`);
      referrerDomain = u.hostname.replace(/^www\./, '');
    } catch (_) {
      referrerDomain = ref.slice(0, 60);
    }
  }

  // Check clicks / campaign params first
  if (query.fbclid || utmSource.includes('facebook') || utmSource === 'fb' || referrerDomain.includes('facebook.com') || referrerDomain.includes('fb.com')) {
    return { platformSource: 'Facebook', referrerDomain: referrerDomain || 'facebook.com', utmSource, utmMedium, utmCampaign };
  }
  if (query.ttclid || utmSource.includes('tiktok') || referrerDomain.includes('tiktok.com')) {
    return { platformSource: 'TikTok', referrerDomain: referrerDomain || 'tiktok.com', utmSource, utmMedium, utmCampaign };
  }
  if (query.gclid || utmSource.includes('google') || referrerDomain.includes('google.com') || referrerDomain.includes('google.com.bd')) {
    return { platformSource: 'Google', referrerDomain: referrerDomain || 'google.com', utmSource, utmMedium, utmCampaign };
  }
  if (utmSource.includes('youtube') || referrerDomain.includes('youtube.com') || referrerDomain.includes('youtu.be')) {
    return { platformSource: 'YouTube', referrerDomain: referrerDomain || 'youtube.com', utmSource, utmMedium, utmCampaign };
  }
  if (utmSource.includes('instagram') || referrerDomain.includes('instagram.com')) {
    return { platformSource: 'Instagram', referrerDomain: referrerDomain || 'instagram.com', utmSource, utmMedium, utmCampaign };
  }

  // If internal referrer or self domain, it's Direct
  if (!referrerDomain || (host && referrerDomain === host.replace(/^www\./, ''))) {
    if (utmSource) {
      return { platformSource: 'Campaign', referrerDomain: utmSource, utmSource, utmMedium, utmCampaign };
    }
    return { platformSource: 'Direct', referrerDomain: 'direct', utmSource, utmMedium, utmCampaign };
  }

  return {
    platformSource: referrerDomain.length > 0 ? 'Other' : 'Direct',
    referrerDomain,
    utmSource,
    utmMedium,
    utmCampaign
  };
}

/**
 * Record a storefront visitor page view
 */
async function recordVisitorEvent(req) {
  // Only track GET requests
  if (req.method !== 'GET') return;

  const url = req.originalUrl || req.url || '/';
  // Exclude static assets, admin, vendor, reseller, and api paths
  if (
    url.startsWith('/frontEnd/') ||
    url.startsWith('/shared/') ||
    url.startsWith('/uploads/') ||
    url.startsWith('/api/') ||
    url.startsWith('/admin') ||
    url.startsWith('/vendor') ||
    url.startsWith('/reseller') ||
    url.includes('.css') ||
    url.includes('.js') ||
    url.includes('.png') ||
    url.includes('.jpg') ||
    url.includes('.ico') ||
    url.includes('.svg') ||
    url.includes('.woff')
  ) {
    return;
  }

  // Deduplicate rapid reloads in the same session (max 1 track per 20 seconds for same URL)
  const now = Date.now();
  const sessionTracks = req.session ? (req.session._lastVisitorTracks || {}) : null;
  if (sessionTracks && sessionTracks[url] && (now - sessionTracks[url]) < 20000) {
    return;
  }
  if (req.session) {
    req.session._lastVisitorTracks = req.session._lastVisitorTracks || {};
    req.session._lastVisitorTracks[url] = now;
  }

  const userAgent = req.get('user-agent') || '';
  const refHeader = req.get('referrer') || req.get('referer') || '';
  const host = req.get('host') || '';

  const { deviceType, browser, os } = parseDevice(userAgent);
  const { platformSource, referrerDomain, utmSource, utmMedium, utmCampaign } = parsePlatform(refHeader, req.query || {}, host);

  const sessionSid = String(req.sessionID || '').slice(0, 128);
  const eventId = `ve_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const pagePath = url.split('?')[0].slice(0, 255);
  const clientIp = req.ip || '';
  const ipHash = clientIp ? crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 64) : '';

  try {
    if (isMysql()) {
      const db = createQueryClient(getPool());
      await db.execute(
        `INSERT INTO visitor_events
        (session_sid, event_name, event_id, platform_source, utm_source, utm_medium, utm_campaign, page_path, device_type, browser, os, referrer_domain, ip_hash)
        VALUES (?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionSid,
          eventId,
          platformSource,
          utmSource || '',
          utmMedium || '',
          utmCampaign || '',
          pagePath,
          deviceType,
          browser,
          os,
          referrerDomain,
          ipHash
        ]
      );
    } else {
      // SQLite fallback
      try {
        sqliteDb.run(
          `INSERT INTO visitor_events
          (session_sid, event_name, event_id, platform_source, utm_source, utm_medium, utm_campaign, page_path, device_type, browser, os, referrer_domain, ip_hash)
          VALUES (?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionSid,
          eventId,
          platformSource,
          utmSource || '',
          utmMedium || '',
          utmCampaign || '',
          pagePath,
          deviceType,
          browser,
          os,
          referrerDomain,
          ipHash
        );
      } catch (_e) {
        // Create table in SQLite if it was missing
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS visitor_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_sid TEXT NOT NULL DEFAULT '',
          event_name TEXT NOT NULL DEFAULT 'page_view',
          event_id TEXT NOT NULL,
          platform_source TEXT NOT NULL DEFAULT 'Direct',
          utm_source TEXT NOT NULL DEFAULT '',
          utm_medium TEXT NOT NULL DEFAULT '',
          utm_campaign TEXT NOT NULL DEFAULT '',
          page_path TEXT NOT NULL DEFAULT '/',
          device_type TEXT NOT NULL DEFAULT 'Desktop',
          browser TEXT NOT NULL DEFAULT 'Other',
          os TEXT NOT NULL DEFAULT 'Other',
          referrer_domain TEXT NOT NULL DEFAULT '',
          ip_hash TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        sqliteDb.run(
          `INSERT INTO visitor_events
          (session_sid, event_name, event_id, platform_source, utm_source, utm_medium, utm_campaign, page_path, device_type, browser, os, referrer_domain, ip_hash)
          VALUES (?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionSid,
          eventId,
          platformSource,
          utmSource || '',
          utmMedium || '',
          utmCampaign || '',
          pagePath,
          deviceType,
          browser,
          os,
          referrerDomain,
          ipHash
        );
      }
    }
  } catch (err) {
    // Non-blocking catch for analytics logging
    logger.warn('Failed to record visitor event: ' + err.message);
  }
}

/**
 * Get aggregated visitor and platform analytics data for dashboard
 */
async function getVisitorAnalytics() {
  try {
    if (isMysql()) {
      const db = createQueryClient(getPool());

      const [platformRows, deviceRows, browserRows, totalRow, todayRow] = await Promise.all([
        db.queryAll(`SELECT COALESCE(NULLIF(platform_source, ''), 'Direct') AS source, COUNT(*) AS count
          FROM visitor_events GROUP BY source ORDER BY count DESC`),
        db.queryAll(`SELECT COALESCE(NULLIF(device_type, ''), 'Desktop') AS device, COUNT(*) AS count
          FROM visitor_events GROUP BY device ORDER BY count DESC`),
        db.queryAll(`SELECT COALESCE(NULLIF(browser, ''), 'Other') AS browser, COUNT(*) AS count
          FROM visitor_events GROUP BY browser ORDER BY count DESC LIMIT 5`),
        db.queryOne(`SELECT COUNT(*) AS total_views, COUNT(DISTINCT session_sid) AS unique_visitors FROM visitor_events`),
        db.queryOne(`SELECT COUNT(*) AS today_views, COUNT(DISTINCT session_sid) AS today_visitors
          FROM visitor_events WHERE created_at >= CURDATE()`)
      ]);

      const totalViews = Number(totalRow?.total_views || 0);
      const totalVisitors = Number(totalRow?.unique_visitors || 0);
      const todayVisitors = Number(todayRow?.today_visitors || 0);

      const platforms = platformRows.map(r => ({
        source: r.source,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      const devices = deviceRows.map(r => ({
        device: r.device,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      const browsers = browserRows.map(r => ({
        browser: r.browser,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      return {
        totalViews,
        totalVisitors,
        todayVisitors,
        platforms,
        devices,
        browsers
      };
    } else {
      // SQLite queries
      let platformRows = [];
      let deviceRows = [];
      let browserRows = [];
      let totalViews = 0;
      let totalVisitors = 0;
      let todayVisitors = 0;

      try {
        platformRows = sqliteDb.all(`SELECT COALESCE(NULLIF(platform_source, ''), 'Direct') AS source, COUNT(*) AS count
          FROM visitor_events GROUP BY source ORDER BY count DESC`);
        deviceRows = sqliteDb.all(`SELECT COALESCE(NULLIF(device_type, ''), 'Desktop') AS device, COUNT(*) AS count
          FROM visitor_events GROUP BY device ORDER BY count DESC`);
        browserRows = sqliteDb.all(`SELECT COALESCE(NULLIF(browser, ''), 'Other') AS browser, COUNT(*) AS count
          FROM visitor_events GROUP BY browser ORDER BY count DESC LIMIT 5`);
        const total = sqliteDb.get(`SELECT COUNT(*) AS total_views, COUNT(DISTINCT session_sid) AS unique_visitors FROM visitor_events`);
        totalViews = Number(total?.total_views || 0);
        totalVisitors = Number(total?.unique_visitors || 0);
        const today = sqliteDb.get(`SELECT COUNT(DISTINCT session_sid) AS today_visitors FROM visitor_events WHERE date(created_at) = date('now')`);
        todayVisitors = Number(today?.today_visitors || 0);
      } catch (_) {
        // In case table was not queried yet
      }

      // If empty in dev, provide standard zeroed baseline with defaults
      const platforms = (platformRows.length ? platformRows : [
        { source: 'Direct', count: 0 },
        { source: 'Facebook', count: 0 },
        { source: 'TikTok', count: 0 },
        { source: 'Google', count: 0 }
      ]).map(r => ({
        source: r.source,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      const devices = (deviceRows.length ? deviceRows : [
        { device: 'Mobile', count: 0 },
        { device: 'Desktop', count: 0 },
        { device: 'Tablet', count: 0 }
      ]).map(r => ({
        device: r.device,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      const browsers = browserRows.map(r => ({
        browser: r.browser,
        count: Number(r.count),
        percent: totalViews > 0 ? ((Number(r.count) / totalViews) * 100).toFixed(1) : '0.0'
      }));

      return {
        totalViews,
        totalVisitors,
        todayVisitors,
        platforms,
        devices,
        browsers
      };
    }
  } catch (err) {
    logger.warn('Failed to retrieve visitor analytics: ' + err.message);
    return {
      totalViews: 0,
      totalVisitors: 0,
      todayVisitors: 0,
      platforms: [{ source: 'Direct', count: 0, percent: '0.0' }],
      devices: [{ device: 'Mobile', count: 0, percent: '0.0' }, { device: 'Desktop', count: 0, percent: '0.0' }],
      browsers: []
    };
  }
}

module.exports = {
  parseDevice,
  parsePlatform,
  recordVisitorEvent,
  getVisitorAnalytics
};
