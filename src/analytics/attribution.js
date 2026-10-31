'use strict';

const LIMITS = Object.freeze({ source: 100, medium: 100, campaign: 150 });
const CONSENT_VERSION = 'p14-v1';
const EMPTY_ATTRIBUTION = Object.freeze({ platformSource: 'Direct', utmSource: '', utmMedium: '', utmCampaign: '' });

function cleanTag(value, maxLength) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  if (!text || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || /(?:\+?880[\s-]?)?01[3-9](?:[\s-]?\d){8}/.test(text)) return '';
  return text;
}
function platformSource(source, medium, campaign) {
  const key = String(source || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['facebook', 'fb', 'instagram', 'meta'].includes(key)) return 'Meta';
  if (['google', 'adwords', 'youtube'].includes(key)) return 'Google';
  if (['tiktok', 'tik tok'].includes(String(source || '').toLowerCase().trim()) || key === 'tiktok') return 'TikTok';
  if (source || medium || campaign) return 'Campaign';
  return 'Direct';
}
function normalizeAttribution(input = {}) {
  const utmSource = cleanTag(input.utmSource ?? input.utm_source, LIMITS.source);
  const utmMedium = cleanTag(input.utmMedium ?? input.utm_medium, LIMITS.medium);
  const utmCampaign = cleanTag(input.utmCampaign ?? input.utm_campaign, LIMITS.campaign);
  return {
    platformSource: platformSource(utmSource, utmMedium, utmCampaign),
    utmSource,
    utmMedium,
    utmCampaign,
  };
}
function captureAttribution(session, query, enabled) {
  if (!session || enabled !== true || session.analyticsConsent !== true) return null;
  if (session.analyticsAttribution) return session.analyticsAttribution;
  const attribution = normalizeAttribution(query);
  if (attribution.platformSource === 'Direct') return null;
  session.analyticsAttribution = attribution;
  return attribution;
}
function consentGranted(session, enabled) {
  return enabled === true && session?.analyticsConsent === true;
}

module.exports = { CONSENT_VERSION, EMPTY_ATTRIBUTION, normalizeAttribution, captureAttribution, consentGranted };
