'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONSENT_VERSION, normalizeAttribution, captureAttribution, consentGranted } = require('../src/analytics/attribution');

test('Phase 14 attribution is absent unless the feature is enabled and session consent is explicitly granted', () => {
  const session = {};
  assert.equal(captureAttribution(session, { utm_source: 'facebook', utm_campaign: 'spring' }, true), null);
  assert.equal(session.analyticsAttribution, undefined);
  session.analyticsConsent = true;
  assert.equal(captureAttribution(session, { utm_source: 'facebook', utm_campaign: 'spring' }, false), null);
  assert.equal(session.analyticsAttribution, undefined);
  assert.equal(consentGranted(session, true), true);
});

test('Phase 14 attribution normalizes bounded UTM fields, rejects PII-like tags and assigns a source label', () => {
  assert.deepEqual(normalizeAttribution({ utm_source: ' Facebook ', utm_medium: 'paid social', utm_campaign: 'spring-2026' }), {
    platformSource: 'Meta', utmSource: 'Facebook', utmMedium: 'paid social', utmCampaign: 'spring-2026',
  });
  assert.deepEqual(normalizeAttribution({ utm_source: '01712345678', utm_medium: 'person@example.com' }), {
    platformSource: 'Direct', utmSource: '', utmMedium: '', utmCampaign: '',
  });
  assert.equal(normalizeAttribution({ utm_source: 'x'.repeat(130) }).utmSource.length, 100);
});

test('Phase 14 attribution keeps first touch for the session and erases it on withdrawal', () => {
  const session = { analyticsConsent: true };
  const first = captureAttribution(session, { utm_source: 'google', utm_medium: 'cpc' }, true);
  const later = captureAttribution(session, { utm_source: 'tiktok', utm_campaign: 'later' }, true);
  assert.equal(first.platformSource, 'Google');
  assert.equal(later, first);
  session.analyticsConsent = false;
  delete session.analyticsAttribution;
  assert.equal(captureAttribution(session, { utm_source: 'meta' }, true), null);
  assert.equal(CONSENT_VERSION, 'p14-v1');
});
