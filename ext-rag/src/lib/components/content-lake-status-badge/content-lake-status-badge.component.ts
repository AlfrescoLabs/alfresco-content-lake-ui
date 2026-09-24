import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Node, NodeEntry } from '@alfresco/js-api';
import { Subscription, catchError, of } from 'rxjs';

import { ContentLakeNodeStatus, ContentLakeSyncStatus } from '../../models/rag.models';
import { ContentLakeStatusBatchService } from '../../services/content-lake-status-batch.service';
import { asNode } from '../../utils/content-lake-scope.utils';

type DocumentStatus = ContentLakeSyncStatus | 'NOT_APPLICABLE' | 'NOT_AVAILABLE';

/**
 * Folder-specific scope indicator shown instead of aggregated ingestion
 * status (which is expensive). The full breakdown is available in the
 * Content Lake sidebar when the user selects the folder.
 */
type FolderScope = 'IN_SCOPE' | 'EXCLUDED' | 'OUT_OF_SCOPE';

@Component({
  selector: 'ext-rag-content-lake-status-badge',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatTooltipModule],
  templateUrl: './content-lake-status-badge.component.html',
  styleUrl: './content-lake-status-badge.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContentLakeStatusBadgeComponent implements OnChanges, OnDestroy {
  @Input() data?: { node?: NodeEntry | Node };

  private readonly batchService = inject(ContentLakeStatusBatchService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private statusRequest?: Subscription;

  /** Whether the badge should render at all (hidden for out-of-scope nodes). */
  visible = false;

  private isFolder = false;
  private status: DocumentStatus = 'NOT_AVAILABLE';
  private statusError: string | null = null;
  private folderScope: FolderScope = 'OUT_OF_SCOPE';

  constructor() {
    // The row data never changes when scope or ingestion state does, so without this
    // the badge would keep showing the status it resolved on first render.
    this.batchService.changes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshStatus());
  }

  ngOnChanges(): void {
    this.refreshStatus();
  }

  ngOnDestroy(): void {
    this.statusRequest?.unsubscribe();
  }

  get statusIcon(): string {
    if (this.isFolder) {
      switch (this.folderScope) {
        case 'IN_SCOPE':
          return 'check_circle';
        case 'EXCLUDED':
          return 'block';
        default:
          return 'remove_circle_outline';
      }
    }

    switch (this.status) {
      case 'PENDING':
        return 'schedule';
      case 'INDEXED':
        return 'check_circle';
      case 'FAILED':
        return 'error';
      case 'SKIPPED':
        return 'do_not_disturb_on';
      case 'NOT_APPLICABLE':
        return 'remove_circle_outline';
      default:
        return 'help_outline';
    }
  }

  get statusClass(): string {
    if (this.isFolder) {
      switch (this.folderScope) {
        case 'IN_SCOPE':
          return 'ext-rag-status-badge--in-scope';
        case 'EXCLUDED':
          return 'ext-rag-status-badge--excluded';
        default:
          return 'ext-rag-status-badge--default';
      }
    }

    switch (this.status) {
      case 'PENDING':
        return 'ext-rag-status-badge--pending';
      case 'INDEXED':
        return 'ext-rag-status-badge--indexed';
      case 'FAILED':
        return 'ext-rag-status-badge--failed';
      case 'SKIPPED':
        return 'ext-rag-status-badge--skipped';
      default:
        return 'ext-rag-status-badge--default';
    }
  }

  get statusTooltip(): string {
    if (this.isFolder) {
      switch (this.folderScope) {
        case 'IN_SCOPE':
          return 'Content Lake: In scope';
        case 'EXCLUDED':
          return 'Content Lake: Excluded';
        default:
          return 'Content Lake: Not in scope';
      }
    }

    switch (this.status) {
      case 'PENDING':
        return 'Content Lake status: Pending';
      case 'INDEXED':
        return 'Content Lake status: Indexed';
      case 'FAILED':
        return this.statusError?.trim() ? `Content Lake status: Error (${this.statusError})` : 'Content Lake status: Error';
      // Nothing was attempted, because the type cannot contain text. Distinct from Error, which means a
      // pass ran and produced nothing, and the reason is worth showing because it names the extension.
      case 'SKIPPED':
        return this.statusError?.trim() ? `Content Lake status: Skipped (${this.statusError})` : 'Content Lake status: Skipped';
      case 'NOT_APPLICABLE':
        return 'Content Lake status: Not applicable';
      default:
        return 'Content Lake status: Not available';
    }
  }

  private refreshStatus(): void {
    const node = asNode(this.data?.node);
    this.statusRequest?.unsubscribe();
    this.statusError = null;
    this.isFolder = !!node?.isFolder;

    if (!node?.id || (!node.isFile && !node.isFolder)) {
      this.visible = false;
      this.cdr.markForCheck();
      return;
    }

    // Resolve real ingestion scope from the status API for both files and
    // folders. Document-list rows do not carry `path`/`properties`/aspects, so
    // scope cannot be derived client-side; the batch service coalesces the
    // per-row lookups into a single request per render pass.
    this.statusRequest = this.batchService
      .getNodeStatus(node.id)
      .pipe(catchError(() => of(null)))
      .subscribe((nodeStatus) => {
        this.applyNodeStatus(nodeStatus);
        this.cdr.markForCheck();
      });
  }

  private applyNodeStatus(nodeStatus: ContentLakeNodeStatus | null): void {
    if (!nodeStatus) {
      this.visible = false;
      return;
    }

    if (this.isFolder) {
      if (nodeStatus.excluded) {
        this.folderScope = 'EXCLUDED';
        this.visible = true;
      } else if (nodeStatus.inScope) {
        this.folderScope = 'IN_SCOPE';
        this.visible = true;
      } else {
        this.folderScope = 'OUT_OF_SCOPE';
        this.visible = false;
      }
      return;
    }

    // Files: only surface a badge for in-scope documents.
    if (!nodeStatus.inScope) {
      this.visible = false;
      return;
    }

    this.status = nodeStatus.status ?? 'PENDING';
    this.statusError = nodeStatus.error ?? null;
    this.visible = true;
  }
}
