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

## Conventions
TypeScript strict; Zod for env/DTO validation; feature modules under `services/api/src/modules/*`; Flutter `features/<name>/{domain,data,presentation}`; admin `src/features/<name>`; no floating-point money anywhere; never log secrets/PINs/tokens/documents.

## Ports (local)
API 3000 · Admin 5173 · Postgres 5432 · Redis **6380** (host) → 6379 (container).
