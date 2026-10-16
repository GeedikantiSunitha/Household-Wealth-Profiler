# The API as a service of its own (the back end). It answers /api/, /healthz and /readyz only
# (SERVE_WEB=0); the screens come from the web tier (frontend/Dockerfile) on the same domain.
# The one-service image that serves the screens itself is the Dockerfile at the repository root.
#
# Build from the repository root, so the workspace manifest and packages/core are in the context:
#   docker build -f backend/Dockerfile -t hwp-api .
# On DCDeploy: build context ./, Dockerfile path backend/Dockerfile, port 8080, the variables
# from ops/DEPLOYMENT.md section 6. No volume: with DATABASE_URL set nothing is written to disk.
#
# There is no build step (plain Node, no TypeScript), so one stage is honest: npm ci --omit=dev
# installs the one runtime package (pg) and links packages/core as @hwp/core.
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 SERVE_WEB=0
WORKDIR /app
COPY package.json package-lock.json ./
# Workspace manifests must be present before npm ci
COPY packages/core/package.json ./packages/core/
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY backend ./backend
COPY db ./db
COPY packages ./packages
# The node image's unprivileged user; 8080 needs no privilege
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
