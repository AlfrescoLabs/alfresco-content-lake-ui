# ext-rag -- ADF Extension for RAG

ADF extension module that adds **semantic search** and **RAG question-answering** to Alfresco Content Application (ACA) and Alfresco Digital Workspace (ADW).

This module is part of [alfresco-content-lake-ui](https://github.com/AlfrescoLabs/alfresco-content-lake-ui) and implements [content-lake-app#7](https://github.com/AlfrescoLabs/content-lake-app/issues/7).

## Installation

Copy this folder into your ACA clone:

```bash
cp -r ext-rag /path/to/alfresco-content-app/projects/ext-rag
```

Then register the extension in `app/src/app/extensions.module.ts`:

```typescript
import { provideRagExtension } from 'projects/ext-rag/src/public-api';

export function provideApplicationExtensions(): (Provider | EnvironmentProviders)[] {
  return [
    ...provideRagExtension(),
  ];
}
```

See the [parent README](../README.md) for full integration steps including asset configuration and dev proxy setup.

## Structure

```
ext-rag/
├── tsconfig.lib.json
├── tsconfig.lib.prod.json
├── README.md
└── src/
    ├── assets/
    │   └── ext-rag.plugin.json       # Extension descriptor (routes, menus, sidebar)
    ├── lib/
    │   ├── components/
    │   │   ├── rag-chat/                  # Chat-style Q&A component, plus its delete-session dialog
    │   │   ├── rag-page/                  # Full-page wrapper (tabs: Ask + Search)
    │   │   ├── rag-search/                # Semantic search + facets component
    │   │   ├── rag-sidebar/               # Sidebar wrapper (compact chat)
    │   │   ├── rag-status/                # Operational status dashboard (/rag-status)
    │   │   ├── content-lake-sidebar/      # Content Lake scope sidebar
    │   │   └── content-lake-status-badge/ # Per-node ingestion status badge
    │   ├── models/
    │   │   └── rag.models.ts              # TypeScript interfaces (API + view models)
    │   ├── services/
    │   │   ├── rag-api.service.ts         # HTTP client for rag-service (search/prompt/facets/status)
    │   │   ├── rag-auth.interceptor.ts    # Attaches the Alfresco ticket to /api/rag, /api/content-lake, /api/status
    │   │   ├── rag-chat-session.service.ts        # Chat session state
    │   │   ├── content-source-catalog.service.ts  # The set of indexed sources, from /api/status
    │   │   ├── content-lake-scope.service.ts      # Active Content Lake scope
    │   │   └── content-lake-status-batch.service.ts # Batched node status lookups
    │   ├── utils/
    │   │   ├── content-lake-scope.utils.ts
    │   │   ├── hxql.util.ts               # HXQL metadata filters, escaping included
    │   │   ├── source-label.util.ts       # Display name and icon per source type
    │   │   ├── node-path.util.ts
    │   │   └── ecm-ticket.util.ts
    │   └── store/
    │       ├── rag.actions.ts             # NgRx action types
    │       └── rag.effects.ts             # NgRx effects (navigation)
    ├── ext-rag.module.ts             # provideRagExtension(), plus the deprecated ExtRagModule
    └── public-api.ts                # Barrel exports
```

Each directory also holds the matching `*.spec.ts` files, omitted above. They only run from the ACA
workspace, which is where the Karma harness lives; see the Development section of the repository README.

## License

Apache License 2.0
