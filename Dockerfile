# Paiso, self-hosted: one image that serves the web app and the API.
#
#   docker compose up -d        (see docker-compose.yml)
#
# Stage 1 builds the web app; stage 2 is the Python app, which serves the
# build from /app/static and keeps its data (the SQLite file and uploads) in
# /data. It runs as a non-root user.

# Base images are pinned by digest, so the same commit builds on the same
# base; Dependabot's Docker updates move the digests. Node 24 is the current
# LTS line (Node 20 reached end of life on 2026-04-30).
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
# Where Settings, About says the source is (AGPL-3.0 section 13). A fork
# that others use sets it to its own repository.
ARG SOURCE_URL=""
ENV VITE_BASE_PATH=/ \
    VITE_SOURCE_URL=$SOURCE_URL
RUN npm run build:docker


FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# The base image lags Debian's security updates; take them at build time.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# requirements.lock pins every package, transitive ones included, with
# hashes: a rebuild of the same commit installs the same bytes, and a package
# that changed under its version number fails the build. Regenerate it as
# backend/README.md describes.
COPY backend/requirements.txt backend/requirements.lock ./
RUN pip install --require-hashes -r requirements.lock

COPY backend/ ./
COPY --from=web /web/dist /app/static
# The npm half of the licence list is in the build; add the Python half.
RUN python scripts/python_licenses.py >> /app/static/third-party-licenses.txt

ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
ENV PAISO_APP_VERSION=$APP_VERSION \
    PAISO_GIT_COMMIT=$GIT_COMMIT \
    PAISO_BUILD_TIME=$BUILD_TIME \
    PAISO_RELEASE_CHANNEL=prod \
    PAISO_STATIC_DIR=/app/static \
    PAISO_STORAGE_ROOT=/data \
    PAISO_SQLITE_PATH=/data/paiso.db

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin paiso \
    && mkdir -p /data \
    && chown paiso:paiso /data
USER paiso
VOLUME /data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
