# The API as a service of its own (the back end). It answers /api/, /healthz and /readyz only
# (SERVE_WEB=0); the screens come from the web tier (frontend/Dockerfile) on the same domain.
# The one-service image that serves the screens itself is the Dockerfile at the repository root.
#
# Build from the repository root, so the workspace manifest and packages/core are in the context:
#   docker build -f backend/Dockerfile -t hwp-api .
# On DCDeploy: build context ./, Dockerfile path backend/Dockerfile, port 3001, the variables
# from ops/DEPLOYMENT.md section 6. No volume: with DATABASE_URL set nothing is written to disk.
#
# There is no build step (plain Node, no TypeScript), so one stage is honest: npm ci --omit=dev
# installs the one runtime package (pg) and links packages/core as @hwp/core.
FROM node:22-alpine
# Port 3001: the back end has a port of its own, apart from the front end's 8080 (each runs in its
# own container, so the same number would not clash either; a distinct one keeps them easy to tell apart).
# PORT set on the service changes it, and the health check follows it.
ENV NODE_ENV=production PORT=3001 SERVE_WEB=0
WORKDIR /app
COPY package.json package-lock.json ./
# Workspace manifests must be present before npm ci
COPY packages/core/package.json ./packages/core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
# npm is needed only to install: the running app starts with node, and every command is node server.js.
# npm, npx, corepack and yarn are removed from the image, so their bundled packages (where the scanner finds
# known vulnerabilities) are not shipped, and an intruder has no package manager to hand.
RUN npm ci --omit=dev && npm cache clean --force  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm
COPY server.js ./
COPY backend ./backend
COPY db ./db
COPY packages ./packages
# The node image's unprivileged user; a port above 1024 needs no privilege
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server.js"]
