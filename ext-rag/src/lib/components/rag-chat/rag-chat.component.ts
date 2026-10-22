import {
  Component,
  Input,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  OnInit,
  DestroyRef,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { DiscoveryApiService } from '@alfresco/adf-content-services';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MARKED_OPTIONS, MarkdownModule, provideMarkdown } from 'ngx-markdown';
import { Subscription, of } from 'rxjs';
import { take, catchError } from 'rxjs/operators';

import { RagApiService } from '../../services/rag-api.service';
import { RagChatSessionService, RagChatSessionSummary } from '../../services/rag-chat-session.service';
import {
  ContentSourceCatalogService,
  ContentSourceOption,
  SourceScope
} from '../../services/content-source-catalog.service';
import { RagDeleteSessionDialogComponent } from './rag-delete-session-dialog.component';
import { ragChatMarkedOptions } from './rag-chat-marked-options';
import { ChatMessage, MergedDocument, PromptSource, RagPromptOptions, RagPromptResponse } from '../../models/rag.models';
import { openInSourceLabel, resolveSourceType, sourceTypeLabel } from '../../utils/source-label.util';
import { combineFilters, escapeHxqlLiteral, sourceIdClause } from '../../utils/hxql.util';

/** Drops the undefined halves of a scope so the request body carries only what was decided. */
function scopeOptions(scope: SourceScope): Pick<RagPromptOptions, 'filter' | 'sourceType'> {
  return {
    ...(scope.sourceType ? { sourceType: scope.sourceType } : {}),
    ...(scope.filter ? { filter: scope.filter } : {})
  };
}

let _nextId = 0;

@Component({
  selector: 'ext-rag-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MarkdownModule
  ],
  providers: [
    // Provided here rather than relied on from the host application: an extension cannot assume the app
    // it is dropped into has called provideMarkdown(). ACA's own AI results view does the same.
    provideMarkdown({
      markedOptions: {
        provide: MARKED_OPTIONS,
        useValue: ragChatMarkedOptions
      }
    })
  ],
  templateUrl: './rag-chat.component.html',
  styleUrls: ['./rag-chat.component.css']
})
export class RagChatComponent implements AfterViewChecked, OnInit {

  /** When true the layout is narrower (sidebar mode). */
  @Input() compact = false;

  /** Pre-scope all questions to a specific document. */
  @Input() scopedNodeId: string | null = null;
  @Input() scopedNodeName: string | null = null;
  @Input() scopedNodeIsFolder = false;
  @Input() scopedNodePath: string | null = null;

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef;

  messages: ChatMessage[] = [];
  sessionSummaries: RagChatSessionSummary[] = [];
  currentQuestion = '';
  /** The selected source option's key: '' for every source (#16). */
  sourceKey = '';
  sourceOptions: ContentSourceOption[] = [];
  /** #8: ask the server to infer metadata filters from the question. */
  inferFilters = false;
  /** #11: request a typed structured answer alongside the free text. */
  structuredMode = false;
  thinking = false;
  currentRepositoryId: string | null = null;
  repositoryResolved = false;
  activeSessionId: string | null = null;
  /** #10: persistent conversation summary for the active session; null when none/disabled. */
  conversationSummary: string | null = null;

  private shouldScroll = false;
  private autoScrollEnabled = true;
  private streamRawContent = new Map<string, string>();

  /** In-flight request state, used by the Stop control and throttled persistence. */
  private requestSubscription?: Subscription;
  private inflightMessage?: ChatMessage;
  private lastTokenPersistMs = 0;
  private static readonly TOKEN_PERSIST_INTERVAL_MS = 400;
  private readonly destroyRef = inject(DestroyRef);

  constructor(
    private ragApi: RagApiService,
    private discoveryApi: DiscoveryApiService,
    private chatSessions: RagChatSessionService,
    private dialog: MatDialog,
    private sources: ContentSourceCatalogService
  ) {}

  ngOnInit(): void {
    this.initializeConversationState();

    // A conversation belongs to the user who had it. When the store is discarded on logout or a
    // user change, drop the in-flight answer before it can be written into the next user's store.
    this.chatSessions.cleared$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.resetForNewUser());

    // #16: the filter's options come from the index, so a CMIS or connector source is selectable.
    this.sources.options()
      .pipe(take(1))
      .subscribe((options) => {
        this.sourceOptions = options;
      });

    this.discoveryApi.getEcmProductInfo()
      .pipe(take(1))
      .subscribe({
        next: (repository) => {
          this.currentRepositoryId = this.resolveRepositoryId(repository);
          this.repositoryResolved = true;
        },
        error: () => {
          this.repositoryResolved = true;
        }
      });
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  ask(): void {
    const q = this.currentQuestion.trim();
    if (!q || this.thinking) {
      return;
    }
    const sessionId = this.activeSessionId ?? this.chatSessions.ensureActiveSession();
    const isFirstTurn = this.messages.length === 0;
    this.activeSessionId = sessionId;
    const scopeOptions = this.buildScopeOptions();

    // Add user message
    const userMsg: ChatMessage = {
      id: `msg-${_nextId++}`,
      role: 'user',
      content: q,
      timestamp: new Date()
    };
    this.messages.push(userMsg);

    // Add placeholder assistant message
    const assistantMsg: ChatMessage = {
      id: `msg-${_nextId++}`,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      loading: true
    };
    this.messages.push(assistantMsg);

    this.currentQuestion = '';
    this.thinking = true;
    this.shouldScroll = true;
    this.persistMessages();

    this.streamAssistantResponse(q, sessionId, isFirstTurn, assistantMsg, scopeOptions);
  }

  newConversation(): void {
    if (this.thinking) {
      return;
    }
    this.activeSessionId = this.chatSessions.createSession();
    this.messages = [];
    this.currentQuestion = '';
    this.conversationSummary = null;
    this.autoScrollEnabled = true;
    this.refreshSessionSummaries();
    this.shouldScroll = true;
  }

  openConversation(sessionId: string): void {
    if (this.thinking || sessionId === this.activeSessionId) {
      return;
    }
    this.activeSessionId = sessionId;
    this.chatSessions.activateSession(sessionId);
    this.messages = this.chatSessions.getMessages(sessionId);
    this.healInterruptedMessages();
    this.autoScrollEnabled = true;
    this.refreshSessionSummaries();
    this.loadConversationSummary(sessionId);
    this.shouldScroll = true;
  }

  deleteConversation(sessionId: string, event: MouseEvent): void {
    event.stopPropagation();
    if (this.thinking) {
      return;
    }
    this.dialog.open(RagDeleteSessionDialogComponent)
      .afterClosed()
      .pipe(take(1))
      .subscribe((confirmed) => {
        if (!confirmed) {
          return;
        }
        this.chatSessions.deleteSession(sessionId);
        if (this.activeSessionId === sessionId) {
          const next = this.chatSessions.ensureActiveSession();
          this.activeSessionId = next;
          this.messages = this.chatSessions.getMessages(next);
          this.shouldScroll = true;
        }
        this.refreshSessionSummaries();
      });
  }

  onMessagesScroll(): void {
    const el = this.messagesContainer?.nativeElement as HTMLElement | undefined;
    if (!el) {
      return;
    }
    this.autoScrollEnabled = (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 96);
  }

  clearScope(): void {
    this.scopedNodeId = null;
    this.scopedNodeName = null;
    this.scopedNodeIsFolder = false;
    this.scopedNodePath = null;
  }

  scopeLabel(): string {
    return this.scopedNodeName?.trim() || 'All content';
  }

  scopeIcon(): string {
    if (!this.scopedNodeId) {
      return 'travel_explore';
    }
    return this.scopedNodeIsFolder ? 'folder' : 'description';
  }

  trackSession(_index: number, session: RagChatSessionSummary): string {
    return session.sessionId;
  }

  private mergeSources(sources: PromptSource[]): MergedDocument[] {
    const map = new Map<string, MergedDocument>();
    for (const src of sources) {
      const existing = map.get(this.documentKey(src.nodeId, src.sourceId));
      if (existing) {
        existing.chunks.push({ text: src.chunkText, score: src.score, chunkType: src.chunkType });
      } else {
        map.set(this.documentKey(src.nodeId, src.sourceId), {
          nodeId: src.nodeId,
          sourceId: src.sourceId,
          sourceType: resolveSourceType(src),
          name: src.name,
          path: src.path,
          score: src.score,
          chunks: [{ text: src.chunkText, score: src.score, chunkType: src.chunkType }],
          openInSourceUrl: src.openInSourceUrl
        });
      }
    }
    return Array.from(map.values());
  }

  canOpenInRepository(doc: MergedDocument): boolean {
    const currentSourceId = this.currentAlfrescoSourceId();
    return this.repositoryResolved
      && !!doc.nodeId
      && doc.sourceType === 'alfresco'
      && !!currentSourceId
      && doc.sourceId === currentSourceId;
  }

  canOpenInSource(doc: MergedDocument): boolean {
    return !!doc.openInSourceUrl && !this.canOpenInRepository(doc);
  }

  openSourceLabel(doc: MergedDocument): string {
    return `Open in ${openInSourceLabel(doc, this.currentAlfrescoSourceId())}`;
  }

  openLinkHint(doc: MergedDocument): string {
    if (!this.repositoryResolved) {
      return 'Resolving current repository';
    }
    if (this.canOpenInRepository(doc)) {
      return 'Open in Alfresco';
    }
    if (this.canOpenInSource(doc)) {
      return this.openSourceLabel(doc);
    }
    return `No open link available for ${this.sourceSummary(doc)}`;
  }

  sourceSummary(doc: MergedDocument): string {
    if (doc.sourceType && doc.sourceId) {
      return `${this.sourceSystemLabel(doc)} · ${doc.sourceId}`;
    }
    if (doc.sourceType) {
      return this.sourceSystemLabel(doc);
    }
    return doc.sourceId ?? 'Unknown source';
  }

  /**
   * Scoping to an ACA node pins the filter to this repository, whatever the control last held. The
   * repository has its own option only when the index holds more than one Alfresco source; otherwise
   * the Alfresco type option stands for it.
   */
  displaySourceKey(): string {
    if (!this.scopedNodeId) {
      return this.sourceKey;
    }
    const ownSourceId = this.currentAlfrescoSourceId();
    return ownSourceId && this.sources.find(this.sourceOptions, ownSourceId) ? ownSourceId : 'alfresco';
  }

  setSourceKey(value: string | null | undefined): void {
    const key = (value ?? '').trim();
    this.sourceKey = this.sources.find(this.sourceOptions, key) ? key : '';
  }

  private documentKey(nodeId: string, sourceId?: string): string {
    return `${sourceId ?? ''}::${nodeId}`;
  }

  private currentAlfrescoSourceId(): string | null {
    const repositoryId = this.currentRepositoryId?.trim();
    if (!repositoryId) {
      return null;
    }
    return repositoryId.startsWith('alfresco:') ? repositoryId : `alfresco:${repositoryId}`;
  }

  private sourceSystemLabel(doc: MergedDocument): string {
    return sourceTypeLabel(doc.sourceType);
  }

  private resolveRepositoryId(repository: unknown): string | null {
    return (repository as { id?: string } | null)?.id ?? null;
  }

  private scrollToBottom(): void {
    try {
      const el = this.messagesContainer?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    } catch (_) {
      // ignore
    }
  }

  private resetForNewUser(): void {
    this.requestSubscription?.unsubscribe();
    this.requestSubscription = undefined;
    this.inflightMessage = undefined;
    this.streamRawContent.clear();
    this.thinking = false;
    this.activeSessionId = null;
    this.messages = [];
    this.sessionSummaries = [];
    this.currentQuestion = '';
    this.conversationSummary = null;
  }

  private initializeConversationState(): void {
    this.activeSessionId = this.chatSessions.ensureActiveSession();
    this.messages = this.chatSessions.getMessages(this.activeSessionId);
    this.healInterruptedMessages();
    this.refreshSessionSummaries();
    this.loadConversationSummary(this.activeSessionId);
    this.shouldScroll = true;
  }

  /**
   * #10: loads the persistent conversation summary for a session. Only queries the backend for a
   * backend-assigned id (a fresh session still has a client `ui-` id the server has never seen);
   * best-effort - a disabled feature (404) or any error clears the panel.
   */
  private loadConversationSummary(sessionId: string | null): void {
    if (!sessionId || sessionId.startsWith('ui-')) {
      this.conversationSummary = null;
      return;
    }
    this.ragApi.getSessionSummary(sessionId)
      .pipe(take(1), catchError(() => of(null)))
      .subscribe((res) => {
        this.conversationSummary = res && res.summary ? res.summary : null;
      });
  }

  /**
   * Clears the `loading` flag on any assistant message rehydrated from storage:
   * a stream interrupted by a reload or navigation would otherwise leave a
   * permanently spinning "Thinking..." bubble with no request running.
   */
  private healInterruptedMessages(): void {
    let changed = false;
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.loading) {
        msg.loading = false;
        changed = true;
        if (!msg.content?.trim() && !msg.error) {
          msg.error = 'Response interrupted before it completed. Please ask again.';
        }
      }
    }
    if (changed) {
      this.persistMessages();
    }
  }

  private refreshSessionSummaries(): void {
    this.sessionSummaries = this.chatSessions.listSessions();
  }

  private persistMessages(): void {
    if (!this.activeSessionId) {
      return;
    }
    this.chatSessions.saveMessages(this.activeSessionId, this.messages);
    this.refreshSessionSummaries();
  }

  private streamAssistantResponse(
    question: string,
    sessionId: string,
    isFirstTurn: boolean,
    assistantMsg: ChatMessage,
    scopeOptions: Pick<RagPromptOptions, 'nodeId' | 'nodeSourceId' | 'filter' | 'sourceType'>
  ): void {
    this.inflightMessage = assistantMsg;
    this.lastTokenPersistMs = 0;
    this.requestSubscription = this.ragApi.streamPrompt(question, {
      ...scopeOptions,
      ...this.promptFeatureOptions(),
      sessionId,
      resetSession: isFirstTurn
    }).subscribe({
      next: (event) => {
        if (event.type === 'token') {
          const raw = `${this.streamRawContent.get(assistantMsg.id) ?? ''}${event.token}`;
          this.streamRawContent.set(assistantMsg.id, raw);
          // The markdown is what gets kept; the stripped mirror is what gets shown until the answer is
          // whole, since partial markdown renders badly and reflows on every token.
          assistantMsg.content = raw;
          assistantMsg.streamPreview = this.toPlainText(raw);
          this.shouldScroll = this.autoScrollEnabled;
          this.throttlePersistMessages();
          return;
        }

        if (event.type === 'metadata') {
          this.applyPromptResponse(assistantMsg, event.response);
          // The server sends the typed view separately, so the answer and its sources render now
          // and the structured block fills in when its second pass finishes.
          assistantMsg.structuredPending = this.structuredMode && (assistantMsg.sources?.length ?? 0) > 0;
          this.finishAssistantMessage(assistantMsg);
          this.persistMessages();
          return;
        }

        if (event.type === 'structured') {
          assistantMsg.structured = event.structured;
          assistantMsg.structuredPending = false;
          this.shouldScroll = this.autoScrollEnabled;
          this.persistMessages();
          return;
        }

        // `done`: nothing more is coming, so a structured view that never arrived stops pending.
        assistantMsg.structuredPending = false;
        this.finishAssistantMessage(assistantMsg);
        this.persistMessages();
      },
      error: (err) => {
        if (this.isStreamEndpointUnavailable(err)) {
          this.fallbackToPrompt(question, sessionId, isFirstTurn, assistantMsg, scopeOptions);
          return;
        }

        this.streamRawContent.delete(assistantMsg.id);
        assistantMsg.loading = false;
        assistantMsg.structuredPending = false;
        assistantMsg.error = err?.error?.message || err?.message || 'Request failed';
        this.thinking = false;
        this.shouldScroll = this.autoScrollEnabled;
        this.requestSubscription = undefined;
        this.inflightMessage = undefined;
        this.persistMessages();
      }
    });
  }

  private fallbackToPrompt(
    question: string,
    sessionId: string,
    isFirstTurn: boolean,
    assistantMsg: ChatMessage,
    scopeOptions: Pick<RagPromptOptions, 'nodeId' | 'nodeSourceId' | 'filter' | 'sourceType'>
  ): void {
    this.inflightMessage = assistantMsg;
    this.requestSubscription = this.ragApi.prompt(question, {
      ...scopeOptions,
      ...this.promptFeatureOptions(),
      sessionId,
      resetSession: isFirstTurn
    }).subscribe({
      next: (response) => {
        this.applyPromptResponse(assistantMsg, response);
        this.finishAssistantMessage(assistantMsg);
        this.persistMessages();
      },
      error: (err) => {
        this.streamRawContent.delete(assistantMsg.id);
        assistantMsg.loading = false;
        assistantMsg.error = err?.error?.message || err?.message || 'Request failed';
        this.thinking = false;
        this.shouldScroll = this.autoScrollEnabled;
        this.requestSubscription = undefined;
        this.inflightMessage = undefined;
        this.persistMessages();
      }
    });
  }

  private applyPromptResponse(assistantMsg: ChatMessage, response: RagPromptResponse): void {
    if (response.sessionId && response.sessionId !== this.activeSessionId) {
      // Migrate the record to the backend id in place so the conversation does
      // not fork into a second (orphaned) session on the next save.
      if (this.activeSessionId) {
        this.chatSessions.renameSession(this.activeSessionId, response.sessionId);
      }
      this.activeSessionId = response.sessionId;
    }
    if (response.answer) {
      assistantMsg.content = response.answer;
      this.streamRawContent.delete(assistantMsg.id);
    }
    // The answer is complete either way, so the preview has served its purpose and the markdown renders.
    delete assistantMsg.streamPreview;
    assistantMsg.model = response.model;
    assistantMsg.tokenCount = response.tokenCount;
    assistantMsg.totalMs = response.totalTimeMs;
    assistantMsg.searchTimeMs = response.searchTimeMs;
    assistantMsg.generationTimeMs = response.generationTimeMs;
    assistantMsg.sources = this.mergeSources(response.sources ?? []);
    assistantMsg.verified = response.verified;
    assistantMsg.unsupportedClaims = response.unsupportedClaims;
    assistantMsg.structured = response.structured;
    assistantMsg.error = undefined;
    // #10: refresh the conversation-memory panel from the server-maintained summary when present.
    if (typeof response.currentSummary === 'string') {
      this.conversationSummary = response.currentSummary || null;
    }
  }

  /** Per-request feature flags (#8 inferred filters, #11 structured output). */
  private promptFeatureOptions(): Pick<RagPromptOptions, 'inferFilters' | 'responseFormat'> {
    return {
      ...(this.inferFilters ? { inferFilters: true } : {}),
      ...(this.structuredMode ? { responseFormat: 'STRUCTURED' as const } : {})
    };
  }

  private finishAssistantMessage(assistantMsg: ChatMessage): void {
    this.streamRawContent.delete(assistantMsg.id);
    assistantMsg.loading = false;
    this.thinking = false;
    this.shouldScroll = this.autoScrollEnabled;
    this.requestSubscription = undefined;
    this.inflightMessage = undefined;
  }

  /**
   * Cancels an in-flight streaming (or fallback) answer. Aborts the request,
   * keeps whatever partial content has streamed so far, and re-enables input.
   */
  stopStreaming(): void {
    if (!this.thinking) {
      return;
    }
    this.requestSubscription?.unsubscribe();
    this.requestSubscription = undefined;

    const msg = this.inflightMessage;
    if (msg) {
      this.streamRawContent.delete(msg.id);
      msg.loading = false;
      if (!msg.content?.trim() && !msg.error) {
        msg.error = 'Generation stopped.';
      }
    }
    this.inflightMessage = undefined;
    this.thinking = false;
    this.shouldScroll = this.autoScrollEnabled;
    this.persistMessages();
  }

  /**
   * Persists at most once per interval while streaming, so a long answer does
   * not re-serialize the entire session store on every token. Terminal events
   * (metadata / done / error / stop) always persist the final state.
   */
  private throttlePersistMessages(): void {
    const now = Date.now();
    if (now - this.lastTokenPersistMs >= RagChatComponent.TOKEN_PERSIST_INTERVAL_MS) {
      this.lastTokenPersistMs = now;
      this.persistMessages();
    }
  }

  private isStreamEndpointUnavailable(error: any): boolean {
    const message = String(error?.message ?? '').toLowerCase();
    return message.includes('stream request failed (404)')
      || message.includes('stream request failed (405)');
  }

  private buildScopeOptions(): Pick<RagPromptOptions, 'nodeId' | 'nodeSourceId' | 'filter' | 'sourceType'> {
    const selected = this.selectedSourceScope();
    const nodeId = this.scopedNodeId?.trim();
    if (!nodeId) {
      return scopeOptions(selected);
    }

    if (!this.scopedNodeIsFolder) {
      // The source id goes as `nodeSourceId`, not in `filter`: the service ANDs it with the `cin_id`
      // clause itself, and passing both would repeat the clause.
      const nodeSourceId = this.currentAlfrescoSourceId();
      return {
        nodeId,
        ...(nodeSourceId ? { nodeSourceId } : {}),
        ...scopeOptions({ sourceType: selected.sourceType })
      };
    }

    const pathPrefix = this.scopedNodePath?.trim();
    if (!pathPrefix) {
      return scopeOptions(selected);
    }

    // Left unparenthesised: combineFilters wraps each side, so pre-wrapping would double it up.
    const escapedPrefix = escapeHxqlLiteral(pathPrefix);
    const filter =
      `cin_ingestProperties.source_path >= '${escapedPrefix}' AND cin_ingestProperties.source_path < '${escapedPrefix}\uFFFF'`;

    return scopeOptions({ sourceType: selected.sourceType, filter: combineFilters(selected.filter, filter) });
  }

  /**
   * The source scope for the next question.
   *
   * Scoping to an ACA node forces this repository, because the node came from it: Alfresco by type,
   * and by `cin_sourceId` once the repository id is known, so another Alfresco source in the index is
   * left out. Otherwise the selected option decides, and an id-level option scopes through the filter
   * rather than through `sourceType`, since the prompt request carries no source id (#16).
   */
  private selectedSourceScope(): SourceScope {
    if (this.scopedNodeId) {
      const ownSourceId = this.currentAlfrescoSourceId();
      return {
        sourceType: 'alfresco',
        ...(ownSourceId ? { filter: sourceIdClause(ownSourceId) } : {})
      };
    }
    return this.sources.scope(this.sources.find(this.sourceOptions, this.sourceKey));
  }

  private toPlainText(value: string): string {
    let text = value.replace(/\r\n?/g, '\n');

    text = text
      .replace(/```[^\n]*\n?/g, '')
      .replace(/```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '- ')
      .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
      .replace(/(\*\*|__)([^*_]+)\1/g, '$2')
      .replace(/(\*|_)([^*_]+)\1/g, '$2')
      .replace(/~~([^~]+)~~/g, '$1');

    text = text
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }
}
