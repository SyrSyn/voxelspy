# Local evaluation image: static free tools, without PDM or a model API.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@voxelspy/web

FROM nginx:1.28-alpine
COPY deploy/static/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/static/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
