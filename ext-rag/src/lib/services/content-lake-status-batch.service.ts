import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '@alfresco/adf-core';
import { Observable, ReplaySubject, Subject, catchError, map, of } from 'rxjs';

import { ContentLakeNodeStatus } from '../models/rag.models';

/**
 * Batches individual node-status lookups into a single HTTP request.
 *
 * Badge components call {@link getNodeStatus} independently for each visible
 * document/folder. This service collects every ID requested during the same
 * micro-task (i.e. the same Angular change-detection pass) and resolves them
 * all with one `POST /nodes/status` call.
 *
 * Folder aggregate counts (indexed / pending / failed) are **not** included
 * in the batch call because the server-side aggregation is expensive for
 * large folders. Use {@link getNodeStatusDetailed} when you need the
 * {@link ContentLakeFolderStatusSummary} for a single selected folder
 * (e.g. the App for OpenArch sidebar).
 */
@Injectable({ providedIn: 'root' })
export class ContentLakeStatusBatchService {
  private readonly statusBaseUrl: string;
  private pending = new Map<string, ReplaySubject<ContentLakeNodeStatus | null>>();
  private flushScheduled = false;

  /** Short-lived per-node result cache, so re-renders do not re-request. */
  private cache = new Map<string, { value: ContentLakeNodeStatus | null; at: number }>();
  private static readonly CACHE_TTL_MS = 30000;

  private static readonly REFRESH_WINDOW_MS = 60000;
  private static readonly REFRESH_INTERVAL_MS = 5000;

  private readonly changesSubject = new Subject<void>();
  private refreshIntervalId?: ReturnType<typeof setInterval>;
  private refreshTimeoutId?: ReturnType<typeof setTimeout>;

  /**
   * Emits whenever cached statuses were dropped, so views that already resolved a
   * status can re-request it. Every subscriber reacting to the same emission issues
   * its request in the same micro-task, so the batch below coalesces them into one
   * HTTP call.
   */
  readonly changes$ = this.changesSubject.asObservable();

  constructor(
    private readonly http: HttpClient,
    appConfig: AppConfigService
  ) {
    this.statusBaseUrl = appConfig.get<string>('plugins.contentLakeService.baseUrl', '/api/content-lake');
  }

  /**
   * Returns the status for a single node (without folder aggregate counts).
   *
   * The actual HTTP call is deferred until the current micro-task ends so
   * that multiple calls made in the same render cycle are batched together.
   */
  getNodeStatus(nodeId: string): Observable<ContentLakeNodeStatus | null> {
    const cached = this.cache.get(nodeId);
    if (cached && (Date.now() - cached.at) < ContentLakeStatusBatchService.CACHE_TTL_MS) {
      return of(cached.value);
    }

    let subject = this.pending.get(nodeId);
    if (!subject) {
      subject = new ReplaySubject<ContentLakeNodeStatus | null>(1);
      this.pending.set(nodeId, subject);
    }
    this.scheduleFlush();
    return subject.asObservable();
  }

  /**
   * Returns the status for a single node **with** folder aggregate counts.
   *
   * This is a dedicated non-batched call intended for the sidebar where
   * the user explicitly selects a folder and expects detailed ingestion
   * statistics. It is NOT batched because `includeFolderAggregate` is
   * expensive and should only be requested for one node at a time.
   */
  getNodeStatusDetailed(nodeId: string): Observable<ContentLakeNodeStatus | null> {
    return this.http
      .post<Record<string, ContentLakeNodeStatus>>(`${this.statusBaseUrl}/nodes/status`, {
        nodeIds: [nodeId],
        includeFolderAggregate: true
      })
      .pipe(
        map((results) => results[nodeId] ?? null),
        catchError(() => of(null))
      );
  }

  /**
   * Drops the cached result (and any in-flight batch slot) for a node so the
   * next {@link getNodeStatus} call re-fetches. Call this after a scope change.
   */
  invalidate(nodeId: string): void {
    this.pending.delete(nodeId);
    this.cache.delete(nodeId);
  }

  /**
   * Drops every cached status and notifies {@link changes$}. Use it after a change
   * that can affect nodes other than the one that was edited -- flagging a folder as
   * a scope root brings its whole subtree into scope.
   */
  invalidateAll(): void {
    // Drop requests that were queued before the change instead of letting them
    // answer with data that is already out of date; the notification below makes
    // every subscriber ask again.
    const abandoned = Array.from(this.pending.values());
    this.pending.clear();
    this.cache.clear();

    abandoned.forEach((subject) => {
      subject.next(null);
      subject.complete();
    });
    this.changesSubject.next();
  }

  /**
   * Calls {@link invalidateAll} now and then every
   * {@link ContentLakeStatusBatchService.REFRESH_INTERVAL_MS} for
   * {@link ContentLakeStatusBatchService.REFRESH_WINDOW_MS}.
   *
   * Ingestion is asynchronous: a document is in scope the moment its folder is
   * flagged, but reaches INDEXED only once the ingester has picked it up. A single
   * refresh would therefore show a status that goes stale seconds later, which is
   * what made the indicators appear only after a page reload. Calling this again
   * restarts the window rather than adding a second timer.
   */
  startRefreshWindow(): void {
    this.stopRefreshWindow();
    this.invalidateAll();

    this.refreshIntervalId = setInterval(
      () => this.invalidateAll(),
      ContentLakeStatusBatchService.REFRESH_INTERVAL_MS
    );
    this.refreshTimeoutId = setTimeout(
      () => this.stopRefreshWindow(),
      ContentLakeStatusBatchService.REFRESH_WINDOW_MS
    );
  }

  /** Stops an in-flight {@link startRefreshWindow} early. */
  stopRefreshWindow(): void {
    if (this.refreshIntervalId !== undefined) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = undefined;
    }
    if (this.refreshTimeoutId !== undefined) {
      clearTimeout(this.refreshTimeoutId);
      this.refreshTimeoutId = undefined;
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;

    const batch = new Map(this.pending);
    this.pending.clear();

    const nodeIds = Array.from(batch.keys());
    if (nodeIds.length === 0) {
      return;
    }

    this.http
      .post<Record<string, ContentLakeNodeStatus>>(`${this.statusBaseUrl}/nodes/status`, {
        nodeIds
      })
      .pipe(catchError(() => of({} as Record<string, ContentLakeNodeStatus>)))
      .subscribe((results) => {
        const at = Date.now();
        for (const [id, subject] of batch) {
          const value = results[id] ?? null;
          this.cache.set(id, { value, at });
          subject.next(value);
          subject.complete();
        }
      });
  }
}
