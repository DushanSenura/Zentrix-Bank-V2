# Architecture overview

```
Flutter mobile ──┐                       ┌── PostgreSQL (Prisma)  ← source of truth, incl. double-entry ledger
React admin ─────┼──► NestJS REST API ───┤
                 │    (RBAC, validation) └── Redis ◄── BullMQ worker (outbox relay, scheduled jobs)
```

* **One authoritative backend.** Mobile and admin call the same API. Clients never supply balances, fees, ownership or approvals.
* **Ledger.** Double-entry, append-only, BigInt minor units. Enforced twice: in `services/api/src/modules/ledger/money.ts` and in Postgres (deferred balance trigger, positive-amount CHECK, immutability triggers; see the `init` migration). Corrections are reversing journals.
* **Outbox.** Business changes write an `OutboxEvent` in the same transaction; the worker relays with `FOR UPDATE SKIP LOCKED` so events survive crashes and multiple workers never double-process.
* **Idempotency.** `IdempotencyRecord (userId, scope, key)` unique; same key + different body is rejected.
* **Maker-checker.** `ApprovalRequest` has a CHECK that checker ≠ maker.
* **No mock fallback.** If the API is down, apps show an error state.

## Ledger service (Phase 3)
`LedgerService.post` locks every touched ledger account `FOR UPDATE` in ascending id order (no deadlocks), locks customer `Account` rows `FOR SHARE` so a freeze serialises with in-flight posts, enforces restrictions (frozen: no debits; suspended/closed: none) and non-negative balances, then inserts journal + postings and updates `LedgerAccount.balanceMinor` in the same transaction. The balance is a *projection*; `reconcile()` recomputes it from postings and checks debits = credits per currency. Reversals post equal-and-opposite journals. Account approval joins the caller's transaction so account creation and the opening-deposit journal commit or roll back together.

## Payment pipeline (Phase 4)
`POST /v1/payments` (Idempotency-Key required) creates a DRAFT with a server-computed fee; nothing moves. `POST /v1/payments/:id/authorize` verifies the PIN on the server (5 failures sign the customer out everywhere), flips AWAITING_AUTHORIZATION → AUTHORIZED with a compare-and-set, then `execute` locks the instruction row and the customer's user row, re-checks limits, posts ONE journal (debit source amount+fee; credit recipient / settlement account; credit fee income) and marks POSTED — all in one transaction. Any ledger refusal marks the instruction FAILED with a code and writes nothing. Unexpected errors leave it AUTHORIZED and the job retries safely. Clients that lose a response reconcile with `GET /v1/payments/by-key/:key` and `GET /v1/payments/:id`; terminal states are returned idempotently. The worker calls `POST /v1/internal/jobs/run-due` (shared secret) every 30 s to expire drafts, turn due standing instructions into payments (deterministic reference ⇒ at most one per run) and execute due/stuck payments. Notifications are created by the worker from outbox events in the same transaction that marks them published.

## Product services (Phase 5)
All product money uses the same ledger and idempotency rules. **Cards** never hold a card number or CVV (only last4, expiry and a simulated issuer token; the card PIN is an Argon2id hash standing in for the issuer HSM); the bank approves every request. **Fixed deposits** and **savings goals** each get their own LIABILITY ledger account; opening, interest, maturity, early closure and goal moves are balanced journals with deterministic references (`FDM-<ref>-<n>`, `GOAL-C-<hash>`), so a repeated job or request can never pay twice. Interest is simple interest rounded down in integers. **Loans** have an ASSET ledger account whose balance is the outstanding principal; disbursement needs two different staff (an `ApprovalRequest` with a DB CHECK that checker differs from maker), and repayments run through the payment pipeline (interest first, then principal, oldest instalment first; paying the settlement quote closes the loan). Amortisation is bigint fixed-point (18 digits); the last instalment absorbs rounding so principal always sums exactly. The worker's single tick calls `POST /v1/internal/jobs/run-due`, which runs payments, card preparation, deposit maturity and loan overdue/reminder jobs independently and reports per-job errors.

## Administration (Phase 6)
The portal is a thin client over the same API. Every admin route names the permission it needs (`@StaffWith(...)`); navigation and route guards are conveniences only. Dashboard sections are assembled per caller from live aggregates. Ledger corrections (reversals, adjustments) never edit history: a reversal posts the opposite journal (`REV-<ref>`), an adjustment posts `ADJ-<approvalId>` against a system account; both are two-person and atomic with their audit record. Policy settings are a whitelist in `SettingsService` read by the services on each use, so changes apply immediately.

## Advanced services (Phase 7)
* **Documents** (`modules/documents`): statements, receipts and certificates are generated on request from the ledger, never from client-supplied figures. `pdf.ts` embeds Noto Sans, Sinhala and Tamil fonts and draws mixed-script text run by run. Responses are `Cache-Control: no-store` and every download is audited.
* **Support** (`modules/support`): disputes, tickets, attachments, branches and appointments. A dispute never moves money; accepting one can only *request* a reversal, which goes through the existing maker-checker approval. Attachments go through the `ObjectStorage` interface (`LocalDiskStorage` today); file type is decided by magic bytes, keys are server-generated, downloads check ownership.
* **Payment extras** (`modules/payments/extras.*`): a payment request produces a normal draft payment for the payer, who still authorises it with their PIN; templates only store a destination spec; subscription detection is read-only.

## Risk, analytics, AI and reminders (Phase 8)
* **Risk monitoring** (`modules/risk`): rules run from the background job, completely outside the payment path, over recently posted payments. A hit becomes a `RiskAlert` with the numbers that triggered it; (rule, payment) is unique so rescans are safe. Alerts are for staff review (take, clear or escalate with a written note) and never block, reverse or restrict anything by themselves. Thresholds are staff-editable settings. An optional, default-off anomaly experiment (robust z-score) raises LOW alerts that say they are experimental.
* **Reminders** (`reminders.service.ts`): fixed-deposit maturity and next-day scheduled payments, once each (`ReminderLog` unique key written in the same transaction as the outbox event). Budget, loan, card and security notifications already existed; a new trusted device on an account that had others now raises a login alert.
* **Delivery:** outbox -> in-app notification rows (exactly once). The worker then optionally POSTs generic text to `PUSH_WEBHOOK_URL`; a gateway failure cannot lose a notification. Staff have their own inbox (`/admin/notifications`).
* **Analytics** (`modules/analytics`): read-only, customer-scoped month summary, trend and recurring-payment analysis from persisted ledger and payment rows. Own-account moves are not spending. The service performs no writes (a test scans for it).
* **AI** (`modules/ai`): optional and isolated. It may import only the read-only analytics service; a test fails if it imports any payment, ledger, card, loan, deposit, auth or database module. It has no tools and no write path: the provider interface is text in, text out. Help answers are retrieved from approved articles (works without any model); a model only words the answer, and the response says so. Question text has long digit runs redacted before it leaves the server. Statements are labelled FACT or ESTIMATE.
* **Operations:** `/admin/ops/health` reports outbox backlog and lag, overdue scheduled payments, queue sizes and open alerts.

## Conventions
TypeScript strict; Zod for env/DTO validation; feature modules under `services/api/src/modules/*`; Flutter `features/<name>/{domain,data,presentation}`; admin `src/features/<name>`; no floating-point money anywhere; never log secrets/PINs/tokens/documents.

## Ports (local)
API 3000 · Admin 5173 · Postgres 5432 · Redis **6380** (host) → 6379 (container).
