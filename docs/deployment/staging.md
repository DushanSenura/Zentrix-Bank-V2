# Staging deployment

Zentrix Bank V2 is a **banking simulation with fictional data**. Staging exists to exercise the whole platform (admin portal, API,
worker, database, cache) the way it would run for real. Production banking use is out of scope.

## What runs
| Service | Image | Notes |
| --- | --- | --- |
| `postgres` | `postgres:16-alpine` | Persistent volume. No published port. |
| `redis` | `redis:7-alpine` | Password protected, append-only persistence, no published port. |
| `migrate` | backend image | One-off: `prisma migrate deploy`, then seeds RBAC, products and branches. Creates **no** demo users outside development. |
| `api` | backend image | NestJS. Uploads go to the `uploads` volume. Healthcheck on `/api/v1/health/live`. |
| `worker` | backend image | Outbox relay (notifications), due-payment and reminder tick, optional push gateway. |
| `admin` | nginx | Serves the portal and proxies `/api/` to the API, so the browser sees one origin. Only this container publishes a port. |

## First deployment
```bash
cp infrastructure/staging.env.example infrastructure/.env.staging     # fill in every value (see the comments in the file)
docker compose -f infrastructure/docker-compose.staging.yml --env-file infrastructure/.env.staging up -d --build
```
Put TLS in front of the admin container (a load balancer or reverse proxy) and set HSTS there. The compose file binds to `127.0.0.1` by
default so nothing is exposed until you decide to.

### Create the first administrator
No demo users exist in staging. Create the first Super Administrator once, from inside the stack:
```bash
docker compose -f infrastructure/docker-compose.staging.yml --env-file infrastructure/.env.staging run --rm \
  -v "$PWD/infrastructure/out:/out" api node dist/bootstrap-admin.js \
  --username ops.admin --email ops@example.test --name "Ops Admin" --out /out/ops.setup.json
```
The one-time setup token is written to that file (owner-only), **never printed**. The administrator opens the portal's setup page with it,
chooses a password and enrols an authenticator app (staff sign-in always needs a code). Tokens are single-use and expire after 72 hours.
Delete the file afterwards. The command refuses to run if a Super Administrator already exists (`--additional` creates an audited
recovery admin and needs database-level access to the environment).

Later staff are invited from the portal. There is no email delivery yet, so an invitation's token is not shown anywhere unless you set
`ALLOW_SETUP_TOKEN_IN_RESPONSE=true` (staging only, ignored in production); the inviting administrator then hands it to the invitee over a
secure channel.

## Verify a deployment
```bash
BASE_URL=https://staging-admin.example.test node infrastructure/scripts/smoke.mjs
SMOKE_REGISTER=1 BASE_URL=... node infrastructure/scripts/smoke.mjs      # also registers a throwaway customer
```
The smoke test needs no staff credentials and moves no money. It checks the portal and API headers, health including database and Redis,
anonymous refusal, the internal-job secret, request-size handling and (optionally) customer register/sign-in/refresh and role separation.
It is a smoke test, not an end-to-end test: approving a customer, moving money and the admin workflows need a signed-in administrator and are
covered by the integration suites, not by this script.

## Upgrades and rollback
* Upgrade: `git pull`, then the same `up -d --build`. `migrate` runs first and the API waits for it.
* Migrations are forward-only. Take a backup first (`infrastructure/scripts/backup.sh`); to roll back, restore the backup into a new
  database (see `backup-restore.md`) and point `POSTGRES_DB` at it.
* Rolling back code without a schema change is `git checkout <tag>` and rebuild.

## Secrets
Everything secret lives in `infrastructure/.env.staging` (git-ignored). Generate fresh values per environment; never reuse development
secrets. Rotating `JWT_ACCESS_SECRET` signs everyone out. `DATA_ENCRYPTION_KEY` encrypts staff authenticator secrets: changing it
locks staff out of MFA until they re-enrol, so rotate it deliberately. The environment loader refuses to start with missing or weak values.

## Known limits
* The images are not slimmed (the runtime stage copies the built workspace), they run as the unprivileged `node` user, and they have not
  been scanned by an image scanner.
* Swagger is served at `/api/docs` in every non-production environment, including staging.
* Single instance of each service: no high availability, no horizontal scaling test.
