# Build context must be the repo ROOT.
# From repo root:
#   docker build -f apps/web/Dockerfile -t <user>/atk-store-web .

FROM oven/bun:1.3-slim AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

COPY . .
# `build` script filters to the web workspace -> outputs apps/web/dist
RUN bun run build

FROM nginx:alpine AS release
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
