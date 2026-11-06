FROM mcr.microsoft.com/playwright/python:v1.58.2-noble
ARG AWFL_CLI_REF
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/home/awfl PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git curl nodejs npm bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN test -n "$AWFL_CLI_REF" \
    && pip install --no-cache-dir "awfl @ git+https://github.com/awfl-us/cli.git@${AWFL_CLI_REF}" playwright==1.58.2
# The base image may already reserve uid 1000; use its numeric identity.
RUN mkdir -p /workspace /home/awfl && chown 1000:1000 /workspace /home/awfl
USER 1000:1000
WORKDIR /workspace
CMD ["awfl", "run"]
