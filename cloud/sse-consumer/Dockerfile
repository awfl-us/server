# Python AWFL consumer workspace image
# - Python 3.11 slim
# - Installs awfl from PyPI
# - Includes git, ssh, curl, gh
# - Runs as non-root user
# - Writable workspace under /workspace

FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/home/awfl/.local/bin:${PATH}" \
    HOME="/home/awfl" \
    PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" \
    WORKDIR="/workspace"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       openssh-client \
       gnupg \
       bash \
       jq \
       coreutils \
       sed \
       grep \
       findutils \
       nodejs \
       npm \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI from official GitHub apt repo.
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Browser support lives in the existing AWFL consumer image, not a separate MCP image.
# Install browser system dependencies while still root.
RUN python -m pip install --no-cache-dir playwright==1.64.1 \
    && python -m playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

# Include gcloud for project-scoped Google Cloud testing. OAuth refresh tokens never enter the image or Job.
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz -o /tmp/gcloud.tar.gz \
    && echo '16fda6058d66e4ec29e8575e2b6e19b0d03cea7b091e6730f7e8361209e6955f  /tmp/gcloud.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/gcloud.tar.gz -C /opt \
    && rm /tmp/gcloud.tar.gz
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"

# Non-root user for tool execution.
RUN useradd -m -s /bin/bash awfl \
    && mkdir -p /workspace /app \
    && chown -R awfl:awfl /workspace /app /home/awfl

USER awfl

# Deployment pins the exact CLI revision with the MCP execution enhancements.
# Without an explicit revision, preserve the normal published AWFL behavior.
ARG AWFL_CLI_REF
RUN python -m pip install --user --upgrade pip \
    && if [ -n "$AWFL_CLI_REF" ]; then \
         python -m pip install --user "awfl @ git+https://github.com/awfl-us/cli.git@${AWFL_CLI_REF}"; \
       else \
         python -m pip install --user awfl; \
       fi

WORKDIR /workspace

CMD ["awfl"]