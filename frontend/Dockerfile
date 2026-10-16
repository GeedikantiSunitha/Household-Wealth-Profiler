# The web tier (the front end): the screens built from frontend/src into frontend/dist (bundled and
# minified by scripts/build-web.js, with core.js and the pinned libraries copied byte for byte), served
# by nginx, which also passes /api/, /healthz and /readyz to the API service, so the screens and the API
# share one domain and the session cookie, the CSRF token, the same-site check and the content
# security policy work unchanged. It is the only service that needs to face the internet.
#
# Build from the repository root, so packages/core and the build script are in the context:
#   docker build -f frontend/Dockerfile -t hwp-web .
# Settings (substituted into nginx.conf.template at start):
#   API_UPSTREAM  where the API answers: http://api:8080 on a private network, or the API service's
#                 https address when the host has none (then set API_HOST to that host name)
#   API_HOST      the Host header sent to the API; "$host" (the default) keeps the public domain

# Stage 1: the build (esbuild is a development dependency; nothing from this stage but dist/ goes on)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
RUN npm ci && npm cache clean --force
COPY packages/core ./packages/core
COPY frontend/src ./frontend/src
COPY scripts/build-web.js ./scripts/build-web.js
RUN node scripts/build-web.js

# Stage 2: nginx, unprivileged, port 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_UPSTREAM=http://api:8080 API_HOST='$host' NGINX_ENVSUBST_FILTER=^API_
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
