# Node-only SSE consumer for local dev and Cloud Run
# - Uses Node 22 (includes global fetch)
# - Installs production deps only
# - Runs as non-root user and writes workspace under /workspace

FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Install deps separately for better layer caching. Prefer npm ci with lockfile.
# Copies only package manifests so dependency layer is reused when app code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App sources
COPY app ./app
COPY README.md ./README.md

# Prepare writable workspace for tools (READ_FILE/UPDATE_FILE/RUN_COMMAND)
# This is the default WORK_ROOT_BASE; override in runtime if needed.
RUN mkdir -p /workspace && chown -R node:node /workspace

# Use non-root user
USER node

EXPOSE 8080
# Health: curl -sf http://localhost:8080/healthz
CMD ["node", "app/server.js"]
