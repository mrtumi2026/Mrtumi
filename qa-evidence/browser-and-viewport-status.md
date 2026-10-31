# Part 2 QA evidence status

Date: 2026-10-31

## Automated evidence completed

- `npm run verify`: foundation checker passed; 164 Node tests, 140 passed, 0 failed, 24 skipped because local MySQL/MariaDB is unavailable.
- `tests/d7-workflows.test.js` includes responsive CSS contract checks for mobile breakpoints, max-width containment, and scrollable tables. This is a static CSS contract, not a rendered viewport test.
- `git diff --check` passed at the time of this note.
- `npm audit`: 0 reported vulnerabilities after the tested EJS upgrade.

## Browser execution limitation

A real Chromium browser run was attempted with Playwright Core and the packaged headless Chromium binary against the local development server. Chromium exited before opening a page because this sandbox lacks OS libraries `libnspr4.so`, `libnss3.so`, and `libnssutil3.so`. No screenshot or browser-flow result is claimed. The temporary browser packages were not added to project dependencies.

Database integration was subsequently verified on exact SHA `a492685c92e0d67a0fc47f7008a420b67db28749`: MySQL 8.0 and MariaDB 10.11 CI run `41212148766` both passed. The browser flows listed above and true rendered viewport tests still require execution in an environment with Chromium's OS libraries; they remain launch sign-off blockers.
