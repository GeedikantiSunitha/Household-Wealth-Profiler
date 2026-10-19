# The web tier (the front end): the screens built from frontend/src into frontend/dist (bundled and
# minified by scripts/build-web.js, with core.js and the pinned libraries copied byte for byte), served
# by nginx, which also passes /api/, /healthz and /readyz to the API service, so the screens and the API
# share one domain and the session cookie, the CSRF token, the same-site check and the content
# security policy work unchanged. It is the only service that needs to face the internet.
#
# Build from the repository root, so packages/core and the build script are in the context:
#   docker build -f frontend/Dockerfile -t hwp-web .
# Settings (substituted into nginx.conf.template at start):
#   BACKEND_URL   the back end's internal address, where the browser's /api/ calls are passed:
#                 http://<back-end internal hostname>:8080 on the host's private network (DCDeploy:
#                 the back-end service's internal link). Default http://api:8080 (the local compose
#                 file). API_UPSTREAM, its earlier name, is still accepted when BACKEND_URL is unset.
#   API_HOST      the Host header sent to the API; "$host" (the default) keeps the public domain
#   API_BASE_URL  split-address mode only: the back end's own public address, https://api.example.com. The
#                 page then calls that address directly (and its content security policy allows it); the
#                 back end must list this front end's address in its FRONTEND_ORIGIN. Unset: one address,
#                 the page calls api/ here and nginx passes it on to BACKEND_URL. BACKEND_URL then defaults
#                 to this address, so the container starts without a private network.

# Stage 1: the build (esbuild is a development dependency; nothing from this stage but dist/ goes on)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci && npm cache clean --force
COPY packages/core ./packages/core
COPY frontend/src ./frontend/src
COPY scripts/build-web.js ./scripts/build-web.js
RUN node scripts/build-web.js

# Stage 2: nginx, unprivileged, port 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_HOST='$host' API_BASE_URL='' NGINX_ENVSUBST_FILTER=^(API_HOST|BACKEND_URL|API_BASE_URL|CONNECT_SRC_EXTRA)$
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
# BACKEND_URL, else the earlier API_UPSTREAM, else the default; then nginx's own start-up fills in the template
ENTRYPOINT ["/bin/sh", "-c", "if [ -n \"$API_BASE_URL\" ]; then case \"$API_BASE_URL\" in http://*|https://*) ;; *) echo 'API_BASE_URL must be the back end address as http(s)://host[:port]' >&2; exit 1;; esac; echo \"$API_BASE_URL\" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || { echo 'API_BASE_URL must be the back end address as http(s)://host[:port], no path' >&2; exit 1; }; fi; export CONNECT_SRC_EXTRA=\"${API_BASE_URL:+ $API_BASE_URL}\" BACKEND_URL=\"${BACKEND_URL:-${API_UPSTREAM:-${API_BASE_URL:-http://api:8080}}}\"; exec /docker-entrypoint.sh \"$@\"", "--"]
CMD ["nginx", "-g", "daemon off;"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
