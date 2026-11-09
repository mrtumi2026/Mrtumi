'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const visitorTracking = require('../src/services/visitorTrackingService');

test('parseDevice accurately identifies Mobile, Tablet, Desktop and Browsers', () => {
  // Mobile Android
  const androidUa = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const dev1 = visitorTracking.parseDevice(androidUa);
  assert.equal(dev1.deviceType, 'Mobile');
  assert.equal(dev1.browser, 'Chrome');
  assert.equal(dev1.os, 'Android');

  // iPhone Safari
  const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
  const dev2 = visitorTracking.parseDevice(iphoneUa);
  assert.equal(dev2.deviceType, 'Mobile');
  assert.equal(dev2.browser, 'Safari');
  assert.equal(dev2.os, 'iOS');

  // iPad Tablet
  const ipadUa = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  const dev3 = visitorTracking.parseDevice(ipadUa);
  assert.equal(dev3.deviceType, 'Tablet');
  assert.equal(dev3.os, 'iOS');

  // Desktop Windows
  const desktopUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
  const dev4 = visitorTracking.parseDevice(desktopUa);
  assert.equal(dev4.deviceType, 'Desktop');
  assert.equal(dev4.browser, 'Edge');
  assert.equal(dev4.os, 'Windows');

  // TikTok In-App Browser
  const tiktokUa = 'Mozilla/5.0 (Linux; Android 13; Build/TP1A) AppleWebKit/537.36 ByAppName/TikTok Mobile Safari/537.36';
  const dev5 = visitorTracking.parseDevice(tiktokUa);
  assert.equal(dev5.browser, 'TikTok In-App');

  // Facebook In-App Browser
  const fbUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 [FBAN/FBIOS;FBAV/435.0.0.35.112]';
  const dev6 = visitorTracking.parseDevice(fbUa);
  assert.equal(dev6.browser, 'Facebook In-App');
});

test('parsePlatform detects Facebook, TikTok, Google, YouTube, Instagram, Direct, and Other', () => {
  // Facebook via fbclid
  const p1 = visitorTracking.parsePlatform('', { fbclid: 'IwAR012345' }, 'mrtumi.com');
  assert.equal(p1.platformSource, 'Facebook');

  // Facebook via referrer
  const p2 = visitorTracking.parsePlatform('https://l.facebook.com/', {}, 'mrtumi.com');
  assert.equal(p2.platformSource, 'Facebook');

  // TikTok via ttclid
  const p3 = visitorTracking.parsePlatform('', { ttclid: 'tt_click_123' }, 'mrtumi.com');
  assert.equal(p3.platformSource, 'TikTok');

  // TikTok via referrer
  const p4 = visitorTracking.parsePlatform('https://www.tiktok.com/@mrtumi', {}, 'mrtumi.com');
  assert.equal(p4.platformSource, 'TikTok');

  // Google via gclid
  const p5 = visitorTracking.parsePlatform('', { gclid: 'google_click_abc' }, 'mrtumi.com');
  assert.equal(p5.platformSource, 'Google');

  // Google via organic search referrer
  const p6 = visitorTracking.parsePlatform('https://www.google.com.bd/', {}, 'mrtumi.com');
  assert.equal(p6.platformSource, 'Google');

  // YouTube
  const p7 = visitorTracking.parsePlatform('https://www.youtube.com/watch?v=123', {}, 'mrtumi.com');
  assert.equal(p7.platformSource, 'YouTube');

  // Instagram
  const p8 = visitorTracking.parsePlatform('https://l.instagram.com/', {}, 'mrtumi.com');
  assert.equal(p8.platformSource, 'Instagram');

  // Direct (no external referrer, no params)
  const p9 = visitorTracking.parsePlatform('', {}, 'mrtumi.com');
  assert.equal(p9.platformSource, 'Direct');

  // Other external site
  const p10 = visitorTracking.parsePlatform('https://techblog.com.bd/article-review', {}, 'mrtumi.com');
  assert.equal(p10.platformSource, 'Other');
  assert.equal(p10.referrerDomain, 'techblog.com.bd');
});

test('visitor tracking records visit and retrieves structured analytics', async () => {
  const dummyReq = {
    method: 'GET',
    originalUrl: '/product/lychee-fresh',
    url: '/product/lychee-fresh',
    sessionID: 'analytics_test_session_' + Date.now(),
    session: {},
    get(header) {
      if (header.toLowerCase() === 'user-agent') {
        return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1';
      }
      if (header.toLowerCase() === 'referrer' || header.toLowerCase() === 'referer') {
        return 'https://www.tiktok.com/';
      }
      if (header.toLowerCase() === 'host') {
        return 'mrtumi.com';
      }
      return '';
    },
    query: {
      ttclid: 'test_tiktok_click_123'
    },
    ip: '103.150.12.34'
  };

  await visitorTracking.recordVisitorEvent(dummyReq);

  const analytics = await visitorTracking.getVisitorAnalytics();
  assert.ok(analytics);
  assert.ok(Array.isArray(analytics.platforms));
  assert.ok(Array.isArray(analytics.devices));
  assert.ok(Array.isArray(analytics.browsers));

  // Check that TikTok and Mobile are tracked
  const hasTikTok = analytics.platforms.some(p => p.source === 'TikTok');
  const hasMobile = analytics.devices.some(d => d.device === 'Mobile');
  assert.ok(hasTikTok, 'Analytics should capture TikTok referral');
  assert.ok(hasMobile, 'Analytics should capture Mobile device');
});

test('admin dashboard view and routes contain platform analytics integration', () => {
  const dashView = read('views/admin/dashboard.ejs');
  assert.match(dashView, /Platform-wise Visitors & Device Analytics/);
  assert.match(dashView, /id="deviceChart"/);
  assert.match(dashView, /vAnalytics\.todayVisitors/);
  assert.match(dashView, /vAnalytics\.totalViews/);

  const dashRoutes = read('src/routes/adminDashboard.js');
  assert.match(dashRoutes, /\/admin\/api\/analytics\/visitors/);
  assert.match(dashRoutes, /visitorAnalytics/);

  const storefront = read('src/routes/storefront.js');
  assert.match(storefront, /recordVisitorEvent/);
});
