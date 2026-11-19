# Progress

## Phase 1 — Repository initialization & architecture: DONE (verified 2026-11-19)
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

## Phase 3 — Accounts and financial ledger: DONE with listed gaps (verified 2026-11-19)
Verified (real Postgres test DB): 41 API tests (17 new) — ledger posting with row locking, projection + reconciliation (detects tampering), duplicate-reference refusal, overdraft refusal with no trace, **Scenario H** (10 concurrent spends of a balance covering 3 → exactly 3 succeed), opposite-direction concurrency without deadlock, frozen/suspended/closed rules, reversal, DB-level rejection of unbalanced journals and posting mutation; account application → staff approval (atomic with the opening-deposit journal; rollback verified) → customer sees ledger-backed balance (**Phase 3 acceptance**); ownership isolation + security events (Scenario G); account limit, KYC gate, permissions, status transitions with audit/history, close-requires-zero-balance, keyset pagination. Admin: applications queue, account lookup + status actions, dashboard reconciliation panel (typecheck/build/3 tests OK; **new pages not covered by UI tests, never opened in a browser**). Flutter: 18 tests incl. dashboard/total/hide-balances, history with cursor paging, frozen explanation, error+retry, open-account flow; analyze clean. Live smoke on the seeded dev DB: staff queue, customer balance 5,000,000 minor, history, reconciliation ok.

Defects found and fixed this phase: Phase 1 immutability trigger referenced OLD.status for postings (protected only by an accidental error) — fixed in migration 20261119160000; reconcile() mishandled Postgres numeric; `incremental` tsconfig made `nest build` emit nothing after dist was cleaned; Riverpod 3 silent auto-retry hid error states (disabled); GlassCard lacked a Material ancestor; Python edits wrote invalid UTF-8 to two files (repaired, scan clean).

NOT done / limits:
* No money movement for customers yet (transfers = Phase 4). Opening deposits are a simulated branch-cash journal posted by staff at approval.
* Account certificates, account closure *request* by customers, account nickname edit, account-specific alerts, statements (Phase 7), foreign-currency accounts, per-account limits (AccountLimits table), interest accrual (Phase 5).
* Maker-checker is not applied to account approval or status changes (reason codes + audit only); reversals have no API/UI yet (service only).
* Balance projection can be corrupted by direct DB writes; reconciliation reports it but nothing alerts or blocks yet.
* GitHub Actions still never run; Flutter/admin UIs never exercised against a device/browser.

## Next: Phase 4 — Transfers and payments
1. Payment pipeline: draft → server-verified step-up (PIN) → post journal + fee → receipt; idempotency keys (IdempotencyRecord), limits/fees policy tables, unknown-outcome handling.
2. Beneficiaries, own/internal/simulated-interbank transfers, bill payments, QR, scheduled/recurring (BullMQ).
3. Flutter payment flow (review → authorise → processing → receipt); Scenarios B, I, J.
