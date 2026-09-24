import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { MatSlideToggleChange, MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { NodesApiService } from '@alfresco/adf-content-services';
import { Node, NodeEntry } from '@alfresco/js-api';
import { catchError, distinctUntilChanged, finalize, of, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ContentLakeScopeService } from '../../services/content-lake-scope.service';
import { ContentLakeStatusBatchService } from '../../services/content-lake-status-batch.service';
import { ContentLakeFolderStatusSummary, ContentLakeNodeStatus, ContentLakeSyncStatus } from '../../models/rag.models';
import {
  asNode,
  canManageExcludeOverride,
  canManageFolderExclude,
  canUpdateNode,
  findIndexedAncestor,
  hasIndexedAspect,
  isContentLakeEnabled,
  isExcludedFromLake
} from '../../utils/content-lake-scope.utils';

@Component({
  selector: 'ext-rag-content-lake-sidebar',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatSlideToggleModule],
  templateUrl: './content-lake-sidebar.component.html',
  styleUrl: './content-lake-sidebar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContentLakeSidebarComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  nodeEntry: NodeEntry | null = null;
  nodeStatus: ContentLakeNodeStatus | null = null;
  loading = false;
  saving = false;
  statusLoading = false;

  /** Node whose pending ingestion already triggered a refresh window. */
  private pendingWatchNodeId: string | null = null;

  constructor(
    private readonly store: Store<any>,
    private readonly scopeService: ContentLakeScopeService,
    private readonly batchService: ContentLakeStatusBatchService,
    private readonly nodesApiService: NodesApiService
  ) {
    this.store
      .select((state: any) => state?.app?.selection?.first?.entry ?? state?.app?.selection?.file?.entry ?? state?.app?.selection?.folder?.entry ?? null)
      .pipe(
        distinctUntilChanged((previous: Node | null, current: Node | null) => previous?.id === current?.id),
        switchMap((node: Node | null) => {
          this.pendingWatchNodeId = null;
          if (!node?.id) {
            this.nodeEntry = null;
            this.nodeStatus = null;
            return of(null);
          }

          this.loading = true;
          return this.scopeService.getNode(node.id).pipe(
            catchError(() => of({ entry: node } as NodeEntry)),
            finalize(() => {
              this.loading = false;
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((nodeEntry) => {
        this.nodeEntry = nodeEntry;
        this.refreshStatus();
      });

    this.nodesApiService.nodeUpdated
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((node: Node) => {
        if (this.selectedNode?.id === node?.id) {
          this.nodeEntry = { entry: node } as NodeEntry;
          this.cdr.markForCheck();
        }
      });

    this.batchService.changes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshStatus());
  }

  get selectedNode(): Node | null {
    return asNode(this.nodeEntry);
  }

  get isFolder(): boolean {
    return !!this.selectedNode?.isFolder;
  }

  get isFile(): boolean {
    return !!this.selectedNode?.isFile;
  }

  get folderIndexed(): boolean {
    return hasIndexedAspect(this.selectedNode);
  }

  get nodeExcluded(): boolean {
    return isExcludedFromLake(this.selectedNode);
  }

  get contentLakeEnabled(): boolean {
    return isContentLakeEnabled(this.selectedNode);
  }

  // ── Scope section ──

  get scopeIcon(): string {
    if (this.nodeExcluded) {
      return 'block';
    }
    return this.contentLakeEnabled ? 'offline_bolt' : 'hide_source';
  }

  get scopeDescription(): string {
    const node = this.selectedNode;
    if (!node) {
      return '';
    }

    const indexedAncestor = findIndexedAncestor(node);

    if (node.isFolder) {
      if (isExcludedFromLake(node)) {
        return 'This folder subtree is excluded from Content Lake.';
      }
      if (hasIndexedAspect(node)) {
        return 'This folder is a Content Lake scope root.';
      }
      if (indexedAncestor) {
        return `Included via "${indexedAncestor.name}".`;
      }
      return 'This folder is outside Content Lake scope.';
    }

    if (isExcludedFromLake(node)) {
      return 'This document is excluded from Content Lake.';
    }
    if (this.contentLakeEnabled && indexedAncestor) {
      return `Included via "${indexedAncestor.name}".`;
    }
    return 'This document is outside Content Lake scope.';
  }

  get folderToggleEnabled(): boolean {
    return this.isFolder && canUpdateNode(this.selectedNode) && !this.saving;
  }

  get showFolderExcludeToggle(): boolean {
    return this.isFolder && canManageFolderExclude(this.selectedNode);
  }

  get folderExcludeToggleEnabled(): boolean {
    return this.showFolderExcludeToggle && canUpdateNode(this.selectedNode) && !this.saving;
  }

  get showDocumentExcludeToggle(): boolean {
    return this.isFile && canManageExcludeOverride(this.selectedNode);
  }

  get documentExcludeToggleEnabled(): boolean {
    return this.showDocumentExcludeToggle && canUpdateNode(this.selectedNode) && !this.saving;
  }

  // ── Ingestion status section ──

  get syncStatus(): ContentLakeSyncStatus | null {
    return this.nodeStatus?.status ?? null;
  }

  get statusLabel(): string {
    if (this.statusLoading) {
      return 'Loading…';
    }
    if (!this.nodeStatus) {
      return 'Not available';
    }
    if (!this.nodeStatus.inScope) {
      return 'Not applicable';
    }
    switch (this.nodeStatus.status) {
      case 'PENDING':
        return 'Pending';
      case 'INDEXED':
        return 'Indexed';
      case 'FAILED':
        return 'Not indexed (error)';
      case 'SKIPPED':
        return 'Skipped (cannot contain text)';
      default:
        return this.isFolder ? 'Not applicable' : 'Pending';
    }
  }

  get statusIcon(): string {
    if (!this.nodeStatus?.inScope) {
      return 'remove_circle_outline';
    }
    switch (this.nodeStatus?.status) {
      case 'PENDING':
        return 'schedule';
      case 'INDEXED':
        return 'check_circle';
      case 'FAILED':
        return 'error';
      case 'SKIPPED':
        return 'do_not_disturb_on';
      default:
        return 'help_outline';
    }
  }

  get folderSummary(): ContentLakeFolderStatusSummary | null {
    return this.nodeStatus?.folderSummary ?? null;
  }

  get statusError(): string | null {
    return this.nodeStatus?.error ?? null;
  }

  // ── Actions ──

  onFolderIndexedChange(event: MatSlideToggleChange): void {
    if (!this.selectedNode) {
      return;
    }

    this.pendingWatchNodeId = null;
    this.saving = true;
    this.scopeService
      .setFolderIndexed(this.selectedNode, event.checked)
      .pipe(
        finalize(() => {
          this.saving = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((updatedNode) => {
        this.nodeEntry = updatedNode;
        this.refreshStatus(true);
      });
  }

  onNodeExcludedChange(event: MatSlideToggleChange): void {
    if (!this.selectedNode) {
      return;
    }

    this.pendingWatchNodeId = null;
    this.saving = true;
    this.scopeService
      .setNodeExcluded(this.selectedNode, event.checked)
      .pipe(
        finalize(() => {
          this.saving = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((updatedNode) => {
        this.nodeEntry = updatedNode;
        this.refreshStatus(true);
      });
  }

  onRefreshStatus(): void {
    this.pendingWatchNodeId = null;
    this.refreshStatus(true);
  }

  private refreshStatus(invalidateCache = false): void {
    const nodeId = this.selectedNode?.id;
    if (!nodeId) {
      this.nodeStatus = null;
      this.cdr.markForCheck();
      return;
    }

    if (invalidateCache) {
      this.batchService.invalidate(nodeId);
    }

    this.statusLoading = true;
    this.cdr.markForCheck();

    const status$ = this.selectedNode?.isFolder
      ? this.batchService.getNodeStatusDetailed(nodeId)
      : this.batchService.getNodeStatus(nodeId);

    status$
      .pipe(
        catchError(() => of(null)),
        finalize(() => {
          this.statusLoading = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((status) => {
        // Only apply if the node hasn't changed while loading
        if (this.selectedNode?.id === nodeId) {
          this.nodeStatus = status;
          this.watchWhilePending(nodeId, status);
          this.cdr.markForCheck();
        }
      });
  }

  /**
   * Starts one bounded refresh window per node that is still being ingested, so the
   * panel converges on its own. Guarded by {@link pendingWatchNodeId} because each
   * refresh re-enters here, and restarting the window every time would poll forever.
   */
  private watchWhilePending(nodeId: string, status: ContentLakeNodeStatus | null): void {
    if (!status || this.pendingWatchNodeId === nodeId) {
      return;
    }

    const pending = status.status === 'PENDING' || (status.folderSummary?.pendingDocuments ?? 0) > 0;
    if (pending) {
      this.pendingWatchNodeId = nodeId;
      this.batchService.startRefreshWindow();
    }
  }
}
