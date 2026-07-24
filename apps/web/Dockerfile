# Build from the monorepo root:
#   docker build -f apps/web/Dockerfile -t bunchax/atk-store \
#     --build-arg VITE_API_URL=https://atk-dashboard.hexdas.cloud .
#
# Run:
#   docker run -p 8080:80 bunchax/atk-store

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN bun install --frozen-lockfile

# Copy sources only — do not overwrite apps/web/node_modules from install
COPY apps/web/index.html apps/web/vite.config.js ./apps/web/
COPY apps/web/public ./apps/web/public
COPY apps/web/src ./apps/web/src

ARG VITE_API_URL=http://localhost:3004
ENV VITE_API_URL=$VITE_API_URL

WORKDIR /app/apps/web
RUN bun run build

FROM nginx:alpine AS runner

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
