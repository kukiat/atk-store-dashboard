# Build from the monorepo root:
#   docker build -f apps/web/Dockerfile -t atk-web \
#     --build-arg VITE_API_URL=https://api.example.com .
#
# Run:
#   docker run -p 8080:80 atk-web

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

COPY apps/web ./apps/web

ARG VITE_API_URL=http://localhost:3004
ENV VITE_API_URL=$VITE_API_URL

RUN bun run --filter '@atk-store-dashboard/web' build

FROM nginx:alpine AS runner

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
