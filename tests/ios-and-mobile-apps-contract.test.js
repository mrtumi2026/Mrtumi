'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pushNotificationService = require('../src/services/pushNotificationService');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('iOS App - Files, Swift project structure and Info.plist exist', () => {
  const pbxproj = read('ios/MrTumi.xcodeproj/project.pbxproj');
  const appSwift = read('ios/MrTumi/MrTumiApp.swift');
  const contentSwift = read('ios/MrTumi/ContentView.swift');
  const webViewSwift = read('ios/MrTumi/WebViewContainer.swift');
  const infoPlist = read('ios/MrTumi/Info.plist');

  assert.ok(pbxproj.includes('com.mrtumi.store'), 'Project bundle ID is com.mrtumi.store');
  assert.ok(appSwift.includes('@main'), 'SwiftUI App entrypoint exists');
  assert.ok(contentSwift.includes('OfflineFallbackView'), 'Includes offline fallback view');
  assert.ok(infoPlist.includes('NSCameraUsageDescription'), 'Includes camera permission');
  assert.ok(infoPlist.includes('NSPhotoLibraryUsageDescription'), 'Includes photo library permission');
  assert.ok(infoPlist.includes('remote-notification'), 'Includes remote-notification background mode');
});

test('iOS App - Auto-update and cache protocol verification', () => {
  const webViewSwift = read('ios/MrTumi/WebViewContainer.swift');
  assert.ok(
    webViewSwift.includes('.useProtocolCachePolicy'),
    'Configured with useProtocolCachePolicy so website changes revalidate instantly'
  );
  assert.ok(
    webViewSwift.includes('reloadFromOrigin()'),
    'Supports reloadFromOrigin to bypass stale caches during pull-to-refresh'
  );
  assert.ok(
    webViewSwift.includes('window.MrtumiNativeBridge'),
    'Injects JavaScript native bridge for cross-platform communication'
  );
});

test('Backend Push Notification - Handles iOS platform device tokens', async () => {
  const iosToken = 'apns_token_ios_' + Date.now() + '_test_dummy_token_123456';
  const registered = await pushNotificationService.registerDeviceToken({
    token: iosToken,
    platform: 'ios',
    appType: 'customer',
    topic: 'customer_offers',
  });

  assert.ok(registered && registered.success, 'iOS device token registered');

  // Verify broadcast sends to iOS tokens too
  const broadcast = await pushNotificationService.broadcastOfferNotification({
    title: '🍎 স্পেশাল আইওএস অফার!',
    body: 'আজকের সব অর্ডারে ফ্রি ডেলিভারি।',
    deepLink: '/campaign/free-delivery',
  });

  assert.ok(broadcast.success, 'Broadcast successful');
  assert.ok(broadcast.recipients >= 1, 'At least 1 recipient received the broadcast');
});
