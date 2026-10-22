import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '@alfresco/adf-core';
import { of } from 'rxjs';

import { RagApiService } from './rag-api.service';
import { RagPromptStreamEvent } from '../models/rag.models';

describe('RagApiService', () => {
  let service: RagApiService;
  let httpSpy: jasmine.SpyObj<HttpClient>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    httpSpy = jasmine.createSpyObj<HttpClient>('HttpClient', ['post', 'get']);
    httpSpy.post.and.returnValue(of({}));
    httpSpy.get.and.returnValue(of({}));

    const appConfigSpy = jasmine.createSpyObj<AppConfigService>('AppConfigService', ['get']);
    appConfigSpy.get.and.callFake((key: string, defaultValue: any) => {
      const config: Record<string, string> = {
        'plugins.ragService.baseUrl': '/api/rag',
        'plugins.ragService.searchPath': '/search/semantic',
        'plugins.ragService.promptPath': '/prompt',
        'plugins.ragService.streamPath': '/chat/stream'
      };
      return config[key] ?? defaultValue;
    });

    TestBed.configureTestingModule({
      providers: [
        RagApiService,
        {
          provide: HttpClient,
          useValue: httpSpy
        },
        {
          provide: AppConfigService,
          useValue: appConfigSpy
        }
      ]
    });

    service = TestBed.inject(RagApiService);
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  it('search_includesSourceTypeWhenProvided', () => {
    service.search('budget', 7, 0.4, { sourceType: 'nuxeo' }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/search/semantic',
      jasmine.objectContaining({
        query: 'budget',
        topK: 7,
        minScore: 0.4,
        sourceType: 'nuxeo'
      })
    );
  });

  it('search_includesFilterWhenProvided', () => {
    service.search('budget', 5, 0.5, { filter: "cin_sourceId = 'alfresco:acs'" }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/search/semantic',
      jasmine.objectContaining({ query: 'budget', filter: "cin_sourceId = 'alfresco:acs'" })
    );
  });

  it('search_carriesAnUnstyledSourceTypeThroughUnchanged', () => {
    // The union is open (#16), so a CMIS or connector source type reaches the request as it stands.
    service.search('budget', 5, 0.5, { sourceType: 'sample-directory' }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/search/semantic',
      jasmine.objectContaining({ sourceType: 'sample-directory' })
    );
  });

  it('search_omitsTheDocumentBudgetUnlessAsked', () => {
    // #18's fields are opt-in: an untouched search must send exactly what it sent before, or every
    // existing result set changes.
    service.search('budget').subscribe();

    const body = httpSpy.post.calls.mostRecent().args[1];
    expect(body).toEqual({ query: 'budget', topK: 5, minScore: 0.5 });
  });

  it('search_includesTheDocumentBudgetWhenAsked', () => {
    service.search('budget', 5, 0.5, { topDocuments: 20, chunksPerDocument: 3 }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/search/semantic',
      jasmine.objectContaining({ topDocuments: 20, chunksPerDocument: 3 })
    );
  });

  it('getConnectors_returnsNullWhenNoUrlIsConfigured', () => {
    // /api/connectors is not a rag-service route and nothing proxies it, so with no URL configured the
    // status page must not guess one (#17).
    expect(service.connectorsConfigured).toBeFalse();
    expect(service.getConnectors()).toBeNull();
  });

  it('facets_postsToFacetsEndpoint', () => {
    service.facets({ property: 'cin_ingestProperties.mimeType', topN: 10 }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/search/facets',
      jasmine.objectContaining({ property: 'cin_ingestProperties.mimeType', topN: 10 })
    );
  });

  it('getStatus_getsStatusUrl', () => {
    service.getStatus().subscribe();
    expect(httpSpy.get).toHaveBeenCalledWith('/api/status');
  });

  it('prompt_passesInferFiltersAndResponseFormat', () => {
    service.prompt('q', { inferFilters: true, responseFormat: 'STRUCTURED' }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/prompt',
      jasmine.objectContaining({ inferFilters: true, responseFormat: 'STRUCTURED' })
    );
  });

  it('prompt_includesSourceTypeAlongsideNodeScopeFilter', () => {
    service.prompt('Summarize this file', {
      nodeId: 'node-123',
      sourceType: 'alfresco'
    }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/prompt',
      jasmine.objectContaining({
        question: 'Summarize this file',
        filter: "cin_id = 'node-123'",
        sourceType: 'alfresco'
      })
    );
  });

  it('prompt_pinsTheNodeScopeToItsSourceId', () => {
    service.prompt('Summarize this file', {
      nodeId: 'node-123',
      nodeSourceId: 'alfresco:repo-main',
      sourceType: 'alfresco'
    }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/prompt',
      jasmine.objectContaining({
        filter: "(cin_sourceId = 'alfresco:repo-main') AND (cin_id = 'node-123')",
        sourceType: 'alfresco'
      })
    );
  });

  it('prompt_andsTheCallerFilterWithTheSourcePinnedNodeScope', () => {
    service.prompt('q', {
      nodeId: 'node-123',
      nodeSourceId: 'alfresco:repo-main',
      filter: "cin_ingestProperties.source_mimeType = 'application/pdf'"
    }).subscribe();

    expect(httpSpy.post).toHaveBeenCalledWith(
      '/api/rag/prompt',
      jasmine.objectContaining({
        filter: "(cin_ingestProperties.source_mimeType = 'application/pdf') AND "
          + "((cin_sourceId = 'alfresco:repo-main') AND (cin_id = 'node-123'))"
      })
    );
  });

  it('streamPrompt_emitsTokensInOrder', (done) => {
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: token\ndata: {"token":"Hel"}\n\n',
        'event: token\ndata: {"token":"lo"}\n\n',
        'event: metadata\ndata: {"answer":"Hello","question":"Q","model":"m","tokenCount":42,"searchTimeMs":1,"generationTimeMs":2,"totalTimeMs":3,"sourcesUsed":0,"sources":[]}\n\n',
        'event: done\ndata: {}\n\n'
      ])
    ));

    const events: RagPromptStreamEvent[] = [];
    service.streamPrompt('Q').subscribe({
      next: (event) => events.push(event),
      error: (error) => done.fail(error),
      complete: () => {
        expect(events.length).toBe(4);
        expect(events[0]).toEqual({ type: 'token', token: 'Hel' });
        expect(events[1]).toEqual({ type: 'token', token: 'lo' });
        expect(events[2].type).toBe('metadata');
        if (events[2].type === 'metadata') {
          expect(events[2].response.answer).toBe('Hello');
          expect(events[2].response.tokenCount).toBe(42);
        }
        expect(events[3]).toEqual({ type: 'done' });

        expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
        expect((globalThis as any).fetch).toHaveBeenCalledWith(
          '/api/rag/chat/stream',
          jasmine.objectContaining({ method: 'POST' })
        );
        done();
      }
    });
  });

  it('streamPrompt_carriesFaithfulnessAndStructuredFromMetadata', (done) => {
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: metadata\ndata: {"answer":"A","question":"Q","model":"m","searchTimeMs":1,"generationTimeMs":2,"totalTimeMs":3,"sourcesUsed":0,"sources":[],"verified":false,"unsupportedClaims":["c1"],"structured":{"summary":"s","keyPoints":["k"],"citations":[{"sourceName":"doc","quote":"q"}]}}\n\n',
        'event: done\ndata: {}\n\n'
      ])
    ));

    service.streamPrompt('Q').subscribe({
      next: (event) => {
        if (event.type === 'metadata') {
          expect(event.response.verified).toBeFalse();
          expect(event.response.unsupportedClaims).toEqual(['c1']);
          expect(event.response.structured?.summary).toBe('s');
          expect(event.response.structured?.keyPoints).toEqual(['k']);
          expect(event.response.structured?.citations?.[0].sourceName).toBe('doc');
        }
      },
      error: (error) => done.fail(error),
      complete: () => done()
    });
  });

  it('streamPrompt_emitsStructuredEventAfterMetadata', (done) => {
    // The server derives the typed view in a second pass, so it arrives after the sources.
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: token\ndata: {"token":"A"}\n\n',
        'event: metadata\ndata: {"answer":"A","question":"Q","model":"m","searchTimeMs":1,"generationTimeMs":2,"totalTimeMs":3,"sourcesUsed":1,"sources":[]}\n\n',
        'event: structured\ndata: {"summary":"s","keyPoints":["k1","k2"],"citations":[{"sourceName":"doc","quote":"q"}]}\n\n',
        'event: done\ndata: {}\n\n'
      ])
    ));

    const events: RagPromptStreamEvent[] = [];
    service.streamPrompt('Q').subscribe({
      next: (event) => events.push(event),
      error: (error) => done.fail(error),
      complete: () => {
        expect(events.map((event) => event.type)).toEqual(['token', 'metadata', 'structured', 'done']);
        const structuredEvent = events[2];
        if (structuredEvent.type === 'structured') {
          expect(structuredEvent.structured.summary).toBe('s');
          expect(structuredEvent.structured.keyPoints).toEqual(['k1', 'k2']);
          expect(structuredEvent.structured.citations).toEqual([{ sourceName: 'doc', quote: 'q' }]);
        }
        done();
      }
    });
  });

  it('streamPrompt_handlesErrorEvent', (done) => {
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: error\ndata: {"message":"stream exploded"}\n\n'
      ])
    ));

    service.streamPrompt('Q').subscribe({
      next: () => done.fail('Expected stream to fail'),
      error: (error) => {
        expect(String(error?.message ?? '')).toContain('stream exploded');
        done();
      },
      complete: () => done.fail('Expected error, got complete')
    });
  });

  it('streamPrompt_parsesCrLfDelimitedEvents', (done) => {
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: token\r\ndata: {"token":"Hi"}\r\n\r\n',
        'event: done\r\ndata: {}\r\n\r\n'
      ])
    ));

    const events: RagPromptStreamEvent[] = [];
    service.streamPrompt('Q').subscribe({
      next: (event) => events.push(event),
      error: (error) => done.fail(error),
      complete: () => {
        expect(events).toEqual([
          { type: 'token', token: 'Hi' },
          { type: 'done' }
        ]);
        done();
      }
    });
  });

  it('streamPrompt_attachesTicketHeaderUsingUiEncoding', (done) => {
    localStorage.setItem('ticket-ECM', '"TICKET_STREAM"');
    (globalThis as any).fetch = jasmine.createSpy('fetch').and.returnValue(Promise.resolve(
      createMockResponse([
        'event: done\ndata: {}\n\n'
      ])
    ));

    service.streamPrompt('Q').subscribe({
      next: () => undefined,
      error: (error) => done.fail(error),
      complete: () => {
        expect((globalThis as any).fetch).toHaveBeenCalledWith(
          '/api/rag/chat/stream',
          jasmine.objectContaining({
            headers: jasmine.objectContaining({
              Authorization: `Basic ${btoa('TICKET_STREAM:')}`
            })
          })
        );
        done();
      }
    });
  });
});

function createMockResponse(events: string[]): Response {
  let index = 0;
  const encoder = new TextEncoder();

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: () => {
          if (index >= events.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const value = encoder.encode(events[index++]);
          return Promise.resolve({ done: false, value });
        }
      })
    }
  } as unknown as Response;
}
