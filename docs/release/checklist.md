# Release checklist (staging)

Tick every item for the exact commit you are releasing. "Done by CI/me" items were run during Phase 10; re-run them for any later commit.

## Code and tests
- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build`
- [ ] `pnpm --filter @zentrix/api test` (needs the migrated test database), `@zentrix/worker`, `@zentrix/admin`
- [ ] `cd apps/mobile && flutter analyze && flutter test`
- [ ] `pnpm audit` clean
- [ ] GitHub Actions green on the commit (it has **never run yet**; the first run may expose environment differences)

## Data
- [ ] Fresh backup taken and `verify-backup.sh` passes
- [ ] Migrations reviewed; applied to a copy of staging data first if the release adds any
- [ ] `ALLOW_SETUP_TOKEN_IN_RESPONSE` is `false` unless you deliberately need it

## Deploy
- [ ] `docker compose ... up -d --build` finishes with `api` healthy
- [ ] `node infrastructure/scripts/smoke.mjs` passes against the public address (also with `SMOKE_REGISTER=1` on staging)
- [ ] Admin portal opens over **HTTPS**, sign-in works with MFA, System health shows "All clear"
- [ ] A scheduled payment and a notification are seen to complete (worker is running)

## Mobile
- [ ] Release build made with the real key and an **HTTPS** `API_BASE_URL`; version/build number bumped
- [ ] On a real device: register, sign in, KYC, open an account (staff approves), pay, QR scan, biometric unlock, statement share, a support message
- [ ] Reviewed light and dark themes, large text, and screen reader labels on the screens you changed

## Security
- [ ] Secrets are unique to this environment and not in git (`git status` clean, `.env.staging` ignored)
- [ ] First administrator's setup file deleted; no shared accounts
- [ ] TLS terminates in front of the portal; HSTS set; database and Redis not reachable from outside
- [ ] Swagger (`/api/docs`) restricted or disabled if the environment is public

## Limits to state in release notes
Simulation only; no real money, identities or regulated integrations. Production banking use needs independent security review, regulated integrations and authorization that this project does not have.
