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

# Include gcloud for project-scoped Google Cloud testing. OAuth refresh tokens never enter the image or Job.
# Pin a *versioned* archive; the unversioned /google-cloud-cli-linux-x86_64.tar.gz
# URL changes on every upstream release and silently invalidates a SHA pin.
ARG GCLOUD_SDK_VERSION=592.0.0
RUN curl -fsSL --retry 3 "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_SDK_VERSION}-linux-x86_64.tar.gz" -o /tmp/gcloud.tar.gz \
    && echo '2d841a23a681ab94486af6841e5f1cd123cd300fb8c4be6ba5b51350fca3d50b  /tmp/gcloud.tar.gz' | sha256sum -c - \
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
# All profiles use the same AWFL runtime, project lock and credential refresh.
# Browser and Scala dependencies are deliberately absent from the base image.
FROM base AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
RUN python -m pip install --no-cache-dir playwright==1.64.1 \
    && python -m playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
USER awfl

FROM base AS scala
USER root
ARG SBT_VERSION=1.11.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL --retry 3 "https://github.com/sbt/sbt/releases/download/v${SBT_VERSION}/sbt-${SBT_VERSION}.tgz" -o /tmp/sbt.tgz \
    && tar -xzf /tmp/sbt.tgz -C /opt \
    && rm /tmp/sbt.tgz \
    && ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt
ENV JAVA_HOME="/usr/lib/jvm/java-21-openjdk-amd64"
ENV PATH="/opt/sbt/bin:${PATH}"
USER awfl

# Default for docker build without --target.
FROM base AS lightweight
