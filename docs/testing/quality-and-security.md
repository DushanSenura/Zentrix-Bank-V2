# Quality and security checks (Phase 9)

What is automatically checked, where, and what is deliberately **not** claimed.

## Run everything
```bash
pnpm typecheck && pnpm build
pnpm --filter @zentrix/api test      # needs Postgres + TEST_DATABASE_URL (migrated)
pnpm --filter @zentrix/worker test
pnpm --filter @zentrix/admin test
cd apps/mobile && flutter analyze && flutter test
```

## Checks that guard the security model
| Test | What it proves |
| --- | --- |
| `routes.matrix.test.ts` | Reads every route from the running app. Public routes equal a reviewed allowlist; every `/admin` route is staff-only and needs a permission (two documented exceptions); nothing outside `/admin` is staff-only; the "any signed-in user" set is small and reviewed. A new route that is not classified fails this test. |
| `isolation.sweep.test.ts` | Customer B attempts 21 reads and writes against customer A's account, payments, tickets, disputes, templates, goals, requests and beneficiaries. All refused, A's data unchanged, no leak of A's identifiers, and "someone else's" looks the same as "does not exist". |
| `hardening.test.ts` | Security headers, uniform 401 body, malformed/oversized/hostile input (SQL-looking text, operator objects, `__proto__`, path traversal) gets a clean 4xx and never a stack trace, user text is returned as JSON data, login answers are identical for unknown users and wrong passwords. |
| `migrations.test.ts` | Applies every migration to a brand-new database, checks there is no drift from `schema.prisma`, that re-running is a no-op, and that the ledger immutability and positive-amount safeguards exist. |
| `indexes.test.ts` | Every foreign key leads an index; the hot queries (statement, search, spending, risk scan, outbox, queues) have an index the planner can use. |
| `phase8.unit.test.ts` | The AI module imports no banking or database code, and analytics never writes. |

Earlier phases already cover money integrity: concurrency (Scenario H), idempotency (Scenarios I and J), failure recovery, scheduled jobs, maker-checker, and ledger reconciliation.

## Accessibility
* **Admin:** axe-core (structural rules) over every page and the app shell. It found an empty table header, now fixed.
* **Mobile:** Flutter guideline checks (minimum tap target, labelled tap targets, text contrast) on the new screens in light and dark themes, a 2x text-size overflow check, and a reduce-motion check. They found three layouts that overflowed at large text sizes, now fixed.
* Not covered: screen-reader (TalkBack/VoiceOver) sessions, colour contrast in the admin portal (jsdom cannot compute it), keyboard-only walkthroughs, or any older screens that the new checks were not pointed at.

## Dependencies
`pnpm audit` is clean (prod and dev) after upgrading `zod` to 4.x (API), `vitest` to 4.x, and pinning `deepmerge-ts`, `glob` and `minimatch` through `pnpm.overrides` for build-time tooling. The overrides should be removed once the upstream packages release patched versions. `flutter pub outdated` still lists newer majors that were not taken. Audit results are a point-in-time check, not a guarantee.

## Performance (what was measured)
* Admin entry bundle: 281 kB gzip as one file -> 96 kB gzip, with each page and the charting library loaded only when used.
* Query plans are checked structurally (an index exists and can serve the query). **No load test, no latency percentiles and no Flutter profiling were run**; there was no representative data volume or device.
