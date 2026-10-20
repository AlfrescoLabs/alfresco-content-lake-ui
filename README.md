# Alfresco Content Lake UI

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![ADF](https://img.shields.io/badge/Alfresco%20ADF-8.4.0--21916318527-7C4DFF.svg)](https://github.com/Alfresco/alfresco-ng2-components)
[![Angular](https://img.shields.io/badge/Angular-19.2.18-DD0031.svg)](https://angular.dev/)
[![Nx](https://img.shields.io/badge/Nx-21.5.2-143055.svg)](https://nx.dev/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue.svg)](https://docs.docker.com/compose/)
[![Status](https://img.shields.io/badge/Status-PoC-yellow.svg)]()

UI extension for [content-lake-app](https://github.com/AlfrescoLabs/content-lake-app) that adds **semantic search** and **RAG question-answering** to Alfresco Content Application (ACA) and Alfresco Digital Workspace (ADW).

## Content Lake Ecosystem

Part of the **Content Lake** ecosystem -- a PoC for ingesting Alfresco and Nuxeo content into [hxpr](https://github.com/HylandSoftware/hxpr) for hybrid semantic search and RAG.

| Repo | Role |
|---|---|
| [content-lake-app](https://github.com/AlfrescoLabs/content-lake-app) | Java ingestion pipeline and RAG service |
| [content-lake-app-deployment](https://github.com/AlfrescoLabs/content-lake-app-deployment) | Docker Compose stack that wires everything together |
| **[alfresco-content-lake-ui](https://github.com/AlfrescoLabs/alfresco-content-lake-ui)** | ACA/ADW extension: semantic search + RAG chat sidebar (this repo) |
| [content-lake-app-ui](https://github.com/AlfrescoLabs/content-lake-app-ui) | Standalone demo UI (Alfresco + Nuxeo dual auth) |
| [nuxeo-deployment](https://github.com/aborroy/nuxeo-deployment) | Local Nuxeo + PostgreSQL stack (required for Nuxeo profiles) |

## Features

* Semantic search panel: free-text query with configurable `topK` / `minScore`, results grouped by document with similarity scores and expandable chunk snippets
* Faceted search: after a query, narrow results by facet (Source, File type) with per-value document counts; clicking a value applies an HXQL filter and re-queries. Mime types are shown as friendly labels (e.g. "Word document")
* Chat-style Q&A: natural language questions answered via RAG, displaying the generated answer, model used, timing breakdown, and referenced source documents with chunks
* Answer options: per-question composer toggles to auto-detect metadata filters from the question (`inferFilters`) and to request a structured answer (summary, key points, citations)
* Citation faithfulness: when backend verification is enabled (`rag.citation.verify.enabled`), each answer shows a grounded / unsupported badge and lists any unsupported claims
* Operational status: a "Content Lake Status" view (nav entry + `rag-status` route) showing hxpr connectivity, indexed document counts per source, embedding-model reachability, and, when `connectorsUrl` is configured, the connectors an ingester has loaded together with anything that failed to load
* Mixed-source awareness: search results and citations show the originating source system, and open Nuxeo hits in Nuxeo Web UI via backend-provided deep links
* Any-source filter: the source filter in search and chat is built from what the index actually holds, so a CMIS repository, a filesystem tree or any plugin connector is selectable without a change here. Two sources of the same type are offered separately and labelled by source id
* Document budget: ask for a number of distinct documents rather than a number of chunks, and see how many documents answered
* Document-scoped mode: right-click any document and choose *"Ask AI about this document"* to open the chat pre-scoped to that file
* Folder-scoped mode: right-click any folder and choose *"Ask AI about this folder"* to scope retrieval to that folder subtree
* Sidebar tab: compact chat panel in the info-drawer, automatically scoped to the selected document or folder.
* Conversation sessions: local session list with restore and *New conversation* support across route changes
* Content Lake scope controls: right-click a folder to add or remove the `cl:indexed` aspect, or use the dedicated *Content Lake* sidebar tab
* Document override: set `cl:excludeFromLake` on a document from the *Content Lake* sidebar to opt it out of an indexed folder subtree
* Visual scope indicators: badges show when a folder or document is in Content Lake scope, and when a document is explicitly excluded
* Document preview: result links open the ACA document viewer; closing the preview returns to the RAG Assistant page
* Zero custom auth code: authentication is forwarded transparently via the ADF HTTP interceptor and a shared gateway

## Prerequisites

* A running [content-lake-app](https://github.com/AlfrescoLabs/content-lake-app) deployment with `rag-service` available
* The `content-lake-repo-model` module deployed in Alfresco Repository so `cl:indexed` and `cl:excludeFromLake` exist
* ACA (Alfresco Content App) source checkout, or ADW (Alfresco Digital Workspace) source
* Node.js 24 (what `docker/Dockerfile` builds with, and what ACA 7.4.x requires)

## Install into ACA

### 1. Copy the extension

```bash
# From the root of your alfresco-content-app clone:
cp -r /path/to/alfresco-content-lake-ui/ext-rag projects/ext-rag
```

On ACA 7.3.0, also install `marked`:

```bash
npm install marked@^15
```

ACA 7.3.0 depends on `ngx-markdown@19.1.1`, which declares `marked: ^15.0.0` as a **required** peer, and ACA's
lockfile does not include it. Without it `ngx-markdown`'s own bundle cannot resolve `marked`, so *every* build
and spec that touches markdown fails -- including ACA's own AI results view, not just this extension. The
symptom is `Module not found: Error: Can't resolve 'marked' in .../ngx-markdown/fesm2022`, and because Karma
compiles a library as one unit it surfaces as the whole bundle failing to load rather than as one file's error.

Check `npm ls marked` before concluding anything is wrong with the extension.

### 2. Register the module

Edit `app/src/app/extensions.module.ts`:

```typescript
import { provideRagExtension } from 'projects/ext-rag/src/public-api';

export function provideApplicationExtensions(): (Provider | EnvironmentProviders)[] {
  return [
    ...provideRagExtension(),
    // keep other extensions here
  ];
}
```

### 3. Add extension assets to the build

Edit `app/project.json` and add to the `build.options.assets` array:

```json
{
  "glob": "ext-rag.plugin.json",
  "input": "projects/ext-rag/src/assets",
  "output": "./assets/plugins"
}
```

### 4. Configure the RAG service URL

Add to `app/src/app.config.json` (see [`config/app.config.snippet.json`](config/app.config.snippet.json)):

```json
{
  "plugins": {
    "ragService": {
      "baseUrl": "/api/rag",
      "searchPath": "/search/semantic",
      "promptPath": "/prompt",
      "streamPath": "/chat/stream",
      "facetsPath": "/search/facets",
      "statusUrl": "/api/status",
      "namedQueriesPath": "/named-queries",
      "facetProperties": ["cin_sourceId", "cin_ingestProperties.source_mimeType"],
      "connectorsUrl": ""
    },
    "contentLakeService": {
      "baseUrl": "/api/content-lake"
    }
  }
}
```

Every key has a default, so a partial block works. Two are worth reading before you set them:

| Key | Default | Notes |
|---|---|---|
| `statusUrl` | `/api/status` | A *sibling* of `baseUrl`, not a child, so it is configured separately. Also the source of the search and chat source filters, which are built from its `sourceCounts`. |
| `connectorsUrl` | `""` (feature off) | Absolute URL of an ingester's `GET /api/connectors`, e.g. `http://localhost:9096/api/connectors`. There is deliberately no same-origin default: that endpoint is published by each ingester rather than by `rag-service`, and the deployment proxy does not forward it. Left empty, the status page omits its connector panel and issues no request. In the Docker image, set the `CONNECTORS_URL` environment variable instead of editing the file. |

### 5. Configure the dev proxy

Add to `app/proxy.conf.js` (see [`config/proxy.conf.snippet.js`](config/proxy.conf.snippet.js)):

```javascript
'/api/rag': {
  target: 'http://localhost:9091',
  changeOrigin: true,
  secure: false,
  logLevel: 'debug'
},
'/api/content-lake': {
  target: 'http://localhost:9090',
  changeOrigin: true,
  secure: false,
  logLevel: 'debug'
}
```

### 6. Run

```bash
npm start
```

Open `http://localhost:4200`, log in, and find the *RAG Assistant* entry in the left navigation.

## Accessing sidebar features

Use this flow to access all sidebar-driven features from the document list:

1. Open any library or folder in ACA and select a node.
2. Click the info drawer toggle (right-side panel icon in the top toolbar) to open the right panel.
3. In the panel header, switch to:
   * *Ask AI* tab for compact document-scoped chat.
   * *Content Lake* tab for scope and ingestion controls.

What you can do from each tab:

* *Ask AI* (document selected):
  * Ask questions about the selected document directly from the sidebar.
  * Keep context while browsing files without leaving the current page.
* *Content Lake* (folder selected):
  * Enable or disable Content Lake inclusion for the folder subtree.
* *Content Lake* (document selected):
  * Exclude or include the document from inherited Content Lake scope.
  * Check *Ingestion status* and refresh it using the refresh icon.

Notes:

* Sidebar tabs appear only when the extension is correctly registered (`provideRagExtension`) and `ext-rag.plugin.json` is included in build assets.
* *Ingestion status* requires `/api/content-lake/*` to be proxied to `batch-ingester` (see proxy/nginx sections below).

## Content Lake scope controls

The extension also exposes the repository scope model introduced by `content-lake-app`:

* Right-click a folder and use *Enable Content Lake for this folder* or *Disable Content Lake for this folder* to add or remove `cl:indexed`
* Open the *Content Lake* tab in the ACA info drawer to manage the same folder toggle without leaving the current view
* Select a document inside an indexed subtree and use *Exclude this document from Content Lake* to set `cl:excludeFromLake=true`
* Look for the `offline_bolt` badge on nodes that are currently in Content Lake scope, and the `block` badge on documents explicitly excluded from ingestion

These controls call the standard Alfresco Repository nodes API directly. No extra UI-specific backend service is required.

## Install into ADW

The mechanism is identical, only the paths change since ADW uses Nx:

1. Place the extension under `libs/ext-rag/` (or generate a new Nx lib and copy the source)
2. Update `tsconfig.base.json` to map `@myorg/ext-rag` > `libs/ext-rag/src/public-api.ts`
3. Spread `provideRagExtension()` into the application's extension providers in
   `apps/content-ee/src/app/extension.module.ts`, exactly as the ACA steps above do. `ExtRagModule` is
   deprecated and kept only for callers that predate the provider
4. Add the plugin JSON asset in `angular.json` under `content-ee` build assets
5. Configure proxy / gateway the same way

## Docker deployment

The `docker` directory contains a production-ready Dockerfile that builds ACA with the ext-rag extension pre-installed:

```bash
docker build -t alfresco-content-lake-ui -f docker/Dockerfile .
```

The image bundles its own nginx, which proxies `/api/rag/` (including the `/api/rag/chat/stream`
SSE endpoint) and `/api/content-lake/` to the backend services. Point those at your environment
with the following runtime environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `APP_CONFIG_ECM_HOST` | Alfresco base URL | `http://localhost:8080` |
| `APP_CONFIG_RAG_URL` | rag-service base URL | `http://localhost:9091` |
| `APP_CONFIG_CONTENT_LAKE_URL` | batch-ingester base URL (Content Lake node status) | `http://localhost:9090` |

When the image runs behind the full deployment proxy, that proxy routes `/api/content-lake` and the
chat stream directly, so these defaults are only used when the image serves those paths on its own.

See [`docker`](docker/) for details on the nginx template and runtime configuration hook.

## Production deployment (nginx)

Add this block inside the `server { }` in your existing `nginx.conf` (see [`config/nginx.snippet.conf`](config/nginx.snippet.conf)):

```nginx
location /api/rag/ {
  proxy_pass http://rag-service:9091/api/rag/;
}

location /api/content-lake/ {
  proxy_pass http://batch-ingester:9090/api/content-lake/;
}
```

This ensures:

* Requests from the browser go to the same origin (no CORS issues)
* The ADF HTTP interceptor attaches the Alfresco auth ticket automatically
* `rag-service` receives the ticket and can validate it against the Alfresco authentication API
* `batch-ingester` serves ingestion-status lookups used by the Content Lake sidebar

## Authentication flow

```
Browser (ACA/ADW)
  │
  │  POST /api/rag/prompt
  │  Header: Authorization: Basic <base64(TICKET_xxx:)>
  │
  ▼
nginx / gateway
  │
  │  proxy_pass → rag-service:9091
  │
  ▼
rag-service
  │
  │  Validates ticket via:
  │  GET /alfresco/api/-default-/public/authentication/versions/1/tickets/-me-
  │
  ▼
Alfresco Repository
```

No custom authentication code is needed in the Angular module. The extension reads the ADF ECM
ticket from browser storage and sends it in the same format ADF uses for repository calls:
`Authorization: Basic base64(ticket:)`. The gateway makes `rag-service` reachable on the same
origin as Alfresco.

That one encoding goes to every Content Lake path the interceptor covers, `/api/rag`,
`/api/content-lake` and `/api/status`, with no per-path variation. The trailing colon is required:
the ticket is the username and the password is empty, and services reject the bare
`base64(ticket)` form with 401.

## API contract

The extension expects the following endpoints from [content-lake-app](https://github.com/AlfrescoLabs/content-lake-app) `rag-service`:

### `POST /api/rag/search/semantic`

Semantic search across indexed content-lake chunks.

**Request:**

```json
{
  "query": "a girl falls in a crater",
  "topK": 5,
  "minScore": 0.5,
  "sourceType": "nuxeo"
}
```

`sourceType` scopes to a whole source type. To scope to one repository where several share a type, put an
equality clause on `cin_sourceId` in `filter` instead: `"filter": "cin_sourceId = 'cmis:docmgr'"`. The
request carries no `sourceId` field, and `rag-service` reads that clause as the caller naming one source,
narrowing the permission filter with it.

`topDocuments` and `chunksPerDocument` are optional. `topK` is a budget of *chunks*, so ten results can be
two documents; when `topDocuments` is present it owns the budget instead and `topK` is ignored. Both
omitted leaves retrieval exactly as it was.

**Response:**

```json
{
  "query": "a girl falls in a crater",
  "model": "OpenAiEmbeddingModel",
  "vectorDimension": 1024,
  "resultCount": 2,
  "totalCount": 2,
  "documentCount": 2,
  "searchTimeMs": 739,
  "results": [
    {
      "rank": 1,
      "score": 0.5760,
      "chunkText": "found herself falling down a very deep well...",
      "sourceDocument": {
        "documentId": "c225f4d5-882b-4b99-81d1-3226af2560a4",
        "nodeId": "4d2a93aa-6a11-431f-9202-58f16062ef5b",
        "sourceId": "nuxeo:nuxeo-demo",
        "sourceType": "nuxeo",
        "name": "down-the-rabbit-hole.pdf",
        "path": "/default-domain/workspaces/literature",
        "mimeType": "application/pdf",
        "openInSourceUrl": "http://localhost:8081/nuxeo/ui/#!/browse/default-domain/workspaces/literature/down-the-rabbit-hole.pdf"
      },
      "chunkMetadata": {
        "embeddingId": "334f91ec-4ed1-41b8-a1aa-bca6c2b1431e",
        "embeddingType": "default",
        "page": 0,
        "paragraph": 3,
        "chunkLength": 773
      }
    }
  ]
}
```

The UI groups results by `sourceDocument.nodeId`, showing one entry per document with all matching chunks listed underneath. Alfresco results from the current repository still open in the ACA viewer, while external-source results use `openInSourceUrl`.

### `POST /api/rag/prompt`

RAG question-answering with optional conversation session controls.
For document scope, the UI translates `nodeId` into a backend `filter`
expression (`cin_id = '<nodeId>'`).

**Request:**

```json
{
  "question": "Why the girl fell in the hole?",
  "sessionId": "demo-session-1",
  "resetSession": false,
  "sourceType": "alfresco",
  "filter": "cin_id = 'e0f2943f-5e11-4f78-b294-3f5e116f7823'"
}
```

**Response:**

```json
{
  "answer": "She fell because the rabbit-hole dipped suddenly downward...",
  "question": "Why the girl fell in the hole?",
  "sessionId": "demo-session-1",
  "retrievalQuery": "why the girl fell in the hole",
  "historyTurnsUsed": 2,
  "model": "model.gguf",
  "tokenCount": 672,
  "searchTimeMs": 454,
  "generationTimeMs": 7084,
  "totalTimeMs": 7539,
  "sourcesUsed": 5,
  "sources": [
    {
      "documentId": "c225f4d5-882b-4b99-81d1-3226af2560a4",
      "nodeId": "4d2a93aa-6a11-431f-9202-58f16062ef5b",
      "sourceId": "nuxeo:nuxeo-demo",
      "sourceType": "nuxeo",
      "name": "down-the-rabbit-hole.pdf",
      "path": "/default-domain/workspaces/literature",
      "chunkText": "found herself falling down a very deep well...",
      "score": 0.6628,
      "openInSourceUrl": "http://localhost:8081/nuxeo/ui/#!/browse/default-domain/workspaces/literature/down-the-rabbit-hole.pdf"
    }
  ]
}
```

The UI groups sources by `nodeId`, showing one entry per document with all source chunks.

### `POST /api/rag/chat/stream`

Streaming RAG endpoint consumed by the chat panel for progressive rendering.

Expected SSE events:

- `event: token` with incremental token payload (`token`, `delta`, `text`, or `content`)
- `event: metadata` with final response payload (`RagPromptResponse`)
- `event: done` to close the stream
- `event: error` for terminal stream errors

### Other endpoints this extension calls

Each is optional: a failure disables the feature it feeds rather than breaking search or chat.

| Endpoint | Used for |
|---|---|
| `POST /api/rag/search/facets` | The facet chips. Body `{property, topN, filter?, sourceType?}`; response `{property, buckets[{value, count}]}` |
| `GET /api/rag/named-queries` | The saved-query selector. Response is a list of names; an empty list hides the selector |
| `GET /api/rag/sessions/{sessionId}/summary` | The conversation-memory panel. 404 means there is no summary yet. Use the backend-assigned session id, not the client-side one |
| `GET /api/status` | The status view, and the set of options in the source filters. Response `{hxprStatus, totalDocuments, sourceCounts, embeddingModel}`, where `sourceCounts` is keyed `<sourceType>:<sourceId>` |
| `GET /api/connectors` | The status view's connector panel, when `connectorsUrl` is set. Response `{connectors[{sourceType, displayName, origin, implementation, settings}], problems[]}`. Published by an ingester, not by `rag-service` |
| `POST /api/content-lake/nodes/status` | The scope badges and the Content Lake sidebar. Body `{nodeIds[], includeFolderAggregate?}` |

## Development

`ext-rag/` is a source bundle, not a standalone Angular workspace: there is no `package.json`, no
`angular.json` and no test target here, so nothing can be built or tested in place. Work against an ACA
checkout.

**Sync changed files individually.** The test harness exists only in the ACA clone, not in this bundle:
`projects/ext-rag/project.json`, `test.ts`, `tsconfig.spec.json` and `karma.conf.js` have no counterpart
here. Copying the directory over the top (`cp -r`, `rsync --delete`) deletes them, and the ACA clone is not
a git repository, so there is nothing to restore them from.

```bash
# From your alfresco-content-app clone, per changed file:
cp /path/to/alfresco-content-lake-ui/ext-rag/src/lib/components/rag-chat/rag-chat.component.ts \
   projects/ext-rag/src/lib/components/rag-chat/rag-chat.component.ts
```

Then, from the ACA workspace:

```bash
npm start                                                   # serve ACA with ext-rag loaded
CHROME_BIN=<chrome> npx nx test ext-rag --watch=false       # the extension's unit tests
npx nx build content-ce --configuration=production --skip-nx-cache
```

Two things to know about those last two commands. There is no `build` target for `ext-rag` (its
`project.json` declares `test` only), so the extension is type-checked and AOT-compiled by building the
application that consumes it, not on its own. And `--skip-nx-cache` is not optional: `projects/ext-rag` is
not a declared dependency of the app project, so Nx does not consider an ext-rag edit a cache miss and will
replay the previous artefact, timestamp and all.

A plain ACA clone also fails that production build on `main exceeded maximum budget ... 5.00 MB`. Raise the
budget in `app/project.json` to `6mb` for the run, as `docker/Dockerfile` does, and put it back afterwards.
