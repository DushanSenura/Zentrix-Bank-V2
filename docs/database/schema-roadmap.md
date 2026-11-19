# Schema roadmap

`database/prisma/schema.prisma` is the source of truth. Phase 1 implements the foundational domains; the rest are added with the phase that builds their workflow (design → migrate → implement → test), so no table exists without logic using it.

| Domain | Status |
|---|---|
| Identity & security: User, CustomerProfile, StaffProfile, Role, Permission, RolePermission, UserRole, Session, TrustedDevice, LoginHistory, SecurityEvent | **Phase 1 (schema)** — logic in Phase 2. *AuthenticationChallenges* added in Phase 2. |
| Accounts: AccountProduct, Account, AccountApplication, AccountStatusHistory, Beneficiary | **Phase 1 (schema)** — logic in Phase 3/4. AccountLimits → Phase 3. |
| Ledger: LedgerAccount, LedgerJournal, LedgerPosting (+ DB triggers) | **Phase 1** — services in Phase 3 |
| Payments: PaymentInstruction, PaymentAuthorization, IdempotencyRecord | **Phase 1 (schema)**. Transfers/ScheduledPayments/PaymentRequests/Reconciliations → Phase 4 |
| Operations: ApprovalRequest, AuditLog, OutboxEvent, SystemConfiguration | **Phase 1** |
| Cards, FD, Loans, Savings/Budgets | Phase 5 |
| Support, Disputes, Branches, Appointments, Notifications | Phase 7–8 |
| FeePolicies, TransferLimitPolicies, RiskAlerts, BackgroundJobs | Phase 4–8 |

Known gap: balances are not yet stored as a projection; Phase 3 adds a verified projection derived from postings. PostgreSQL CHECK/trigger SQL lives in the migration files, not the Prisma schema.
