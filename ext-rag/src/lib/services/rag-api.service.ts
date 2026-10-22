import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '@alfresco/adf-core';
import { Observable } from 'rxjs';

import {
  ContentSourceType,
  SemanticSearchRequest,
  SemanticSearchResponse,
  RagPromptRequest,
  RagPromptOptions,
  RagPromptResponse,
  RagPromptStreamEvent,
  FacetsRequest,
  FacetsResponse,
  StatusResponse,
  SessionSummaryResponse,
  ConnectorListing,
  StructuredAnswer
} from '../models/rag.models';
import { findEcmTicket } from '../utils/ecm-ticket.util';
import { sourceIdClause } from '../utils/hxql.util';

/** Everything about a search beyond the query and the two long-standing numeric knobs. */
export interface SearchOptions {
  sourceType?: ContentSourceType;
  filter?: string;
  namedQuery?: string;
  /** #18: distinct documents to return chunks from. Ignores `topK` when set. */
  topDocuments?: number;
  /** #18: most chunks to take from any one document. */
  chunksPerDocument?: number;
}

/**
 * Client for the alfresco-content-lake rag-service REST API.
 *
 * All paths are read from `app.config.json`:
 *
 *   "plugins": {
 *     "ragService": {
 *       "baseUrl":    "/api/rag",
 *       "searchPath": "/search/semantic",
 *       "promptPath": "/prompt"
 *     }
 *   }
 *
 * Authentication is handled by `RagAuthInterceptor`, which attaches
 * the Alfresco ticket to every `/api/rag` request automatically.
 */
@Injectable({ providedIn: 'root' })
export class RagApiService {

  private baseUrl: string;
  private searchPath: string;
  private promptPath: string;
  private streamPath: string;
  private facetsPath: string;
  private statusUrl: string;
  private namedQueriesPath: string;
  /** Absolute URL of an ingester's connector listing (#17). Empty switches the panel off. */
  private connectorsUrl: string;
  /** Properties offered in the faceted-search panel (#5). */
  readonly facetProperties: string[];

  constructor(
    private http: HttpClient,
    private appConfig: AppConfigService
  ) {
    this.baseUrl    = this.appConfig.get<string>('plugins.ragService.baseUrl',    '/api/rag');
    this.searchPath = this.appConfig.get<string>('plugins.ragService.searchPath', '/search/semantic');
    this.promptPath = this.appConfig.get<string>('plugins.ragService.promptPath', '/prompt');
    this.streamPath = this.appConfig.get<string>('plugins.ragService.streamPath', '/chat/stream');
    this.facetsPath = this.appConfig.get<string>('plugins.ragService.facetsPath', '/search/facets');
    // /api/status is a sibling of /api/rag, not under it.
    this.statusUrl  = this.appConfig.get<string>('plugins.ragService.statusUrl',  '/api/status');
    this.namedQueriesPath = this.appConfig.get<string>('plugins.ragService.namedQueriesPath', '/named-queries');
    // Not derived from baseUrl: /api/connectors is published by an ingester, not by rag-service, and
    // the deployment proxy does not forward it (#17). Empty by default, which hides the panel.
    this.connectorsUrl = this.appConfig.get<string>('plugins.ragService.connectorsUrl', '');
    this.facetProperties = this.appConfig.get<string[]>('plugins.ragService.facetProperties',
      ['cin_sourceId', 'cin_ingestProperties.source_mimeType']);
  }

  /**
   * Semantic search across indexed content-lake chunks.
   */
  search(query: string, topK = 5, minScore = 0.5, options: SearchOptions = {}):
      Observable<SemanticSearchResponse> {
    const body: SemanticSearchRequest = {
      query,
      topK,
      minScore,
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.namedQuery ? { namedQuery: options.namedQuery } : {}),
      // #18: omitted unless the caller asked, so an untouched search sends what it always sent.
      ...(options.topDocuments ? { topDocuments: options.topDocuments } : {}),
      ...(options.chunksPerDocument ? { chunksPerDocument: options.chunksPerDocument } : {})
    };
    return this.http.post<SemanticSearchResponse>(
      `${this.baseUrl}${this.searchPath}`,
      body
    );
  }

  /**
   * Lists the hxpr named-query names registered server-side (#6), for use as saved-search filters.
   * Apply one by passing `namedQuery` to {@link search}.
   */
  getNamedQueries(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}${this.namedQueriesPath}`);
  }

  /**
   * Returns the persistent running conversation summary for a session (#10), or a 404 when the
   * summary feature is disabled server-side. Use the backend-assigned session id.
   */
  getSessionSummary(sessionId: string): Observable<SessionSummaryResponse> {
    return this.http.get<SessionSummaryResponse>(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/summary`
    );
  }

  /**
   * Faceted search (#5): returns the top values of an indexed property with
   * document counts, scoped to the caller's permissions.
   */
  facets(request: FacetsRequest): Observable<FacetsResponse> {
    return this.http.post<FacetsResponse>(
      `${this.baseUrl}${this.facetsPath}`,
      request
    );
  }

  /**
   * Operational status snapshot (#12): hxpr connectivity, per-source document
   * counts, and embedding-model reachability. Served at /api/status (a sibling
   * of /api/rag), so it uses its own configured URL.
   */
  getStatus(): Observable<StatusResponse> {
    return this.http.get<StatusResponse>(this.statusUrl);
  }

  /**
   * The connectors an ingester has loaded (#17), or null when no URL is configured.
   *
   * `RagServiceApplication` excludes `ConnectorSchemaController` from its component scan, so this is not
   * a rag-service route and there is no same-origin path to fall back on: `connector-batch-ingester`
   * publishes a port of its own. Returning null rather than guessing is what keeps the panel absent in
   * a deployment that has not opted in.
   */
  getConnectors(): Observable<ConnectorListing> | null {
    const url = (this.connectorsUrl ?? '').trim();
    if (!url) {
      return null;
    }
    return this.http.get<ConnectorListing>(url);
  }

  /** Whether a connector listing is reachable, i.e. whether the panel should render at all. */
  get connectorsConfigured(): boolean {
    return !!(this.connectorsUrl ?? '').trim();
  }

  /**
   * RAG question-answering.
   *
   * Backward compatibility:
   * - `prompt(question, nodeId)` is still accepted.
   * - `nodeId` is translated to an HXQL filter (`cin_id = '<nodeId>'`)
   *   because the backend request now scopes via `filter`. With `nodeSourceId`
   *   the filter also pins `cin_sourceId`.
   */
  prompt(question: string, nodeId?: string): Observable<RagPromptResponse>;
  prompt(question: string, options?: RagPromptOptions): Observable<RagPromptResponse>;
  prompt(question: string, nodeIdOrOptions?: string | RagPromptOptions): Observable<RagPromptResponse> {
    const body = this.buildPromptBody(question, nodeIdOrOptions);
    return this.http.post<RagPromptResponse>(
      `${this.baseUrl}${this.promptPath}`,
      body
    );
  }

  /**
   * Streams prompt output as SSE-like events over fetch/readable stream.
   *
   * Retries once on transient network/server failures.
   */
  streamPrompt(question: string, nodeId?: string): Observable<RagPromptStreamEvent>;
  streamPrompt(question: string, options?: RagPromptOptions): Observable<RagPromptStreamEvent>;
  streamPrompt(question: string, nodeIdOrOptions?: string | RagPromptOptions): Observable<RagPromptStreamEvent> {
    const body = this.buildPromptBody(question, nodeIdOrOptions);
    const url = `${this.baseUrl}${this.streamPath}`;

    return new Observable<RagPromptStreamEvent>((observer) => {
      const controller = new AbortController();
      let cancelled = false;

      const run = async (attempt: number): Promise<void> => {
        let gotDoneEvent = false;

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: this.streamHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store'
          });

          if (!response.ok || !response.body) {
            throw new StreamHttpError(response.status, response.statusText || 'HTTP error');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const consumed = this.consumeSseBuffer(buffer, (eventType, data) => {
              if (eventType === 'done') {
                gotDoneEvent = true;
              }
              this.forwardSseEvent(observer, eventType, data);
            });
            buffer = consumed;
          }

          if (!cancelled) {
            buffer += decoder.decode();
            this.consumeSseBuffer(buffer, (eventType, data) => {
              if (eventType === 'done') {
                gotDoneEvent = true;
              }
              this.forwardSseEvent(observer, eventType, data);
            }, true);

            if (!gotDoneEvent) {
              observer.next({ type: 'done' });
            }
            observer.complete();
          }
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (attempt === 0 && this.isTransientError(error)) {
            await this.delay(250);
            await run(1);
            return;
          }
          observer.error(this.normalizeError(error));
        }
      };

      void run(0);

      return () => {
        cancelled = true;
        controller.abort();
      };
    });
  }

  private buildPromptBody(question: string, nodeIdOrOptions?: string | RagPromptOptions): RagPromptRequest {
    const options: RagPromptOptions = typeof nodeIdOrOptions === 'string'
      ? { nodeId: nodeIdOrOptions }
      : (nodeIdOrOptions ?? {});

    const scopeFilter = this.nodeScopeFilter(options.nodeId, options.nodeSourceId);
    const filter = this.combineFilters(options.filter, scopeFilter);

    return {
      question,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.resetSession !== undefined ? { resetSession: options.resetSession } : {}),
      ...(options.topK !== undefined ? { topK: options.topK } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
      ...(filter ? { filter } : {}),
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.embeddingType ? { embeddingType: options.embeddingType } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.includeContext !== undefined ? { includeContext: options.includeContext } : {}),
      ...(options.inferFilters !== undefined ? { inferFilters: options.inferFilters } : {}),
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {})
    };
  }

  /**
   * The filter for one node. A node id is unique only within its repository, and two Alfresco
   * repositories can hold the same id (one restored from the other's backup), so the source id is
   * ANDed in when the caller knows it.
   */
  private nodeScopeFilter(nodeId?: string, nodeSourceId?: string): string | undefined {
    const normalizedNodeId = nodeId?.trim();
    if (!normalizedNodeId) {
      return undefined;
    }
    const nodeClause = `cin_id = '${this.escapeHxql(normalizedNodeId)}'`;
    const normalizedSourceId = nodeSourceId?.trim();
    return normalizedSourceId
      ? this.combineFilters(sourceIdClause(normalizedSourceId), nodeClause)
      : nodeClause;
  }

  private combineFilters(filterA?: string, filterB?: string): string | undefined {
    const a = filterA?.trim();
    const b = filterB?.trim();

    if (a && b) {
      return `(${a}) AND (${b})`;
    }
    return a || b || undefined;
  }

  private escapeHxql(value: string): string {
    return value.replace(/'/g, "''");
  }

  private streamHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json'
    };

    const ticket = findEcmTicket();
    if (ticket) {
      headers.Authorization = `Basic ${btoa(ticket + ':')}`;
    }
    return headers;
  }

  private consumeSseBuffer(
    buffer: string,
    onEvent: (eventType: string, data: string) => void,
    flushRemainder = false
  ): string {
    let rest = buffer;
    let separatorIndex = this.findSseEventBoundary(rest);

    while (separatorIndex >= 0) {
      const rawEvent = rest.slice(0, separatorIndex).trim();
      if (rawEvent) {
        this.parseSseEvent(rawEvent, onEvent);
      }
      rest = rest.slice(separatorIndex + this.eventBoundaryLength(rest, separatorIndex));
      separatorIndex = this.findSseEventBoundary(rest);
    }

    if (flushRemainder) {
      const tail = rest.trim();
      if (tail) {
        this.parseSseEvent(tail, onEvent);
      }
      return '';
    }

    return rest;
  }

  private findSseEventBoundary(buffer: string): number {
    const lfBoundary = buffer.indexOf('\n\n');
    const crlfBoundary = buffer.indexOf('\r\n\r\n');
    if (lfBoundary < 0) {
      return crlfBoundary;
    }
    if (crlfBoundary < 0) {
      return lfBoundary;
    }
    return Math.min(lfBoundary, crlfBoundary);
  }

  private eventBoundaryLength(buffer: string, boundaryIndex: number): number {
    return buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
  }

  private parseSseEvent(rawEvent: string, onEvent: (eventType: string, data: string) => void): void {
    const normalized = rawEvent.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    onEvent(eventType, dataLines.join('\n'));
  }

  private forwardSseEvent(observer: { next: (value: RagPromptStreamEvent) => void; error: (e: any) => void }, eventType: string, data: string): void {
    const loweredType = eventType.toLowerCase();
    const payload = this.tryParseJson(data);

    if (loweredType === 'error') {
      const message = this.extractErrorMessage(payload, data);
      observer.error(new Error(message));
      return;
    }

    if (loweredType === 'done' || loweredType === 'complete') {
      observer.next({ type: 'done' });
      return;
    }

    if (loweredType === 'structured') {
      const structured = this.normalizeStructuredAnswer(payload);
      if (structured) {
        observer.next({ type: 'structured', structured });
      }
      return;
    }

    if (this.looksLikeMetadataEvent(loweredType, payload)) {
      const response = this.normalizePromptResponse(payload, data);
      if (response) {
        observer.next({ type: 'metadata', response });
      } else {
        observer.next({ type: 'done' });
      }
      return;
    }

    const token = this.extractToken(payload, data);
    if (token) {
      observer.next({ type: 'token', token });
      return;
    }

    // Last fallback: treat plain `data:` lines as token fragments.
    if (data) {
      observer.next({ type: 'token', token: data });
    }
  }

  /**
   * The typed view arrives in its own event after `metadata`, because the server derives it in a
   * second LLM pass over the finished answer and does not make the source list wait for it.
   */
  private normalizeStructuredAnswer(payload: unknown): StructuredAnswer | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const candidate = payload as any;
    return {
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      keyPoints: Array.isArray(candidate.keyPoints) ? candidate.keyPoints : [],
      citations: Array.isArray(candidate.citations) ? candidate.citations : []
    };
  }

  private looksLikeMetadataEvent(eventType: string, payload: unknown): boolean {
    if (eventType === 'metadata' || eventType === 'final' || eventType === 'result') {
      return true;
    }
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const candidate = (payload as any).response ?? payload;
    return typeof candidate?.answer === 'string' || Array.isArray(candidate?.sources);
  }

  private normalizePromptResponse(payload: unknown, fallbackAnswer: string): RagPromptResponse | null {
    const candidate = (payload && typeof payload === 'object' && (payload as any).response)
      ? (payload as any).response
      : payload;

    if (!candidate || typeof candidate !== 'object') {
      if (!fallbackAnswer) {
        return null;
      }
      return {
        answer: fallbackAnswer,
        question: '',
        model: 'unknown',
        searchTimeMs: 0,
        generationTimeMs: 0,
        totalTimeMs: 0,
        sourcesUsed: 0,
        sources: []
      };
    }

    const c = candidate as any;
    const answer = typeof c.answer === 'string' ? c.answer : (fallbackAnswer || '');

    return {
      answer,
      question: typeof c.question === 'string' ? c.question : '',
      sessionId: typeof c.sessionId === 'string' ? c.sessionId : undefined,
      retrievalQuery: typeof c.retrievalQuery === 'string' ? c.retrievalQuery : undefined,
      historyTurnsUsed: typeof c.historyTurnsUsed === 'number' ? c.historyTurnsUsed : undefined,
      model: typeof c.model === 'string' ? c.model : 'unknown',
      tokenCount: typeof c.tokenCount === 'number' ? c.tokenCount : undefined,
      searchTimeMs: typeof c.searchTimeMs === 'number' ? c.searchTimeMs : 0,
      generationTimeMs: typeof c.generationTimeMs === 'number' ? c.generationTimeMs : 0,
      totalTimeMs: typeof c.totalTimeMs === 'number' ? c.totalTimeMs : 0,
      sourcesUsed: typeof c.sourcesUsed === 'number' ? c.sourcesUsed : (Array.isArray(c.sources) ? c.sources.length : 0),
      sources: Array.isArray(c.sources) ? c.sources : [],
      context: Array.isArray(c.context) ? c.context : undefined,
      verified: typeof c.verified === 'boolean' ? c.verified : undefined,
      unsupportedClaims: Array.isArray(c.unsupportedClaims) ? c.unsupportedClaims : undefined,
      structured: (c.structured && typeof c.structured === 'object') ? c.structured : undefined,
      currentSummary: typeof c.currentSummary === 'string' ? c.currentSummary : undefined
    };
  }

  private extractToken(payload: unknown, fallback: string): string {
    if (payload && typeof payload === 'object') {
      const p = payload as any;
      const token = p.token ?? p.delta ?? p.text ?? p.content;
      if (typeof token === 'string') {
        return token;
      }
    }
    return fallback;
  }

  private extractErrorMessage(payload: unknown, fallback: string): string {
    if (payload && typeof payload === 'object') {
      const p = payload as any;
      if (typeof p.message === 'string' && p.message.trim()) {
        return p.message.trim();
      }
      if (typeof p.error === 'string' && p.error.trim()) {
        return p.error.trim();
      }
    }
    return fallback || 'Stream failed';
  }

  private tryParseJson(value: string): unknown {
    if (!value) {
      return null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof StreamHttpError) {
      return error.status >= 500 && error.status < 600;
    }
    if (error instanceof DOMException) {
      return error.name !== 'AbortError';
    }
    if (error instanceof TypeError) {
      return true;
    }
    return false;
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error('Stream failed');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class StreamHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`Stream request failed (${status}): ${message}`);
  }
}
