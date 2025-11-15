# Node-only SSE consumer for Cloud Run
FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Install deps separately for better layer caching
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# App sources
COPY app ./app
COPY README.md ./README.md

# Use non-root user
USER node
EXPOSE 8080
CMD ["node", "app/server.js"]
