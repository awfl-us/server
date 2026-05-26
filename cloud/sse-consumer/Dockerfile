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

# Non-root user for tool execution.
RUN useradd -m -s /bin/bash awfl \
    && mkdir -p /workspace /app \
    && chown -R awfl:awfl /workspace /app /home/awfl

USER awfl

# Pin this once you have a known-good release.
RUN python -m pip install --user --upgrade pip \
    && python -m pip install --user awfl

WORKDIR /workspace

CMD ["awfl"]