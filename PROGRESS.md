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

## Phase 4 — Transfers and payments: DONE with listed gaps (verified 2026-11-19)
Verified: API 63 tests (22 new payment tests on a real Postgres test DB), worker 3 (outbox relay exactly-once, concurrent workers), admin 5, Flutter 30 (12 new), Android debug APK builds with the camera plugin. Covered: **Scenario B** (review → PIN → balanced ledger journal → receipt → notifications → audit), **Scenario I** (5 concurrent creates with one Idempotency-Key = 1 payment; 5 concurrent authorisations = 1 journal), **Scenario J** (lost response: reconcile by key / GET, retry never double-posts; app shows unknown outcome and never "failed"), **Scenario H via the API** (6×300 vs 1,000 → exactly 3 post), daily limit under concurrency, server-owned fee (client fee/status rejected by strict schemas), wrong PIN / 5-strike sign-out, frozen/foreign accounts, beneficiaries with server-resolved names and isolation, QR (identity-only, foreign formats refused), bills, one-time scheduled and weekly/monthly recurring execution by the job (concurrent runs create one instruction; recovered after a simulated crash), draft expiry, internal job endpoint secret. **Live end-to-end with the real worker:** a payment scheduled ~75 s ahead was executed by the worker's due-tick, the "Payment sent" notification was delivered by the outbox relay, balances moved correctly and reconciliation stayed clean.

Bugs found and fixed this phase: the mobile client replayed ANY 401 after a token refresh, so a wrong PIN was sent twice and double-counted toward the lockout (present since Phase 2) — now refreshes only on token expiry; test-name collisions in a persistent test DB; worker transaction wait too short under concurrency.

NOT done / limits:
* Not built: loan-instalment payments (Phase 5), transfer templates, payment requests (customer-to-customer), batch transfers, favourite amounts, transfer PDF receipts and sharing (Phase 7), transaction history search/filters and dispute reporting (Phase 7), per-customer lowerable transfer limit, payment-instruction reversal API/UI with maker-checker (Phase 6), push notifications (Phase 8; in-app only), idempotency-record cleanup job.
* Monthly recurrence clamps to month length and can drift (31st → 28th stays 28th). Recurring runs use the destination resolved at creation.
* Interbank, biller and QR flows settle against simulated system accounts; nothing connects to a real network. Names are fictional/"sample".
* Mobile: QR scanner and My QR screens, date picker and repeat UI are not covered by widget tests and have never run on a camera/device. Admin payments page is read-only.
* Worker is triggered by BullMQ every 30 s (so a scheduled payment runs within ~30 s of due time). GitHub Actions still never run; CI env lacks INTERNAL_JOB_TOKEN (payment tests set it themselves).

## Phase 5 — Cards, loans, deposits, savings: DONE with listed gaps (verified 2026-11-19)
Verified: API 123 tests (60 new; real Postgres test DB), worker 3, admin 8 (3 new), Flutter 42 (12 new). **Scenario C** (virtual card: request → staff queue → approve → active → notification; no number/CVV/token/PIN hash ever returned), debit lifecycle (approval → 5-day prep → job marks READY → activate with app PIN + card PIN, Argon2id issuer hash), controls (tighten free / loosen needs PIN / bank maximum), freeze, report-lost with replacement, credit applications with staff-set limit. **Scenario D** (FD open via ledger with PIN + Idempotency-Key; maturity by the job: renew with interest / without interest / payout; 3 concurrent workers = one renewal; multi-term catch-up after downtime; failed funding account flagged without looping; staff-reviewed early closure with configurable penalty; staff-managed rate card). **Scenario E** (apply → officer recommends → SAME officer refused 403 + HIGH security event → different officer approves → atomic disbursement with schedule; DB CHECK also rejects checker = maker; rejection paths; instalments through the payment pipeline with interest-first allocation, partial payments, overpayment refusal, early settlement waiving future interest, overdue + reminder jobs once). Integer amortisation (EMI cross-checked against an independent float calculation: 88,848.79 / 17,210.49). Savings goals as ledger accounts (idempotent contribute/withdraw, achieved notification) and budgets (spend by category from posted payments; alerts once at 80% and 100% per month). Live run on the dev DB: card approve, FD open, goal idempotency, loan recommend, maker-checker refusal, full job tick (no errors), reconciliation clean.

Defects found by tests this phase: reportLost conflated "not allowed" with "no replacement" (virtual card reports were wrongly refused); my own EMI test figure was wrong (implementation was right, verified independently); Flutter dialog controllers disposed during exit animation.

NOT done / limits:
* **Cards:** no merchant/ATM simulation, so card limits and controls are stored and shown but not enforced at purchase; no card transaction history/analytics/spend alerts, merchant-category controls, limit-increase requests, delivery tracking beyond status, virtual card detail reveal.
* **Deposits:** no PDF certificates or maturity calendar/reminders (Phase 7/8), no comparison screen beyond the calculator; deposits are not part of the account list total; renewals use the current rate card for the term; the penalty key `fd.earlyPenaltyBps` has no admin UI.
* **Loans:** no supporting-document upload (no object-storage layer yet), no product comparison, repayment calendar or schedule PDF, no late fees or penalty interest, crude income-share affordability only, no collateral/guarantors; "settlement request" is paying the quoted settlement amount (no staff step). Maker-checker covers loan disbursement only (not account approval, reversals, adjustments).
* **Savings/finance:** no scheduled contributions, recurring-expense/subscription detection, category editing, cash-flow forecast or insights (Phase 8). Budgets count posted payments only.
* Mobile services screens and admin product pages have never run on a device/browser; no UI test for the date-sensitive flows. GitHub Actions still never run (CI env lacks INTERNAL_JOB_TOKEN; tests set their own).

## Next: Phase 6 — Administration portal
1. Dashboard KPIs from real aggregates; customer 360 (profile, accounts, KYC docs view), customer search/suspend/restore.
2. Staff management (provisioning, role/permission editing without self-escalation, session revocation), audit log viewer, settings (fees, limits, rates, maintenance mode).
3. Reversal/adjustment workflow with maker-checker; reconciliation page; disputes queue stub for Phase 7.
