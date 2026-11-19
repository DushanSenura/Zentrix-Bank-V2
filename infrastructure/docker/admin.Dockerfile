# Admin portal: static build served by nginx, which also proxies /api to the backend (same origin, no CORS needed).
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY database/package.json database/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @zentrix/admin...
COPY apps/admin apps/admin
RUN pnpm --filter @zentrix/admin build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
