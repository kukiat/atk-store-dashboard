# Build from the monorepo root:
#   docker build -f apps/api/Dockerfile -t bunchax/atk-store-api .
#
# Run:
#   docker run --env-file apps/api/.env -p 3004:3004 bunchax/atk-store-api

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN bun install --frozen-lockfile

# Copy sources only — do not overwrite apps/api/node_modules from install
COPY packages/shared ./packages/shared
COPY apps/api/tsconfig.json apps/api/drizzle.config.ts ./apps/api/
COPY apps/api/src ./apps/api/src

WORKDIR /app/apps/api
RUN bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3004

COPY --from=build /app/apps/api/dist ./dist

EXPOSE 3004
CMD ["bun", "dist/index.js"]
