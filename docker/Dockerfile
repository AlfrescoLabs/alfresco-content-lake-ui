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
# ============================================================

# ----- Stage 1: Build -----
# ACA 7.4.x moved to a Node 24 toolchain; older builders can fail during npm ci.
FROM node:24-alpine AS builder

ARG ACA_TAG=develop

RUN apk add --no-cache git

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
# ext-rag imports ngx-markdown and marked in its chat view. ACA 7.x brings ngx-markdown, ACA 8 (Angular 20) does
# not, so install the ngx-markdown of the host's Angular major when it is missing. marked is its peer.
RUN if ! node -e "require.resolve('ngx-markdown')" 2>/dev/null; then \
      angular=$(node -p "require('@angular/core/package.json').version.split('.')[0]") && \
      npm install --no-save "ngx-markdown@^${angular}" "marked@^15"; \
    fi
RUN npx nx build content-ce --configuration=production

# ----- Stage 2: Serve with nginx -----
FROM nginxinc/nginx-unprivileged:1.25-alpine

USER root
RUN apk update && apk upgrade && apk add --no-cache bash
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

# The official 15-local-resolvers.envsh exports NGINX_LOCAL_RESOLVERS from /etc/resolv.conf when this is
# set; default.conf.template needs it to look the upstreams up per request.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

# Default environment variables: base URLs (scheme, host and port), without a path
ENV APP_CONFIG_ECM_HOST=http://localhost:8080
ENV APP_CONFIG_RAG_URL=http://localhost:9091
ENV APP_CONFIG_CONTENT_LAKE_URL=http://localhost:9090

EXPOSE 8080
