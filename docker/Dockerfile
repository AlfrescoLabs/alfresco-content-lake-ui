# ============================================================
# Alfresco Content App + ext-rag
#
# Multi-stage build that:
#   1. Clones Alfresco Content App from GitHub
#   2. Copies the ext-rag extension into projects/
#   3. Patches extensions.module.ts and project.json
#   4. Builds the Angular application
#   5. Serves the static files with nginx
#
# Runtime environment variables:
#   APP_CONFIG_ECM_HOST          - Alfresco base URL       (default: http://localhost:8080)
#   APP_CONFIG_RAG_URL           - RAG service URL         (default: http://localhost:9091)
#   APP_CONFIG_CONTENT_LAKE_URL  - batch-ingester base URL (default: http://localhost:9090)
#
# Build arguments:
#   ACA_TAG – Git tag or branch to build from (default: develop)
#   ACA_BUILDER_IMAGE – Base image for the build stage (default: node:24-alpine)
#   ACA_RUNTIME_IMAGE – Base image for the runtime stage (default: nginxinc/nginx-unprivileged:1.25-alpine)
# ============================================================

# Base images can be overridden, e.g. to use a private registry, a mirror
# or hardened images.
ARG ACA_BUILDER_IMAGE=node:24-alpine
ARG ACA_RUNTIME_IMAGE=nginxinc/nginx-unprivileged:1.25-alpine

# ----- Stage 1: Build -----
# ACA 7.4.x moved to a Node 24 toolchain; older builders can fail during npm ci.
FROM ${ACA_BUILDER_IMAGE} AS builder

ARG ACA_TAG=develop

# Build-only stage; needed to install git when the base image runs as non-root.
USER root

RUN set -eu; \
    if command -v git >/dev/null 2>&1; then \
        echo "git is already installed"; \
    else \
        . /etc/os-release; \
        case " ${ID:-} ${ID_LIKE:-} " in \
            *" alpine "*) apk add --no-cache git ;; \
            *" debian "*) apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* ;; \
            *) echo "Unsupported OS for installing git: ${ID:-unknown}" >&2; exit 1 ;; \
        esac; \
    fi

WORKDIR /build

# Clone Alfresco Content App
RUN git clone --depth 1 --branch ${ACA_TAG} \
    https://github.com/Alfresco/alfresco-content-app.git .

# Copy ext-rag extension
COPY ext-rag/src/                  projects/ext-rag/src/
COPY ext-rag/tsconfig.lib.json     projects/ext-rag/tsconfig.lib.json
COPY ext-rag/tsconfig.lib.prod.json projects/ext-rag/tsconfig.lib.prod.json
COPY ext-rag/README.md             projects/ext-rag/README.md
COPY LICENSE                       projects/ext-rag/LICENSE

# ----------------------------------------------------------
# Patch 1: Register ext-rag in extensions.module.ts
# ----------------------------------------------------------
RUN sed -i \
    "/^import.*provideAboutExtension.*$/a import { provideRagExtension } from 'projects/ext-rag/src/public-api';" \
    app/src/app/extensions.module.ts && \
    sed -i \
    "/\.\.\.provideAboutExtension()/a\\    ...provideRagExtension()," \
    app/src/app/extensions.module.ts

# ----------------------------------------------------------
# Patch 2: Add ext-rag.plugin.json asset to project.json
# ----------------------------------------------------------
RUN sed -i \
    '/"glob": "folder-rules.plugin.json"/,/}/{ /}/a\          },\n          {\n            "glob": "ext-rag.plugin.json",\n            "input": "projects/ext-rag/src/assets",\n            "output": "./assets/plugins"\n          }' \
    app/project.json || true
# Fallback: use node to patch JSON reliably
RUN node -e " \
  const fs = require('fs'); \
  const pj = JSON.parse(fs.readFileSync('app/project.json', 'utf8')); \
  const assets = pj.targets.build.options.assets; \
  const exists = assets.some(a => typeof a === 'object' && a.glob === 'ext-rag.plugin.json'); \
  if (!exists) { \
    assets.push({ \
      glob: 'ext-rag.plugin.json', \
      input: 'projects/ext-rag/src/assets', \
      output: './assets/plugins' \
    }); \
    fs.writeFileSync('app/project.json', JSON.stringify(pj, null, 2)); \
  } \
"

# ----------------------------------------------------------
# Patch 3: Add ragService config to app.config.json
# ----------------------------------------------------------
RUN node -e " \
  const fs = require('fs'); \
  const cfg = JSON.parse(fs.readFileSync('app/src/app.config.json', 'utf8')); \
  if (!cfg.plugins) cfg.plugins = {}; \
  cfg.plugins.ragService = { \
    baseUrl: '/api/rag', \
    searchPath: '/search/semantic', \
    promptPath: '/prompt', \
    streamPath: '/chat/stream', \
    facetsPath: '/search/facets', \
    statusUrl: '/api/status', \
    namedQueriesPath: '/named-queries', \
    connectorsUrl: '' \
  }; \
  cfg.plugins.contentLakeService = { \
    baseUrl: '/api/content-lake' \
  }; \
  fs.writeFileSync('app/src/app.config.json', JSON.stringify(cfg, null, 2)); \
"

# ----------------------------------------------------------
# Patch 4: Increase bundle size budget (ext-rag adds ~350 kB)
# ----------------------------------------------------------
RUN sed -i 's/"maximumError": "5mb"/"maximumError": "6mb"/g' app/project.json

# Install dependencies and build
RUN npm ci
RUN npx nx build content-ce --configuration=production

# ----- Stage 2: Serve with nginx -----
FROM ${ACA_RUNTIME_IMAGE}

USER root
RUN apk update && apk upgrade && apk add --no-cache bash && \
    mkdir -p /var/cache/nginx && \
    chown -R 101:101 /var/cache/nginx
USER 101

# Copy nginx configuration template
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template

# Copy entrypoint script for app.config.json env substitution
COPY docker/30-ext-rag-config.sh /docker-entrypoint.d/30-ext-rag-config.sh

USER root
RUN chmod +x /docker-entrypoint.d/30-ext-rag-config.sh && \
    chmod a+w -R /etc/nginx/conf.d
USER 101

# Copy built application
COPY --from=builder /build/dist/content-ce /usr/share/nginx/html/

# The entrypoint rewrites app.config.json with sed -i, which needs write
# access to both the file and its parent directory.
USER root
RUN chown 101:101 /usr/share/nginx/html /usr/share/nginx/html/app.config.json
USER 101

# Default environment variables
ENV APP_CONFIG_ECM_HOST=http://localhost:8080
ENV APP_CONFIG_RAG_URL=http://localhost:9091
ENV APP_CONFIG_CONTENT_LAKE_URL=http://localhost:9090

EXPOSE 8080
