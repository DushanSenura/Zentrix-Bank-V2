# V1 audit and V1 → V2 migration matrix

Source: https://github.com/DushanSenura/Zentrix-Bank (read-only; cloned shallow for review, never modified).

## V1 findings

* Flutter app `bank_app` 1.0.0: 153 Dart files, 33 test files (README claims 332 passing tests; not re-run here).
* Stack: Riverpod 3, go_router 17, Dio, flutter_secure_storage, local_auth, fl_chart, pdf, mobile_scanner, geolocator, share_plus.
* **Everything runs on in-memory mock repositories.** `docs/api_contract.md` describes ~45 endpoints but "has never been run against a real server".
* Money: `double` in UI models, integer minor units on the wire (kept in V2: BigInt/minor units end to end, no doubles).
* Known V1 gaps (from its own README): PIN gate client-side only; mock identity verification; hardcoded reset code `123456` and demo passwords; no staff back-office; FD maturity and scheduled payments triggered when screens open; no Sinhala/Tamil (~1,260 inline strings); no push; PDF statements Latin-1 only; release signed with debug key; `com.example` application id.

## V1 payment pipeline (preserved)
Review → Authorization → Processing → Receipt. V2 moves authorization and every limit/fee/ownership check to the server; unknown outcomes are reconciled, never assumed failed.

## Migration matrix

Status legend: **Rebuild** = reimplement against real backend; **Keep concept** = reuse the product rule; **New** = no V1 equivalent.

| V1 area | V1 state | V2 treatment | Phase |
|---|---|---|---|
| Splash, onboarding | UI only | Rebuild with design system | 2 |
| Login (username/email/customer ID) | mock | Rebuild: Argon2id, lockout, rotating sessions | 2 |
| Registration (5 steps) + mock identity check | mock | Rebuild: persisted KYC, staff review queue | 2 |
| Forgot/reset password | fixed code `123456` | Rebuild: single-use expiring tokens, no fixed codes | 2 |
| PIN (4/6), biometrics, app lock, remember device | client-only | Keep concept; add server-verified step-up for payments | 2 |
| Security center, sessions, devices, login history, 2FA | mock | Rebuild on Session/TrustedDevice/LoginHistory | 2 |
| Dashboard, widgets, account switching | mock | Rebuild; customizable widgets (new) | 3 |
| Accounts (savings/current/FD/FX), open account (min LKR 1,000, max 6) | mock | Keep rules as configurable policy; application→staff approval workflow (new) | 3 |
| Transactions, search, filters, details, receipts | mock | Rebuild on ledger projections | 3–4 |
| Transfers (own/beneficiary/new/other bank fee LKR 25/scheduled) | `MockLedger` | Rebuild: double-entry ledger, idempotency, server limits (V1 daily LKR 500,000) | 4 |
| Beneficiaries | mock | Rebuild | 4 |
| Bills (10 categories), QR pay / My QR | mock | Rebuild behind integration interfaces | 4 |
| Scheduled/recurring payments | run on screen-open | Rebuild as BullMQ jobs, idempotent | 4 |
| Cards (debit 5-day prep, virtual needs bank approval, controls, PIN, lost) | mock + prototype tools | Rebuild: real approval queue replaces "prototype tools"; tokenized PIN ops | 5 |
| Fixed deposits (3/6/12 mo, 24–120 yr multiples, min LKR 10,000, renew with/without interest, simple interest) | mock, maturity on open | Keep rules; maturity in worker; early closure workflow (new) | 5 |
| Loans, calculator, applications (never approved in-app) | mock | Rebuild: staff decision + maker-checker + disbursement | 5 |
| Savings goals, budgets (80/100% alerts) | mock | Rebuild | 5 |
| Analytics (income/expense/cash flow charts) | mock | Rebuild on persisted data | 8 |
| Statements CSV + PDF | Latin-1 PDF | Rebuild with Unicode fonts (Sinhala/Tamil) | 7 |
| Disputes | local | Rebuild with staff queue | 7 |
| Notifications (5 categories), push | in-app only | Outbox + worker + FCM when configured | 8 |
| Search, support FAQ/chat, branches/ATMs | local/sample | Rebuild; tickets, secure messages, appointments | 7 |
| Settings (theme, language EN, reduce motion, default account, balance privacy) | local prefs | Rebuild; add Sinhala/Tamil via ARB | 2/8 |
| Offline banner, maintenance screen, session expiry, error views, crash handler | done | Keep concepts | 2+ |
| Accessibility + contrast tests | done | Keep approach; extend to admin | 9 |
| Staff back-office | **none** | **New**: React admin portal, RBAC, audit, queues | 6 |
| Reconciliation, risk alerts, reports, AI (optional) | none | New | 6–8 |

Reusable assets reviewed and copied: `bank_logo.png`, `Manrope.ttf`. No V1 Dart source was copied.
