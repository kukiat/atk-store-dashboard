# Build from the monorepo root:
#   docker build -f apps/api/Dockerfile -t atk-api .
#
# Run:
#   docker run --env-file apps/api/.env -p 3004:3004 atk-api

FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/apps/api/package.json ./apps/api/package.json
COPY --from=deps /app/apps/web/package.json ./apps/web/package.json
COPY --from=deps /app/packages/shared/package.json ./packages/shared/package.json

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN bun run --filter '@atk-store-dashboard/api' build

FROM oven/bun:1-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3004

COPY --from=build /app/apps/api/dist ./dist

EXPOSE 3004
CMD ["bun", "dist/index.js"]
