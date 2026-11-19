# Monitoring and alerts

What exists today, and what you still have to wire up. Nothing here pages anyone by itself.

## Signals the platform produces
| Signal | Where | Use |
| --- | --- | --- |
| Liveness | `GET /api/v1/health/live` | Container healthcheck and load-balancer check. Fails only if the process is down. |
| Readiness | `GET /api/v1/health` | 200 only when PostgreSQL **and** Redis answer; otherwise 503 with which one is down. Use for external uptime monitoring. |
| Operations health | `GET /api/v1/admin/ops/health` (staff with `reports.read`) and the admin **System health** page | Notification backlog and lag, failing events, overdue scheduled payments, unfinished payments, open queues and risk alerts, with plain-language warnings. |
| Reconciliation | `ledger.reconcile()` (tested), `verify-backup.sh` | Proves projected balances equal the postings. |
| Request ids | every error body has `requestId`; 5xx are logged with it | Link a customer-reported error to a log line. Logs contain no request bodies or secrets. |
| Risk alerts | admin **Risk alerts**, high severity also notifies reviewers | Fraud/AML-style review (simulated). |
| Audit and security events | admin Audit log, `SecurityEvent` rows | Who did what; forbidden access attempts. |

## Suggested alerts (to configure in your monitoring tool)
1. External check on `/api/v1/health` every minute; alert after 3 failures.
2. Container restarts: alert if `api` or `worker` restarts more than 3 times in 10 minutes (`docker events`, or your platform's equivalent).
3. Admin System health status `ATTENTION` for more than 10 minutes. (A scripted check needs a staff session; until you automate one, review the page daily.)
4. Disk usage of the Postgres and uploads volumes above 80 percent.
5. `verify-backup.sh` failing, or no new backup in 26 hours.

## Not built
No metrics endpoint (Prometheus), no distributed tracing, no log shipping, no dashboards or paging integration, and no synthetic customer journey beyond `infrastructure/scripts/smoke.mjs`. Add these before treating any environment as more than a demonstration.
