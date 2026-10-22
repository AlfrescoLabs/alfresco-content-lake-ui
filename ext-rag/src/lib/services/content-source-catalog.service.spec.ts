import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { ContentSourceCatalogService, ContentSourceOption } from './content-source-catalog.service';
import { RagApiService } from './rag-api.service';
import { StatusResponse } from '../models/rag.models';

/** A `/api/status` body carrying only what the catalogue reads. */
function status(sourceCounts: Record<string, number>): StatusResponse {
  return {
    hxprStatus: 'UP',
    totalDocuments: Object.values(sourceCounts).reduce((a, b) => a + b, 0),
    sourceCounts,
    embeddingModel: { status: 'UP' }
  } as StatusResponse;
}

describe('ContentSourceCatalogService', () => {

  let ragApi: jasmine.SpyObj<RagApiService>;
  let service: ContentSourceCatalogService;

  beforeEach(() => {
    ragApi = jasmine.createSpyObj<RagApiService>('RagApiService', ['getStatus']);
    TestBed.configureTestingModule({
      providers: [
        ContentSourceCatalogService,
        { provide: RagApiService, useValue: ragApi }
      ]
    });
  });

  /** Resolves the option list for a given `sourceCounts`. */
  function optionsFor(sourceCounts: Record<string, number>): ContentSourceOption[] {
    ragApi.getStatus.and.returnValue(of(status(sourceCounts)));
    service = TestBed.inject(ContentSourceCatalogService);
    let options: ContentSourceOption[] = [];
    service.options().subscribe((o) => { options = o; });
    return options;
  }

  it('offersEverySourceTypeTheIndexHoldsIncludingOnesThisBuildDoesNotKnow', () => {
    const options = optionsFor({
      'alfresco:acs-uuid': 120,
      'nuxeo:prod': 40,
      'cmis:docmgr': 12,
      'sample-directory:local': 3
    });

    expect(options.map((o) => o.key)).toEqual(['alfresco', 'nuxeo', 'cmis', 'sample-directory']);
    expect(options.map((o) => o.label)).toEqual(['Alfresco', 'Nuxeo', 'CMIS', 'Sample Directory']);
    expect(options.map((o) => o.count)).toEqual([120, 40, 12, 3]);
  });

  it('offersNoTypeTheIndexHoldsNoSourceOf', () => {
    // Nuxeo is not offered without a Nuxeo source, and neither is Alfresco.
    const options = optionsFor({ 'cmis:docmgr': 5 });

    expect(options.map((o) => o.key)).toEqual(['cmis']);
  });

  it('fallsBackToTheTwoKnownSourcesWhenStatusFails', () => {
    // sourceCounts is empty whenever hxpr is down, and the request can fail outright. Neither may empty
    // the filter: it has to stay at least as usable as the hardcoded options it replaced.
    ragApi.getStatus.and.returnValue(throwError(() => new Error('hxpr down')));
    service = TestBed.inject(ContentSourceCatalogService);

    let options: ContentSourceOption[] = [];
    service.options().subscribe((o) => { options = o; });

    expect(options.map((o) => o.key)).toEqual(['alfresco', 'nuxeo']);
  });

  it('namesEachOfTwoAlfrescoSourcesAndAddsNoRedundantTypeOption', () => {
    // "All Alfresco" would repeat "All sources" when Alfresco is the only type.
    const options = optionsFor({ 'alfresco:55d96fae-4d3a': 4, 'alfresco:5ce58fd0-91b2': 9 });

    expect(options.map((o) => o.key)).toEqual(['alfresco:5ce58fd0-91b2', 'alfresco:55d96fae-4d3a']);
    expect(options.map((o) => o.label)).toEqual(['Alfresco (5ce5)', 'Alfresco (55d9)']);
  });

  it('addsATypeOptionForSeveralSourcesOfATypeOnlyBesideAnotherType', () => {
    const options = optionsFor({
      'cmis:docmgr': 12,
      'cmis:archive': 30,
      'nuxeo:prod': 40
    });

    expect(options.map((o) => o.key)).toEqual(['nuxeo', 'cmis', 'cmis:archive', 'cmis:docmgr']);
    expect(options.map((o) => o.label)).toEqual(['Nuxeo', 'All CMIS', 'CMIS (arch)', 'CMIS (docm)']);
  });

  it('scopesATypeOptionThroughSourceTypeAndAnIdOptionThroughTheFilter', () => {
    const options = optionsFor({ 'cmis:docmgr': 1, 'cmis:archive': 1, 'nuxeo:prod': 1 });

    // A type is scoped by naming its sources, not through the sourceType request field: that field
    // filters on the source_type ingest property, which only the Alfresco and Nuxeo adapters populate,
    // so sourceType: 'cmis' matches nothing against a live index.
    const type = service.find(options, 'cmis')!;
    // Order follows the status response, not the count-sorted order the id-level options use; for an
    // OR it makes no difference.
    expect(service.scope(type)).toEqual({
      filter: "cin_sourceId = 'cmis:docmgr' OR cin_sourceId = 'cmis:archive'"
    });

    // The request models carry no source id, so one repository can only be named in the filter.
    const id = service.find(options, 'cmis:archive')!;
    expect(service.scope(id)).toEqual({ filter: "cin_sourceId = 'cmis:archive'" });
  });

  it('andsTheSourceScopeWithAFilterTheCallerAlreadyHad', () => {
    const options = optionsFor({ 'cmis:docmgr': 1, 'cmis:archive': 1 });
    const id = service.find(options, 'cmis:docmgr')!;

    expect(service.scope(id, "cin_ingestProperties.source_mimeType = 'application/pdf'").filter)
      .toBe("(cin_ingestProperties.source_mimeType = 'application/pdf') AND (cin_sourceId = 'cmis:docmgr')");
  });

  it('fallsBackToSourceTypeOnlyForATypeTheIndexReportedNothingFor', () => {
    // Alfresco and Nuxeo are offered with nothing indexed, so they alone can have no known source ids.
    // Both adapters do populate source_type, so the request field works for them.
    const options = optionsFor({});

    const alfresco = service.find(options, 'alfresco')!;
    expect(alfresco.sourceKeys).toEqual([]);
    expect(service.scope(alfresco)).toEqual({ sourceType: 'alfresco', filter: undefined });
  });

  it('treatsNoSelectionAsEverySourceAndKeepsTheCallersFilter', () => {
    optionsFor({});
    expect(service.scope(undefined)).toEqual({ filter: undefined });
    expect(service.scope(undefined, "a = '1'")).toEqual({ filter: "a = '1'" });
  });

  it('readsStatusOnceForEveryScreenThatAsks', () => {
    optionsFor({ 'nuxeo:prod': 1 });

    // The search page, the chat page and the status page all ask; sourceCounts changes only when a new
    // source is ingested into.
    service.options().subscribe();
    service.options().subscribe();
    expect(ragApi.getStatus).toHaveBeenCalledTimes(1);

    service.refresh();
    service.options().subscribe();
    expect(ragApi.getStatus).toHaveBeenCalledTimes(2);
  });
});
