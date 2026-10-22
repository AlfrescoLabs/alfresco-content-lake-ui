import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { DiscoveryApiService } from '@alfresco/adf-content-services';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { forkJoin, of } from 'rxjs';
import { catchError, take } from 'rxjs/operators';

import { RagApiService } from '../../services/rag-api.service';
import {
  ContentSourceCatalogService,
  ContentSourceOption
} from '../../services/content-source-catalog.service';
import { SearchResultItem, MergedDocument, FacetBucket, FacetsResponse } from '../../models/rag.models';
import { openInSourceLabel, resolveSourceType, sourceKeyLabel, sourceTypeLabel } from '../../utils/source-label.util';
import { combineFilters, escapeHxqlLiteral } from '../../utils/hxql.util';

interface FacetGroup {
  property: string;
  label: string;
  buckets: FacetBucket[];
}

@Component({
  selector: 'ext-rag-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatExpansionModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './rag-search.component.html',
  styleUrls: ['./rag-search.component.css']
})
export class RagSearchComponent implements OnInit {

  query = '';
  topK = 5;
  minScore = 0.5;
  /** #18: distinct documents to ask for. Empty leaves topK owning the budget, as before. */
  topDocuments?: number;
  /** The selected source option's key: '' for every source (#16). */
  sourceKey = '';
  sourceOptions: ContentSourceOption[] = [];
  // #6 saved-search filters (hxpr named queries). Empty list hides the selector.
  namedQueries: string[] = [];
  selectedNamedQuery = '';
  loading = false;
  error: string | null = null;
  searchTimeMs = 0;
  documentCount?: number;
  documents: MergedDocument[] = [];
  currentRepositoryId: string | null = null;
  repositoryResolved = false;

  // #5 faceted search
  facetGroups: FacetGroup[] = [];
  activeFacets: { property: string; value: string }[] = [];

  constructor(
    private ragApi: RagApiService,
    private discoveryApi: DiscoveryApiService,
    private sources: ContentSourceCatalogService
  ) {}

  ngOnInit(): void {
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

    // #6: load the available named queries for the saved-query selector. Best-effort: on failure
    // (or none registered) the selector stays hidden and search behaves as before.
    this.ragApi.getNamedQueries()
      .pipe(take(1), catchError(() => of([] as string[])))
      .subscribe((names) => {
        this.namedQueries = Array.isArray(names) ? names : [];
      });
  }

  runSearch(): void {
    const q = this.query.trim();
    if (!q) {
      return;
    }

    this.loading = true;
    this.error = null;
    // The source scope and the facet filter share one `filter` field, so they are combined here.
    const selected = this.sources.find(this.sourceOptions, this.sourceKey);
    const scope = this.sources.scope(selected, this.buildFacetFilter());

    this.ragApi.search(q, this.topK, this.minScore, {
      sourceType: scope.sourceType,
      filter: scope.filter,
      namedQuery: this.selectedNamedQuery || undefined,
      topDocuments: this.topDocuments
    }).subscribe({
      next: (res) => {
        this.searchTimeMs = res.searchTimeMs;
        this.documentCount = res.documentCount;
        this.documents = this.mergeResults(res.results);
        this.loading = false;
        this.loadFacets(scope.filter, scope.sourceType);
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Search request failed';
        this.loading = false;
      }
    });
  }

  /* -------- #5 faceted search -------- */

  toggleFacet(property: string, value: string): void {
    const idx = this.activeFacets.findIndex((f) => f.property === property && f.value === value);
    if (idx >= 0) {
      this.activeFacets.splice(idx, 1);
    } else {
      this.activeFacets.push({ property, value });
    }
    if (this.query.trim()) {
      this.runSearch();
    }
  }

  isFacetActive(property: string, value: string): boolean {
    return this.activeFacets.some((f) => f.property === property && f.value === value);
  }

  clearFacets(): void {
    if (this.activeFacets.length === 0) {
      return;
    }
    this.activeFacets = [];
    if (this.query.trim()) {
      this.runSearch();
    }
  }

  facetLabel(property: string): string {
    if (property === 'cin_sourceId') {
      return 'Source';
    }
    if (property.toLowerCase().endsWith('mimetype')) {
      return 'File type';
    }
    const segment = property.split('.').pop() ?? property;
    const spaced = segment.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  /** Human-friendly display for a bucket value (mime types get readable names). */
  facetValueLabel(property: string, value: string): string {
    if (property.toLowerCase().endsWith('mimetype')) {
      return RagSearchComponent.MIME_LABELS[value] ?? value;
    }
    // cin_sourceId buckets are `<sourceType>:<sourceId>`, which is not a label.
    if (property === 'cin_sourceId') {
      // The other buckets are the sources this value has to be told apart from.
      const group = this.facetGroups.find((g) => g.property === property);
      return sourceKeyLabel(value, group?.buckets.map((bucket) => bucket.value) ?? []);
    }
    return value;
  }

  private static readonly MIME_LABELS: Record<string, string> = {
    'text/plain': 'Plain text',
    'text/html': 'HTML',
    'text/csv': 'CSV',
    'application/pdf': 'PDF',
    'application/msword': 'Word document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
    'application/vnd.ms-excel': 'Excel spreadsheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'application/rtf': 'Rich text',
    'application/json': 'JSON',
    'application/xml': 'XML',
    'text/xml': 'XML'
  };

  private loadFacets(filter?: string, sourceType?: string): void {
    const properties = this.ragApi.facetProperties;
    if (!properties.length) {
      this.facetGroups = [];
      return;
    }

    forkJoin(
      properties.map((property) =>
        this.ragApi.facets({
          property,
          topN: 10,
          ...(filter ? { filter } : {}),
          ...(sourceType ? { sourceType } : {})
        }).pipe(catchError(() => of({ property, buckets: [] } as FacetsResponse)))
      )
    ).subscribe((responses) => {
      this.facetGroups = responses
        .filter((r) => Array.isArray(r.buckets) && r.buckets.length > 0)
        .map((r) => ({ property: r.property, label: this.facetLabel(r.property), buckets: r.buckets }));
    });
  }

  private buildFacetFilter(): string | undefined {
    if (this.activeFacets.length === 0) {
      return undefined;
    }
    const byProperty = new Map<string, string[]>();
    for (const facet of this.activeFacets) {
      const clauses = byProperty.get(facet.property) ?? [];
      clauses.push(`${facet.property} = '${escapeHxqlLiteral(facet.value)}'`);
      byProperty.set(facet.property, clauses);
    }
    let combined: string | undefined;
    for (const clauses of byProperty.values()) {
      combined = combineFilters(combined, clauses.length > 1 ? clauses.join(' OR ') : clauses[0]);
    }
    return combined;
  }

  private mergeResults(results: SearchResultItem[]): MergedDocument[] {
    const map = new Map<string, MergedDocument>();
    for (const item of results) {
      const nodeId = item.sourceDocument.nodeId;
      const sourceId = item.sourceDocument.sourceId;
      const existing = map.get(this.documentKey(nodeId, sourceId));
      const chunkType = item.chunkMetadata?.chunkType;
      if (existing) {
        existing.score = Math.max(existing.score, item.score);
        existing.chunks.push({ text: item.chunkText, score: item.score, chunkType });
      } else {
        map.set(this.documentKey(nodeId, sourceId), {
          nodeId,
          sourceId,
          sourceType: resolveSourceType(item.sourceDocument),
          name: item.sourceDocument.name,
          path: item.sourceDocument.path,
          score: item.score,
          chunks: [{ text: item.chunkText, score: item.score, chunkType }],
          openInSourceUrl: item.sourceDocument.openInSourceUrl
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
}
