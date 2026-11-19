# Progress

## Phase 1 â€” Repository initialization & architecture: DONE (verified 2026-11-19)
Verified locally: Prisma schema valid; migration `init` applied to Postgres 16; DB triggers reject an unbalanced journal and posting deletes (checked by hand with psql); API tests 10/10; API/worker/admin typecheck clean; API build OK; live `GET /api/v1/health` = 200 with db+redis up; Swagger at /api/docs = 200; Flutter `analyze` clean, 2 widget tests pass.

Not verified: GitHub Actions workflow has never run; admin dev server not exercised in a browser; mobile app not run on a device/emulator; no DB integration tests in CI yet (ledger triggers only hand-checked).

## Known gaps / decisions
* Schema covers identity, accounts, ledger, payments, idempotency, approvals, audit, outbox, config only; other domains arrive with their phases (docs/database/schema-roadmap.md).
* Redis host port is 6380 (6379 was occupied locally).
* shadcn/ui, React Hook Form, Zod, TanStack Table, Recharts not yet added to admin (added when first screens need them). Flutter deps beyond riverpod/go_router/dio added in Phase 2+.
* Dart OpenAPI client generation not set up yet.

## Phase 2 — Design system & authentication: PARTIALLY DONE (verified 2026-11-19)
Done and verified: Argon2id auth, rotating sessions with reuse detection, lockout, mandatory staff TOTP MFA, deny-by-default RBAC (18 permissions, 10 roles), customer KYC submit + staff review/approve (audited, outbox event), password reset, server-side PIN set, idempotent dev seed with generated credentials. API: 19 tests pass (8 integration tests against a real Postgres test DB, incl. Scenario A and the cross-role part of Scenario G); typecheck + build clean; live smoke test of seeded staff login with TOTP OK. Admin: MFA login + permission-aware KYC review page (typecheck/build OK, **not exercised in a browser**). Flutter: V2 tokens (light/dark, motion), GlassCard/ZxButton, secure refresh-token store, login/register/forgot-reset/KYC/PIN/home screens; analyze clean, 5 widget tests pass (fake repository; **never run against the live API or on a device**).

NOT done from the Phase 2 brief: onboarding carousel + animated splash, biometrics/app lock/auto-lock/background privacy, device verification & trusted-device/session management UI, change password/PIN, identity *document* upload, multi-step registration progress, staff invitation/role management (Phase 6), Sinhala/Tamil, shadcn/ui + RHF/Zod in admin, admin dark-mode toggle, accessibility audit, Dart OpenAPI client. CI workflow updated but still never run on GitHub.

## Next
1. Finish Phase 2 gaps above (biometrics/app lock, onboarding/splash, sessions & devices endpoints+UI, change password/PIN).
2. Phase 3: accounts, ledger service (post journals with row locking), account applications + approval, balance projections, concurrency tests (Scenario H).
