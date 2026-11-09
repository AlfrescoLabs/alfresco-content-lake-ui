import { Injectable } from '@angular/core';
import { DocumentListService, AlfrescoApiService, NodesApiService } from '@alfresco/adf-content-services';
import { Node, NodeBodyUpdate, NodeEntry, NodesApi } from '@alfresco/js-api';
import { NotificationService } from '@alfresco/adf-core';
import { Observable, from, throwError } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import { ContentLakeStatusBatchService } from './content-lake-status-batch.service';
import {
  asNode,
  CONTENT_LAKE_EXCLUDE_PROPERTY_QNAME,
  CONTENT_LAKE_FILE_SCOPE_ASPECT,
  CONTENT_LAKE_FILE_SCOPE_ASPECT_QNAME,
  CONTENT_LAKE_INDEXED_ASPECT,
  CONTENT_LAKE_INDEXED_ASPECT_QNAME,
  ContentLakeNodeLike
} from '../utils/content-lake-scope.utils';

@Injectable({ providedIn: 'root' })
export class ContentLakeScopeService {
  private nodesApiInstance: NodesApi | null = null;

  constructor(
    private readonly alfrescoApi: AlfrescoApiService,
    private readonly nodesApiService: NodesApiService,
    private readonly documentListService: DocumentListService,
    private readonly notifications: NotificationService,
    private readonly statusBatchService: ContentLakeStatusBatchService
  ) {}

  getNode(nodeId: string): Observable<NodeEntry> {
    return from(this.nodesApi.getNode(nodeId, { include: ['path', 'properties', 'allowableOperations', 'permissions', 'aspectNames'] }));
  }

  setFolderIndexed(nodeLike: ContentLakeNodeLike, indexed: boolean): Observable<NodeEntry> {
    const node = this.requireNode(nodeLike);
    return this.getNode(node.id).pipe(
      switchMap((nodeEntry) => {
        const aspectNames = this.copyAspectNames(nodeEntry.entry);

        if (indexed) {
          aspectNames.add(CONTENT_LAKE_INDEXED_ASPECT_QNAME);
        } else {
          this.removeAspect(aspectNames, CONTENT_LAKE_INDEXED_ASPECT, CONTENT_LAKE_INDEXED_ASPECT_QNAME);
        }

        return this.updateNode(node.id, {
          aspectNames: Array.from(aspectNames)
        });
      }),
      tap(() =>
        this.notifications.showInfo(
          indexed ? 'App for OpenArch enabled for folder subtree' : 'App for OpenArch disabled for folder subtree'
        )
      )
    );
  }

  setNodeExcluded(nodeLike: ContentLakeNodeLike, excluded: boolean): Observable<NodeEntry> {
    const node = this.requireNode(nodeLike);
    const isFolder = !!node.isFolder;
    return this.getNode(node.id).pipe(
      switchMap((nodeEntry) => {
        const aspectNames = this.copyAspectNames(nodeEntry.entry);
        const update: NodeBodyUpdate = {
          aspectNames: Array.from(aspectNames)
        };

        if (excluded) {
          aspectNames.add(CONTENT_LAKE_FILE_SCOPE_ASPECT_QNAME);
          update.properties = {
            [CONTENT_LAKE_EXCLUDE_PROPERTY_QNAME]: 'true'
          };
        } else {
          this.removeAspect(aspectNames, CONTENT_LAKE_FILE_SCOPE_ASPECT, CONTENT_LAKE_FILE_SCOPE_ASPECT_QNAME);
        }

        update.aspectNames = Array.from(aspectNames);
        return this.updateNode(node.id, update);
      }),
      tap(() =>
        this.notifications.showInfo(
          excluded
            ? (isFolder ? 'Folder subtree excluded from App for OpenArch' : 'Document excluded from App for OpenArch')
            : (isFolder ? 'Folder subtree restored to inherited scope' : 'Document restored to inherited scope')
        )
      )
    );
  }

  private updateNode(nodeId: string, update: NodeBodyUpdate): Observable<NodeEntry> {
    return from(this.nodesApi.updateNode(nodeId, update, { include: ['path', 'properties', 'allowableOperations', 'permissions', 'aspectNames'] })).pipe(
      tap((updatedNode) => {
        this.nodesApiService.nodeUpdated.next(updatedNode.entry);
        this.documentListService.reload();
        // A scope change affects the whole subtree, and the documents in it only reach
        // INDEXED once the ingester has processed them, so poll for a while instead of
        // reading a status that is about to change.
        this.statusBatchService.startRefreshWindow();
      }),
      catchError((error) => {
        this.notifications.showError(this.getUpdateErrorMessage(error));
        return throwError(() => error);
      })
    );
  }

  private get nodesApi(): NodesApi {
    this.nodesApiInstance = this.nodesApiInstance ?? new NodesApi(this.alfrescoApi.getInstance());
    return this.nodesApiInstance;
  }

  private requireNode(nodeLike: ContentLakeNodeLike): Node {
    const node = asNode(nodeLike);
    if (!node?.id) {
      throw new Error('A valid Alfresco node is required');
    }
    return node;
  }

  private copyAspectNames(node: Node): Set<string> {
    return new Set((node.aspectNames ?? []).map((aspectName) => {
      if (aspectName === CONTENT_LAKE_INDEXED_ASPECT) {
        return CONTENT_LAKE_INDEXED_ASPECT_QNAME;
      }
      if (aspectName === CONTENT_LAKE_FILE_SCOPE_ASPECT) {
        return CONTENT_LAKE_FILE_SCOPE_ASPECT_QNAME;
      }
      return aspectName;
    }));
  }

  private removeAspect(aspectNames: Set<string>, shortQName: string, fullQName: string): void {
    aspectNames.delete(shortQName);
    aspectNames.delete(fullQName);
  }

  private getUpdateErrorMessage(error: any): string {
    const details = this.extractErrorDetails(error);

    if (
      details.includes('namespace prefix cl is not mapped') ||
      details.includes("cl:indexed isn't a valid qname") ||
      details.includes("cl:excludefromlake isn't a valid qname")
    ) {
      return 'App for OpenArch model is not deployed in Alfresco. Install content-lake-repo-model and restart the repository.';
    }

    return 'Unable to update App for OpenArch scope';
  }

  private extractErrorDetails(error: any): string {
    return [
      error?.error?.error?.briefSummary,
      error?.error?.error?.description,
      error?.error?.briefSummary,
      error?.error?.message,
      error?.message
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();
  }
}
