# Phase 19 — Customer & Admin Android WebView Apps

**Status: `NOT STARTED` / environment-blocked for build verification.** The acceptance scope is defined in `MASTER_CHECKLIST.md` (`P19-01`–`P19-03`), but no Android project, Kotlin/Java source, Gradle build, or Android tests exist in this repository. No Java runtime, Gradle executable, `ANDROID_HOME`, or Android SDK is installed in the current execution environment.

## Acceptance scope (from master checklist)

- **P19-01:** Customer Android WebView project with safe deep links/payment redirects and offline UI.
- **P19-02:** Admin WebView app with role-aware server authorization, session timeout and no embedded secrets.
- **P19-03:** Build/release instructions and signing guide; signing keys must never be committed or requested in chat.

## Verified dependency gaps

- There is no canonical production origin/host verified in `DEPLOYMENT.md` for use as an app allowlist. Do not invent a URL, ship a placeholder host, or point builds at localhost.
- No Java/Gradle/Android SDK is available here, so compile, lint, emulator and WebView integration tests cannot be run. A source-only skeleton would not meet acceptance and could create unsafe navigation defaults.
- Signing keystore ownership/release process is unspecified. Do not create or store signing credentials.
- Online gateway redirects are not implemented in the web app today; Android must not broaden redirects beyond a narrowly allowlisted origin when those routes exist.

## Safe implementation plan once build prerequisites are provided

1. Establish Android toolchain/Gradle plugin availability and a verified canonical base URL through normal project tooling; keep the URL injectable in build configuration, not a secret.
2. Customer app: HTTPS-only allowlisted WebView origin, safe external-intent handling for non-allowlisted links, deny `file://`/mixed content, disable JavaScript bridge unless strictly required, restore network/offline states, and no payment success assumptions.
3. Admin app: same origin allowlist, server-side role enforcement (never embed an admin password/token), inactivity timeout and re-authentication using web session controls.
4. Add instrumented navigation/deep-link/timeout/offline tests, reproducible debug build and owner-operated signing/release guide.
5. Keep production release blocked until owner provides signing/release approval and verified host configuration.

## Current action

The phase has been inspected and the blocker recorded. Continue work in independent web phases; do not claim Android source/build acceptance until the toolchain and host decisions are available and a successful Android build/test is recorded.
