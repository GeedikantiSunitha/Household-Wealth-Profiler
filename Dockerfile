FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
# Workspace manifests must be present before npm ci
COPY packages/core/package.json ./packages/core/
# Only "pg" (for DATABASE_URL); dev packages are left out
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY db ./db
COPY packages ./packages
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Host volumes (e.g. Fly.io) are mounted owned by root: hand /data to the node user, then drop root.
CMD ["sh", "-c", "chown node:node \"$DATA_DIR\" && exec su-exec node node server.js"]
