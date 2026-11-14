# NOTE: Don’t pin a constant --platform here.
# If you need to cross-build, pass it at build time:
#   docker buildx build --platform=linux/amd64 ...
# or
#   docker build --platform=linux/amd64 ...
FROM node:22-alpine

WORKDIR /app

# Install minimal useful tools
RUN apk add --no-cache \
  bash \
  curl \
  docker-cli \
  ca-certificates

# Copy package files & install dependencies
COPY package*.json ./
RUN npm install

# Copy app code
COPY ./workflows ./workflows
COPY ./jobs ./jobs
COPY ./mcp ./mcp
COPY ./agentsMcp ./agentsMcp
COPY ./observability ./observability
COPY dev.js api.server.js jobs.server.js ./

ENV NODE_ENV=development

# Expose ports for Cloud Run, local dev, etc.
EXPOSE 8080 5000 4000

# Load secrets and run entrypoint script
COPY secrets.txt scripts/load-secrets.sh ./
COPY scripts/start.sh scripts/start.sh
RUN chmod +x load-secrets.sh scripts/start.sh

CMD ["scripts/start.sh"]
