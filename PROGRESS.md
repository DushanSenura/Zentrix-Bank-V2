# Progress

## Phase 1 — Repository initialization & architecture: DONE (verified 2026-11-19)
Verified locally: Prisma schema valid; migration `init` applied to Postgres 16; DB triggers reject an unbalanced journal and posting deletes (checked by hand with psql); API tests 10/10; API/worker/admin typecheck clean; API build OK; live `GET /api/v1/health` = 200 with db+redis up; Swagger at /api/docs = 200; Flutter `analyze` clean, 2 widget tests pass.

Not verified: GitHub Actions workflow has never run; admin dev server not exercised in a browser; mobile app not run on a device/emulator; no DB integration tests in CI yet (ledger triggers only hand-checked).

## Known gaps / decisions
* Schema covers identity, accounts, ledger, payments, idempotency, approvals, audit, outbox, config only; other domains arrive with their phases (docs/database/schema-roadmap.md).
* Redis host port is 6380 (6379 was occupied locally).
* shadcn/ui, React Hook Form, Zod, TanStack Table, Recharts not yet added to admin (added when first screens need them). Flutter deps beyond riverpod/go_router/dio added in Phase 2+.
* Dart OpenAPI client generation not set up yet.

## Next: Phase 2 — Design system & authentication
1. Argon2id password hashing, JWT access + rotating refresh sessions, lockout, rate limiting.
2. Auth module (customer + staff w/ mandatory TOTP MFA), RBAC guard + permission seed, audit logging.
3. KYC submission + staff review endpoints; password reset (single-use tokens).
4. Seed script with locally-generated dev credentials (never committed).
5. Flutter design system (liquid glass tokens, light/dark), onboarding/login/registration/PIN/biometrics; admin login.
6. Auth + RBAC tests incl. cross-customer access denial (Scenario G).
