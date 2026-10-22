/**
 * Interfaces for rag-service REST API communication.
 *
 * These models match the endpoints defined in the alfresco-content-lake
 * rag-service module (see issue #6).
 */

/* ------------------------------------------------------------------ */
/*  Semantic Search  –  API response                                  */
/* ------------------------------------------------------------------ */

/**
 * A source type as reported by rag-service.
 *
 * Deliberately open (#16): the index holds whatever has been ingested into it, which today can be a
 * filesystem tree, a CMIS repository or any plugin connector, and results from those already reach this
 * extension. `alfresco` and `nuxeo` are the two with dedicated labels; nothing else about them is
 * special here.
 */
export type ContentSourceType = string;

export interface SemanticSearchRequest {
  query: string;
  topK?: number;
  minScore?: number;
  sourceType?: ContentSourceType;
  /** Optional HXQL filter appended to the permission scope (used by faceted search). */
  filter?: string;
  /** Optional hxpr named-query name applied as a server-side saved-search filter (#6). */
  namedQuery?: string;
  /** Distinct documents to return chunks from; owns the budget and ignores topK when set (#18). */
  topDocuments?: number;
  /** Most chunks to take from any one document (#18). */
  chunksPerDocument?: number;
}

/* ------------------------------------------------------------------ */
/*  Faceted search (#5)  -  POST /api/rag/search/facets               */
/* ------------------------------------------------------------------ */

export interface FacetsRequest {
  /** Property to aggregate on, e.g. `cin_ingestProperties.mimeType`. */
  property: string;
  filter?: string;
  sourceType?: ContentSourceType;
  searchTerm?: string;
  topN?: number;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface FacetsResponse {
  property: string;
  buckets: FacetBucket[];
}

export interface SearchResultSourceDocument {
  documentId: string;
  nodeId: string;
  sourceId?: string;
  sourceType?: ContentSourceType;
  name: string;
  path: string;
  mimeType: string;
  openInSourceUrl?: string;
}

export interface SearchResultChunkMetadata {
  embeddingId: string;
  embeddingType: string;
  page: number;
  paragraph: number;
  chunkLength: number;
  /** Chunk classification `PROSE` / `TABLE` (#9); absent when the document has no section map. */
  chunkType?: string;
}

/** A single chunk hit returned by /search/semantic */
export interface SearchResultItem {
  rank: number;
  score: number;
  chunkText: string;
  sourceDocument: SearchResultSourceDocument;
  chunkMetadata: SearchResultChunkMetadata;
}

export interface SemanticSearchResponse {
  query: string;
  model: string;
  vectorDimension: number;
  resultCount: number;
  totalCount: number;
  /** Distinct documents behind `results` (#18). Populated on every response. */
  documentCount?: number;
  appliedTopDocuments?: number;
  appliedChunksPerDocument?: number;
  searchTimeMs: number;
  results: SearchResultItem[];
}

/* ------------------------------------------------------------------ */
/*  RAG Prompt (Q&A)  –  API response                                 */
/* ------------------------------------------------------------------ */

/** Requested answer shape (#11). `STRUCTURED` additionally returns a typed `structured` object. */
export type RagResponseFormat = 'TEXT' | 'STRUCTURED';

export interface RagPromptRequest {
  question: string;
  sessionId?: string;
  resetSession?: boolean;
  topK?: number;
  minScore?: number;
  filter?: string;
  sourceType?: ContentSourceType;
  embeddingType?: string;
  systemPrompt?: string;
  includeContext?: boolean;
  /** #8: let the server infer structured filters from the question before retrieval. */
  inferFilters?: boolean;
  /** #11: request a typed structured answer alongside the free text. */
  responseFormat?: RagResponseFormat;
}

/**
 * UI helper options for prompt calls.
 *
 * `nodeId` is translated client-side into a backend `filter`
 * expression (`cin_id = '<nodeId>'`) for compatibility.
 */
export interface RagPromptOptions {
  nodeId?: string;
  /**
   * The `cin_sourceId` of the repository `nodeId` belongs to (`alfresco:<repositoryId>`). ANDed with the
   * `cin_id` clause, because node ids are only unique within one repository.
   */
  nodeSourceId?: string;
  sessionId?: string;
  resetSession?: boolean;
  topK?: number;
  minScore?: number;
  filter?: string;
  sourceType?: ContentSourceType;
  embeddingType?: string;
  systemPrompt?: string;
  includeContext?: boolean;
  inferFilters?: boolean;
  responseFormat?: RagResponseFormat;
}

/** A single source chunk returned by /prompt */
export interface PromptSource {
  documentId: string;
  nodeId: string;
  sourceId?: string;
  sourceType?: ContentSourceType;
  name: string;
  path: string;
  chunkText: string;
  score: number;
  openInSourceUrl?: string;
  /** Chunk classification `PROSE` / `TABLE` (#9); absent when the document has no section map. */
  chunkType?: string;
}

/** Citation inside a structured answer (#11). */
export interface Citation {
  sourceName: string;
  quote: string;
}

/** Typed answer shape (#11), present only when responseFormat=STRUCTURED was requested. */
export interface StructuredAnswer {
  summary: string;
  keyPoints: string[];
  citations: Citation[];
}

export interface RagPromptResponse {
  answer: string;
  question: string;
  sessionId?: string;
  /**
   * Correlation key for this answer. Typed so it survives the stream normaliser; it is what
   * `POST /api/rag/feedback` needs to attach a rating to a specific answer.
   */
  requestId?: string;
  retrievalQuery?: string;
  historyTurnsUsed?: number;
  model: string;
  tokenCount?: number;
  searchTimeMs: number;
  generationTimeMs: number;
  totalTimeMs: number;
  sourcesUsed: number;
  sources: PromptSource[];
  context?: PromptContextChunk[];
  /** #7: present only when citation verification is enabled server-side. */
  verified?: boolean;
  unsupportedClaims?: string[];
  /** #11: present only when responseFormat=STRUCTURED was requested. */
  structured?: StructuredAnswer;
  /** #10: persistent running conversation summary; present only when the feature is enabled. */
  currentSummary?: string;
}

export interface PromptContextChunk {
  rank: number;
  score: number;
  text: string;
  sourceName?: string;
  sourcePath?: string;
  sourceType?: ContentSourceType;
  openInSourceUrl?: string;
  /** Chunk classification `PROSE` / `TABLE` (#9). */
  chunkType?: string;
}

/** #10: GET /api/rag/sessions/{sessionId}/summary */
export interface SessionSummaryResponse {
  sessionId: string;
  summary: string;
}

export type RagPromptStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'metadata'; response: RagPromptResponse }
  /** Follows `metadata`: the server derives the typed view in a second pass over the finished answer. */
  | { type: 'structured'; structured: StructuredAnswer }
  | { type: 'done' };

/* ------------------------------------------------------------------ */
/*  Merged view models  –  chunks grouped by document for the UI      */
/* ------------------------------------------------------------------ */

export interface ChunkSnippet {
  text: string;
  score: number;
  /** Chunk classification `PROSE` / `TABLE` (#9); drives distinct table rendering. */
  chunkType?: string;
}

export interface MergedDocument {
  nodeId: string;
  sourceId?: string;
  sourceType?: ContentSourceType;
  name: string;
  path: string;
  score: number;
  chunks: ChunkSnippet[];
  openInSourceUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  Content Lake node status  –  batch-ingester API                   */
/* ------------------------------------------------------------------ */

export type ContentLakeSyncStatus = 'PENDING' | 'INDEXED' | 'FAILED' | 'SKIPPED';

export interface ContentLakeFolderStatusSummary {
  totalDocuments: number;
  indexedDocuments: number;
  pendingDocuments: number;
  failedDocuments: number;
  skippedDocuments: number;
}

export interface ContentLakeNodeStatus {
  nodeId: string;
  status: ContentLakeSyncStatus | null;
  exists: boolean;
  folder: boolean;
  inScope: boolean;
  excluded: boolean;
  error: string | null;
  folderSummary?: ContentLakeFolderStatusSummary | null;
}

/* ------------------------------------------------------------------ */
/*  Chat UI state (local, not persisted)                              */
/* ------------------------------------------------------------------ */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: Date;
  // Only present for assistant messages
  model?: string;
  tokenCount?: number;
  totalMs?: number;
  searchTimeMs?: number;
  generationTimeMs?: number;
  sources?: MergedDocument[];
  loading?: boolean;
  error?: string;
  // #7 citation faithfulness / #11 structured output (only on assistant messages)
  verified?: boolean;
  unsupportedClaims?: string[];
  structured?: StructuredAnswer;
  /** True between the metadata event and the structured event that follows it. */
  structuredPending?: boolean;
  /**
   * Plain-text mirror of a partially streamed answer.
   *
   * `content` is markdown and is rendered as markdown, but a half-arrived answer is not valid markdown:
   * an unclosed fence or a table with one row so far renders as a mess that then reflows. So the stream
   * is shown stripped and the markdown is rendered once the answer is complete. Only set while
   * `loading` is true.
   */
  streamPreview?: string;
}

/* ------------------------------------------------------------------ */
/*  Operational status (#12)  -  GET /api/status                      */
/* ------------------------------------------------------------------ */

export interface ModelRunnerStatus {
  status: string;
  url?: string;
}

export interface StatusResponse {
  hxprStatus: string;
  totalDocuments: number;
  sourceCounts: Record<string, number>;
  embeddingModel: ModelRunnerStatus;
}

/* ------------------------------------------------------------------ */
/*  Loaded connectors (#17)  -  GET /api/connectors on an ingester    */
/* ------------------------------------------------------------------ */

/**
 * One connector an ingester has loaded.
 *
 * `origin` is `in-tree` for a connector compiled into the build, or the jar it was loaded from.
 */
export interface ConnectorInfo {
  sourceType: string;
  displayName: string;
  origin: string;
  implementation: string;
  settings: number;
}

/** `problems` is empty when every jar in the plugin directory loaded. */
export interface ConnectorListing {
  connectors: ConnectorInfo[];
  problems: string[];
}
