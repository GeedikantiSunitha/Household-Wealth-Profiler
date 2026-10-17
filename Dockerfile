FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
# Workspace manifests must be present before npm ci
COPY packages/core/package.json ./packages/core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
# Only "pg" (for DATABASE_URL); dev packages are left out
# npm is needed only to install: the running app starts with node, and every command is node server.js.
# npm, npx, corepack and yarn are removed from the image, so their bundled packages (where the scanner finds
# known vulnerabilities) are not shipped, and an intruder has no package manager to hand.
RUN npm ci --omit=dev && npm cache clean --force  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm
COPY server.js ./
COPY backend ./backend
COPY db ./db
COPY packages ./packages
COPY frontend/src ./frontend/src
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Host volumes (e.g. Fly.io) are mounted owned by root: hand /data to the node user, then drop root.
CMD ["sh", "-c", "chown node:node \"$DATA_DIR\" && exec su-exec node node server.js"]
