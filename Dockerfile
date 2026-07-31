# ──────────────────────────────────────────────────────────────────────────────
# omicx-local-all-in-one — Next.js 15 standalone image
#
# Internal, VPN-only API testing tool. Port 8080.
# Build:  docker build -t <your-registry>/ci/omicx-local-all-in-one:latest .
#
# NOTE: if the build env cannot reach Docker Hub, replace `node:20-alpine`
#       with the Harbor-mirrored node image (ask ops).
# ──────────────────────────────────────────────────────────────────────────────

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build                    # emits .next/standalone (next.config.js: output:'standalone')

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
# node:20-alpine already ships a non-root `node` user (uid/gid 1000).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/openapi ./openapi
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:8080/api/health || exit 1
CMD ["node", "server.js"]
