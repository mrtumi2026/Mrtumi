# Phase 14 — Visitor Attribution, Consent & Provider Events

**Status: `IN PROGRESS`.** The current work adds a first-party, session-only UTM attribution foundation. It does not implement Meta Pixel/CAPI, GTM or TikTok, and emits no third-party event. Live/external tracking remains disabled pending owner approval and provider configuration.

## Acceptance mapping

- **P14-01 — Meta Pixel + Facebook CAPI (`event_id` deduplication):** `NOT STARTED`. No Pixel/CAPI event is sent; no Pixel ID or CAPI secret was supplied. Later work needs current official provider specs, idempotent server event storage/dispatch, strict event/order/payment binding, consent gating and sandbox evidence.
- **P14-02 — GTM + TikTok Pixel:** `NOT STARTED`. IDs are settings placeholders only; no third-party tag is loaded by this change.
- **P14-03 — UTM/platform attribution, consent and verified-only Purchase:** `IN PROGRESS`. A first-party attribution base is implemented in `src/analytics/attribution.js`, the storefront preference route/view, and checkout order recording. New migration `0010_phase14_attribution_consent` stores nullable attribution consent timestamp/version beside sanitized order UTM fields.

## Safety behavior implemented

- `ANALYTICS_ATTRIBUTION_ENABLED` is **false unless the exact environment string `true` is supplied**. `.env.example` documents the disabled default. Leave it false until an authorized owner approves the privacy copy, data use and retention.
- When the flag is enabled, the storefront provides a bilingual, optional first-party campaign attribution preference. The POST uses CSRF protection, is rate-limited, supports rejection/withdrawal, and returns only to a safe local path.
- UTM values are read only after an explicit session opt-in. First touch is kept for the session; source/medium/campaign are length-bounded, control characters removed, and obvious email/mobile-number values rejected. Raw referrers, IP addresses and user-agent strings are not used for this feature.
- On successful canonical MySQL order creation, the normalized values and consent version/time are stored on the order. Without both a true feature flag and explicit consent, stored source is `Direct`, UTM fields are empty and consent metadata is NULL.
- This slice does **not** dispatch a Purchase event. Current COD orders are `unpaid`; no provider has supplied a verified paid callback. Purchase emission must remain absent until a provider-verified settled payment and approved consent specification exist. A successful order insert is not evidence of payment.
- No provider credentials or outbound calls were made. This is first-party local attribution only, not adapter/sandbox/live integration evidence.

## Migration and tests

- `0010_phase14_attribution_consent` is paired with a reversible down migration that removes only its two nullable metadata columns; it does not alter order totals or previous consent fields.
- Unit tests cover default-off/no-consent, field bounds, PII-like value rejection, source classification, first-touch retention and withdrawal erasure.
- MySQL 8.0 HTTP coverage exercises the disabled/no-consent default, CSRF rejection, explicit opt-in, order attribution persistence, consent metadata, and a separate non-opt-in order remaining Direct/empty. The migration lifecycle checks 0010 up/down and complete reapplication.
- Live MySQL CI is pending for the current implementation SHA. Local MySQL-only skips do not count as passes.

## Remaining acceptance and owner actions

1. Approve final Bangla/English privacy disclosure, purpose limitation, retention/deletion, and consent version before any production activation. The wording shown here is functional description, not approved legal policy.
2. Supply official Meta/TikTok/GTM identifiers and Meta server secret through the approved secret-management channel; do not place credentials in Git or chat.
3. Verify current official APIs and implement adapter contracts with event-ID deduplication, retries, signature/amount/order validation and safe errors.
4. Define “verified paid” as a provider-backed durable payment state; never infer Purchase from an unpaid COD order or request success page.
5. Run sandbox tests only after credentials and explicit sandbox authorization; live provider verification and deployment need separate explicit authorization.
