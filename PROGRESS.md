# Progress

## Phase 1 â€” Repository initialization & architecture: DONE (verified 2026-11-19)
Verified locally: Prisma schema valid; migration `init` applied to Postgres 16; DB triggers reject an unbalanced journal and posting deletes (checked by hand with psql); API tests 10/10; API/worker/admin typecheck clean; API build OK; live `GET /api/v1/health` = 200 with db+redis up; Swagger at /api/docs = 200; Flutter `analyze` clean, 2 widget tests pass.

Not verified: GitHub Actions workflow has never run; admin dev server not exercised in a browser; mobile app not run on a device/emulator; no DB integration tests in CI yet (ledger triggers only hand-checked).

## Known gaps / decisions
* Schema covers identity, accounts, ledger, payments, idempotency, approvals, audit, outbox, config only; other domains arrive with their phases (docs/database/schema-roadmap.md).
* Redis host port is 6380 (6379 was occupied locally).
* shadcn/ui, React Hook Form, Zod, TanStack Table, Recharts not yet added to admin (added when first screens need them). Flutter deps beyond riverpod/go_router/dio added in Phase 2+.
* Dart OpenAPI client generation not set up yet.

## Phase 2 — Design system & authentication: DONE with listed exceptions (verified 2026-11-19)
Verified: API 24/24 tests (real Postgres test DB) covering auth, lockout, refresh rotation/reuse, staff MFA, RBAC, KYC (Scenario A), password reset, sessions/devices/login history with cross-customer isolation (Scenario G), change password, change/verify PIN with 5-strike sign-out; typecheck + build clean. Admin: 3 tests (MFA login step, staff-only enforcement, refresh-and-replay), typecheck/build OK, light/dark/system toggle. Flutter: analyze clean, 11 widget tests (onboarding, login, server-verified PIN unlock, biometric success/failure with a fake, re-lock after timeout, privacy cover, dark + 2x text), `flutter build apk --debug` succeeds with the new native config.

Implemented on mobile: animated splash, onboarding carousel, login/register/forgot-reset, KYC submit, PIN setup, server-verified app unlock + biometrics (local_auth), auto-lock timeout, privacy cover, FLAG_SECURE in release, security centre (change password/PIN, sessions, trusted devices, login history), theme/reduce-motion/lock settings.

NOT verified / known gaps (Phase 2):
* No test touched a real phone or emulator or the live API from the Flutter/admin UIs (fakes only). Real biometric prompts, FLAG_SECURE and iOS Face ID untested; iOS never built (needs macOS).
* Identity DOCUMENT image upload, multi-step registration progress UI, staff invitation / role management (Phase 6), Sinhala/Tamil localisation, shadcn/ui + React Hook Form in admin, Dart OpenAPI client, TalkBack/VoiceOver audit: not done.
* PIN unlock needs network (server-verified); only biometrics work offline. Rate limiting is per-process memory. TOTP replay within window not blocked.
* GitHub Actions has never run.

## Next: Phase 3 — Accounts and financial ledger
1. Ledger service: post balanced journals in one DB transaction with row locks; balance projection; idempotency; reversal.
2. Account products, applications + staff approval workflow, account status history.
3. Customer account list/detail API + Flutter screens; admin account queue.
4. Concurrency (Scenario H) and ledger integrity tests; reconciliation check.
