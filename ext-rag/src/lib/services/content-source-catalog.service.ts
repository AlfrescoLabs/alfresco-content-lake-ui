import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';

import { RagApiService } from './rag-api.service';
import { sourceKeyLabel, sourceTypeLabel, splitSourceKey } from '../utils/source-label.util';
import { combineFilters, sourceIdClause, sourceIdsClause } from '../utils/hxql.util';

/** One selectable source: a whole type, or one repository within a type. */
export interface ContentSourceOption {
  /** The control's value: a bare source type, or the full `<sourceType>:<sourceId>` key. */
  key: string;
  level: 'type' | 'id';
  sourceType: string;
  sourceId?: string;
  label: string;
  /**
   * The `cin_sourceId` values this option covers: every source of the type for a type-level option, and
   * the one source for an id-level option. Empty only for the fallback types, when the index reported nothing.
   */
  sourceKeys: string[];
  /** Documents this option covers, as reported by `/api/status`. */
  count: number;
}

/** The request fields that scope a search to a selected source. */
export interface SourceScope {
  sourceType?: string;
  filter?: string;
}

/**
 * What sources the index holds, and how to scope a search to one of them (#16).
 *
 * The list is derived from `GET /api/status`'s `sourceCounts`, whose keys are the stored `cin_sourceId`
 * values (`<sourceType>:<sourceId>`). That is the set of sources the index actually holds, so a source
 * type this build has never heard of - a CMIS repository, a plugin connector, a filesystem tree - is
 * offered without any change here. Two properties of that map shape this service:
 *
 * - it covers the whole index rather than what the caller may read, which is fine for an option list;
 * - `StatusController` populates it only while hxpr is UP, so a hxpr blip returns it empty.
 *
 * A type is offered only when the index holds a source of it. {@link FALLBACK_TYPES} is used only when
 * the status response is empty or failed, so the filter is then no worse than the two hardcoded options
 * it replaced.
 */
@Injectable({ providedIn: 'root' })
export class ContentSourceCatalogService {

  /** Offered only when the index reports no source at all, and drawn first in any list. */
  static readonly FALLBACK_TYPES: readonly string[] = ['alfresco', 'nuxeo'];

  /** The "every source" option's value. */
  static readonly ALL_SOURCES = '';

  private ragApi = inject(RagApiService);

  private cached?: Observable<ContentSourceOption[]>;

  /**
   * The options to offer: one per source, plus one per type that has several sources while another type
   * exists too. A type with a single source is one type-level option.
   *
   * Cached for the lifetime of the app: `sourceCounts` changes only when a new source is ingested into,
   * and the search page, the chat page and the status page all read it.
   */
  options(): Observable<ContentSourceOption[]> {
    if (!this.cached) {
      this.cached = this.ragApi.getStatus().pipe(
        map((status) => this.derive(status?.sourceCounts ?? {})),
        catchError(() => of(this.derive({}))),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.cached;
  }

  /** Drops the cache so the next `options()` call re-reads `/api/status`. */
  refresh(): void {
    this.cached = undefined;
  }

  /**
   * Turns a selected option into the request fields that scope a search to it, ANDed with whatever
   * filter the caller already had.
   *
   * Scoping goes through an equality clause on `cin_sourceId` rather than through the `sourceType`
   * request field, because that is the value actually stored on the document. rag-service reads such a
   * clause in the caller's own filter as the caller naming a source, and gives it precedence over
   * everything else when it builds the permission filter, so this narrows the ACL as well as the query.
   */
  scope(option: ContentSourceOption | undefined, existingFilter?: string): SourceScope {
    if (!option || option.key === ContentSourceCatalogService.ALL_SOURCES) {
      return { filter: combineFilters(existingFilter, undefined) };
    }
    if (option.level === 'id') {
      return { filter: combineFilters(existingFilter, sourceIdClause(option.key)) };
    }
    // A type whose sources the index knows is scoped by naming them, not through the `sourceType`
    // request field. That field filters on the `source_type` ingest property, which only the Alfresco
    // and Nuxeo adapters populate: measured against a live stack, `sourceType: 'sample-directory'`
    // returned zero results for two documents that a bare query returned. Naming the ids matches the
    // stored `cin_sourceId` and works for every source.
    const named = sourceIdsClause(option.sourceKeys);
    if (named) {
      return { filter: combineFilters(existingFilter, named) };
    }
    // Only reachable for Alfresco and Nuxeo before anything is ingested into them, since every other
    // option exists because the index reported a source for it. Both populate `source_type`.
    return { sourceType: option.sourceType, filter: combineFilters(existingFilter, undefined) };
  }

  /** Finds an option by the key held in a form control. */
  find(options: readonly ContentSourceOption[], key: string): ContentSourceOption | undefined {
    return options.find((option) => option.key === key);
  }

  private derive(sourceCounts: Record<string, number>): ContentSourceOption[] {
    const idsByType = new Map<string, { sourceId: string; key: string; count: number }[]>();

    for (const [key, count] of Object.entries(sourceCounts ?? {})) {
      const { sourceType, sourceId } = splitSourceKey(key);
      if (!sourceType) {
        continue;
      }
      const ids = idsByType.get(sourceType) ?? [];
      ids.push({ sourceId, key, count: count ?? 0 });
      idsByType.set(sourceType, ids);
    }

    if (idsByType.size === 0) {
      for (const type of ContentSourceCatalogService.FALLBACK_TYPES) {
        idsByType.set(type, []);
      }
    }

    const options: ContentSourceOption[] = [];
    const types = [...idsByType.keys()].sort(byFallbackFirstThenName);
    const keys = Object.keys(sourceCounts ?? {});

    for (const sourceType of types) {
      const ids = idsByType.get(sourceType) ?? [];
      const typeOption: ContentSourceOption = {
        key: sourceType,
        level: 'type',
        sourceType,
        label: sourceTypeLabel(sourceType),
        sourceKeys: ids.map((id) => id.key),
        count: ids.reduce((total, id) => total + id.count, 0)
      };

      // One repository is the whole type, so it stays a type-level option.
      if (ids.length <= 1) {
        options.push(typeOption);
        continue;
      }

      // "All Alfresco" next to "All sources" would offer the same thing twice.
      if (types.length > 1) {
        options.push({ ...typeOption, label: `All ${typeOption.label}` });
      }
      for (const id of [...ids].sort((a, b) => b.count - a.count)) {
        options.push({
          key: id.key,
          level: 'id',
          sourceType,
          sourceId: id.sourceId,
          label: sourceKeyLabel(id.key, keys),
          sourceKeys: [id.key],
          count: id.count
        });
      }
    }

    return options;
  }
}

function byFallbackFirstThenName(a: string, b: string): number {
  const rank = (type: string) => {
    const idx = ContentSourceCatalogService.FALLBACK_TYPES.indexOf(type);
    return idx < 0 ? ContentSourceCatalogService.FALLBACK_TYPES.length : idx;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
