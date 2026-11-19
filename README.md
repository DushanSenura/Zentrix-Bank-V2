# Zentrix Bank V2

A full-stack digital banking **simulation** platform: Flutter customer app, React admin portal, NestJS API, PostgreSQL double-entry ledger, BullMQ worker. Fictional data and simulated funds only — **not** for real banking use. V1 reference: https://github.com/DushanSenura/Zentrix-Bank (read-only).

**Status:** Phases 1-10 built (staging-ready simulation; see the limits in PROGRESS.md). See [PROGRESS.md](PROGRESS.md) for exact state and next steps, and [docs/v1-migration](docs/v1-migration/v1-audit-and-matrix.md) for the V1→V2 matrix.

## Prerequisites
Node ≥ 20, pnpm 10, Docker, Flutter 3.x.

## Run locally
```bash
cp .env.example .env            # then set a local POSTGRES_PASSWORD in .env and in DATABASE_URL
pnpm install
pnpm db:up                      # Postgres + Redis (Redis on host port 6380)
pnpm db:generate
pnpm --filter @zentrix/database migrate:deploy
pnpm db:seed                    # RBAC catalogue + fictional demo users; credentials go to .local-dev-credentials.json (git-ignored)
pnpm api:dev                    # http://localhost:3000/api/v1/health  ·  Swagger: /api/docs
pnpm worker:dev                 # outbox relay + scheduled-payment tick (needs INTERNAL_JOB_TOKEN in .env)
pnpm admin:dev                  # http://localhost:5173
```
Mobile: `cd apps/mobile && flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000` (Android emulator; use your LAN IP on a device).

## Money movement (simulation)
Payments, scheduled and recurring payments run through the API. Set `INTERNAL_JOB_TOKEN` (>= 32 chars) in `.env` for both the API and the worker; without it scheduled payments never execute.

## Validate
```bash
pnpm typecheck && pnpm test && pnpm build
cd apps/mobile && flutter analyze && flutter test
```

## Layout
`apps/mobile` · `apps/admin` · `services/api` · `services/worker` · `database` · `docs` · `.github/workflows`
`infrastructure/` holds the staging compose stack, Dockerfiles, backup scripts and smoke test.

## Security notes
No secrets are committed; `.env` is git-ignored. No demo passwords exist yet — seed/staff provisioning arrives with Phase 2 and will generate local-only credentials. Production use is out of scope.

## Deploy (staging)
See [docs/deployment/staging.md](docs/deployment/staging.md), [backup-restore](docs/deployment/backup-restore.md), [monitoring](docs/deployment/monitoring.md), [Android](docs/deployment/android-release.md) and [iOS](docs/deployment/ios-release.md) notes, the [release checklist](docs/release/checklist.md) and [release notes](docs/release/v2.0.0-release-notes.md). Production banking use is out of scope.
