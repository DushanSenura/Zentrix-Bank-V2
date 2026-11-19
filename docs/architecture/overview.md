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

## Conventions
TypeScript strict; Zod for env/DTO validation; feature modules under `services/api/src/modules/*`; Flutter `features/<name>/{domain,data,presentation}`; admin `src/features/<name>`; no floating-point money anywhere; never log secrets/PINs/tokens/documents.

## Ports (local)
API 3000 · Admin 5173 · Postgres 5432 · Redis **6380** (host) → 6379 (container).
