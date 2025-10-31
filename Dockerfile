FROM --platform=linux/amd64 node:22-slim

WORKDIR /app

# Install system dependencies and Chromium
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  libdrm2 \
  libgbm1 \
  xdg-utils \
  wget \
  curl \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

# Avoid puppeteer trying to download its own Chrome inside the image
ENV PUPPETEER_SKIP_DOWNLOAD=1
# Let our code know where Chromium lives
ENV CHROME_PATH=/usr/bin/chromium

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy rest of the app
COPY . .

# Environment
ENV NODE_ENV=development

# Expose ports
EXPOSE 5000 4000

# Load secrets (if present) then start app
COPY secrets.txt scripts/load-secrets.sh ./
RUN chmod +x load-secrets.sh
CMD ["npm", "run", "serve"]