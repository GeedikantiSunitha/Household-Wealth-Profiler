# The web tier (the front end): nginx serving apps/web/public and core.js exactly as they are in the
# repository (the browser runs the modules directly; there is no build step), and passing /api/,
# /healthz and /readyz to the API service, so the screens and the API share one domain and the
# session cookie, the CSRF token, the same-site check and the content security policy work
# unchanged. It is also the only service that needs to face the internet.
#
# Build from the repository root, so packages/core is in the context:
#   docker build -f apps/web/Dockerfile -t hwp-web .
# Settings (substituted into nginx.conf.template at start):
#   API_UPSTREAM  where the API answers: http://api:8080 on a private network, or the API service's
#                 https address when the host has none (then set API_HOST to that host name)
#   API_HOST      the Host header sent to the API; "$host" (the default) keeps the public domain
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_UPSTREAM=http://api:8080 API_HOST='$host' NGINX_ENVSUBST_FILTER=^API_
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/public /usr/share/nginx/html
COPY packages/core/core.js /usr/share/nginx/html/core.js
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
