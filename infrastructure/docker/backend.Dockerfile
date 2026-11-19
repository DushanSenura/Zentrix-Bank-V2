# One image for the API, the worker and the one-off database tasks (migrate, seed, bootstrap-admin).
# Build from the repository root:  docker build -f infrastructure/docker/backend.Dockerfile -t zentrix-backend .
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && apt-get clean
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY database/package.json database/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @zentrix/api... --filter @zentrix/worker... --filter @zentrix/database...
COPY database database
COPY services services
RUN pnpm --filter @zentrix/database generate && pnpm --filter @zentrix/api build && pnpm --filter @zentrix/worker build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && apt-get clean
ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads
ENV STORAGE_DIR=/data/uploads
USER node
WORKDIR /app/services/api
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
