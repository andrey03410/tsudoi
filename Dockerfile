# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 VITE_PROVISIONED_ACCOUNTS_ONLY=1
RUN npm ci && npm run build

FROM base AS runtime
COPY --from=build --chown=node:node /app /app
RUN install -d -o node -g node storage
ENV NODE_ENV=production PROVISIONED_ACCOUNTS_ONLY=1
ENV TSUDOI_HOST=0.0.0.0 TSUDOI_STORAGE_DIR=/app/storage
USER node
EXPOSE 8791
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 CMD ["node", "-e", "fetch('http://127.0.0.1:8791/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/dist/main.js", "--serve-web"]
