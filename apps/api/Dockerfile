# Build context must be the repo ROOT (needed for bun.lock + packages/shared).
# From repo root:
#   docker build -f apps/api/Dockerfile -t <user>/atk-store-api .

FROM oven/bun:1.3-slim AS install
WORKDIR /app

# Copy only manifests first so Docker can cache the dependency layer.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-slim AS release
WORKDIR /app
ENV NODE_ENV=production

COPY --from=install /app/node_modules node_modules
COPY package.json bun.lock ./
COPY apps/api apps/api
COPY packages/shared packages/shared

ENV PORT=3004
EXPOSE 3004
CMD ["bun", "apps/api/src/index.ts"]
