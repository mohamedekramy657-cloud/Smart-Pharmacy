# syntax=docker/dockerfile:1
# Web (Next.js standalone). Build context: repository root.  docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root
COPY apps/web apps/web
# Rewrites are resolved at build time: point them at the internal API service.
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
ARG NEXT_PUBLIC_SHOW_DEMO_BANNER=false
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_MAP_TILE_URL=$NEXT_PUBLIC_MAP_TILE_URL NEXT_PUBLIC_SHOW_DEMO_BANNER=$NEXT_PUBLIC_SHOW_DEMO_BANNER NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace apps/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
