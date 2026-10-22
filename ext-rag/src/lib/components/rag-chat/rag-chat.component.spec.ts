import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ElementRef } from '@angular/core';
import { provideRouter } from '@angular/router';
import { DiscoveryApiService } from '@alfresco/adf-content-services';
import { AuthenticationService } from '@alfresco/adf-core';
import { Subject, of } from 'rxjs';

import { RagChatComponent } from './rag-chat.component';
import { RagApiService } from '../../services/rag-api.service';
import { RagChatSessionService } from '../../services/rag-chat-session.service';
import { RagPromptResponse, RagPromptStreamEvent, StatusResponse } from '../../models/rag.models';

describe('RagChatComponent', () => {
  let fixture: ComponentFixture<RagChatComponent>;
  let component: RagChatComponent;
  let ragApiSpy: jasmine.SpyObj<RagApiService>;
  let currentUser: string | null;
  let onLogout: Subject<any>;

  const promptResponse: RagPromptResponse = {
    answer: 'answer',
    question: 'question',
    sessionId: 'session-from-backend',
    model: 'model',
    tokenCount: 128,
    searchTimeMs: 5,
    generationTimeMs: 6,
    totalTimeMs: 11,
    sourcesUsed: 0,
    sources: []
  };

  beforeEach(async () => {
    sessionStorage.clear();
    currentUser = 'alice';
    onLogout = new Subject<any>();
    ragApiSpy = jasmine.createSpyObj<RagApiService>(
      'RagApiService', ['prompt', 'streamPrompt', 'getSessionSummary', 'getStatus']);
    ragApiSpy.prompt.and.returnValue(of(promptResponse));
    ragApiSpy.getSessionSummary.and.returnValue(of({ sessionId: 'session-from-backend', summary: '' }));
    // The source filter's options come from /api/status (#16).
    ragApiSpy.getStatus.and.returnValue(of({
      hxprStatus: 'UP',
      totalDocuments: 0,
      sourceCounts: {},
      embeddingModel: { status: 'UP' }
    } as StatusResponse));
    ragApiSpy.streamPrompt.and.returnValue(of(
      { type: 'metadata', response: promptResponse } as RagPromptStreamEvent,
      { type: 'done' } as RagPromptStreamEvent
    ));

    await TestBed.configureTestingModule({
      imports: [RagChatComponent],
      providers: [
        RagChatSessionService,
        provideRouter([]),
        {
          provide: AuthenticationService,
          useValue: {
            onLogout,
            isLoggedIn: () => currentUser !== null,
            getUsername: () => currentUser
          }
        },
        {
          provide: RagApiService,
          useValue: ragApiSpy
        },
        {
          provide: DiscoveryApiService,
          useValue: {
            getEcmProductInfo: () => of({ id: 'repo-main' })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(RagChatComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('newConversation_clearsMessages', () => {
    component.messages = [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date() }
    ];
    (component as any).persistMessages();

    component.newConversation();

    expect(component.messages).toEqual([]);
    expect(component.activeSessionId).toBeTruthy();
    expect(component.sessionSummaries.length).toBeGreaterThan(0);
    expect(component.sessionSummaries[0].messageCount).toBe(0);
  });

  it('backendSessionId_migratesInPlaceWithoutOrphan', () => {
    const sessions = TestBed.inject(RagChatSessionService);
    component.currentQuestion = 'Hello';

    component.ask();

    const summaries = sessions.listSessions();
    expect(summaries.length).toBe(1);
    expect(summaries[0].sessionId).toBe('session-from-backend');
    expect(component.activeSessionId).toBe('session-from-backend');
  });

  it('logout_clearsMessagesAndAbortsInflightAnswer', () => {
    const sessions = TestBed.inject(RagChatSessionService);
    const stream = new Subject<RagPromptStreamEvent>();
    ragApiSpy.streamPrompt.and.returnValue(stream.asObservable());
    component.currentQuestion = 'Secret question';
    component.ask();

    currentUser = null;
    onLogout.next(true);
    currentUser = 'bob';
    stream.next({ type: 'token', token: 'late token' } as RagPromptStreamEvent);

    expect(stream.observed).toBeFalse();
    expect(component.messages).toEqual([]);
    expect(component.thinking).toBeFalse();
    expect(sessions.listSessions()).toEqual([]);
  });

  it('interruptedLoadingMessage_isHealedOnReopen', () => {
    const sessionId = component.activeSessionId as string;
    const sessions = TestBed.inject(RagChatSessionService);
    sessions.saveMessages(sessionId, [
      { id: 'u1', role: 'user', content: 'Hi', timestamp: new Date() },
      { id: 'a1', role: 'assistant', content: '', timestamp: new Date(), loading: true }
    ]);

    (component as any).initializeConversationState();

    const assistant = component.messages.find((m) => m.role === 'assistant');
    expect(assistant?.loading).toBeFalsy();
    expect(assistant?.error).toContain('interrupted');
  });

  it('sessionScope_passesNodeIdToService', () => {
    component.scopedNodeId = 'node-123';
    component.currentQuestion = 'What is this?';

    component.ask();

    expect(ragApiSpy.streamPrompt).toHaveBeenCalledWith(
      'What is this?',
      jasmine.objectContaining({
        nodeId: 'node-123',
        nodeSourceId: 'alfresco:repo-main',
        sourceType: 'alfresco',
        sessionId: jasmine.any(String),
        resetSession: true
      })
    );
    // The service builds the source clause next to `cin_id`; repeating it in `filter` would double it.
    expect(ragApiSpy.streamPrompt.calls.mostRecent().args[1]).not.toEqual(
      jasmine.objectContaining({ filter: jasmine.anything() }));
  });

  it('sessionScope_fallsBackToTheAlfrescoTypeWhileTheRepositoryIsUnknown', () => {
    component.currentRepositoryId = null;
    component.scopedNodeId = 'node-123';
    component.currentQuestion = 'What is this?';

    component.ask();

    const options = ragApiSpy.streamPrompt.calls.mostRecent().args[1] as Record<string, unknown>;
    expect(options['nodeId']).toBe('node-123');
    expect(options['sourceType']).toBe('alfresco');
    expect(options['nodeSourceId']).toBeUndefined();
    expect(options['filter']).toBeUndefined();
  });

  it('displaySourceKey_showsTheTypeWithOneAlfrescoSource', () => {
    component.sourceOptions = [
      { key: 'alfresco', level: 'type', sourceType: 'alfresco', label: 'Alfresco',
        sourceKeys: ['alfresco:repo-main'], count: 3 }
    ];
    component.scopedNodeId = 'node-123';

    expect(component.displaySourceKey()).toBe('alfresco');
  });

  it('displaySourceKey_showsThisRepositoryWhenTheIndexHoldsTwoAlfrescoSources', () => {
    component.sourceOptions = [
      { key: 'alfresco', level: 'type', sourceType: 'alfresco', label: 'Alfresco',
        sourceKeys: ['alfresco:repo-main', 'alfresco:repo-other'], count: 5 },
      { key: 'alfresco:repo-main', level: 'id', sourceType: 'alfresco', sourceId: 'repo-main',
        label: 'Alfresco (repo-main)', sourceKeys: ['alfresco:repo-main'], count: 3 },
      { key: 'alfresco:repo-other', level: 'id', sourceType: 'alfresco', sourceId: 'repo-other',
        label: 'Alfresco (repo-other)', sourceKeys: ['alfresco:repo-other'], count: 2 }
    ];
    component.scopedNodeId = 'node-123';

    expect(component.displaySourceKey()).toBe('alfresco:repo-main');
  });

  it('openSourceLabel_namesTheRepositoryOfAnotherAlfrescoSource', () => {
    const doc = {
      nodeId: 'node-123',
      sourceId: 'alfresco:repo-other',
      sourceType: 'alfresco',
      name: 'Budget.xlsx',
      path: '/Company Home',
      score: 0.9,
      chunks: [],
      openInSourceUrl: 'http://other/share/page/document-details?nodeRef=workspace://SpacesStore/node-123'
    };

    expect(component.canOpenInRepository(doc)).toBeFalse();
    expect(component.openLinkHint(doc)).toBe('Open in Alfresco (repo-other)');
  });

  it('folderScope_buildsPathPrefixFilter', () => {
    component.scopedNodeId = 'folder-123';
    component.scopedNodeName = 'Finance';
    component.scopedNodeIsFolder = true;
    component.scopedNodePath = '/Company Home/Sites/finance/documentLibrary';
    component.currentQuestion = 'Summarize this folder';

    component.ask();

    expect(ragApiSpy.streamPrompt).toHaveBeenCalledWith(
      'Summarize this folder',
      jasmine.objectContaining({
        sourceType: 'alfresco',
        filter: "(cin_sourceId = 'alfresco:repo-main') AND (cin_ingestProperties.source_path >= '/Company Home/Sites/finance/documentLibrary' AND cin_ingestProperties.source_path < '/Company Home/Sites/finance/documentLibrary\uFFFF')"
      })
    );
  });

  it('canOpenInRepository_matchesNamespacedCurrentAlfrescoSource', () => {
    expect(component.canOpenInRepository({
      nodeId: 'node-123',
      sourceId: 'alfresco:repo-main',
      sourceType: 'alfresco',
      name: 'Budget.xlsx',
      path: '/Company Home/Sites/finance/documentLibrary',
      score: 0.92,
      chunks: []
    })).toBeTrue();
  });

  it('canOpenInSource_returnsTrueForExternalMixedSourceResults', () => {
    expect(component.canOpenInSource({
      nodeId: 'doc-789',
      sourceId: 'nuxeo:nuxeo-demo',
      sourceType: 'nuxeo',
      name: 'Quarterly Report.pdf',
      path: '/default-domain/workspaces/finance',
      score: 0.88,
      chunks: [],
      openInSourceUrl: 'http://localhost:8081/nuxeo/ui/#!/browse/default-domain/workspaces/finance/Quarterly%20Report.pdf'
    })).toBeTrue();
  });

  it('autoScroll_triggersOnNewMessage', () => {
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'scrollHeight', { value: 500, writable: true });
    Object.defineProperty(scrollHost, 'clientHeight', { value: 100, writable: true });
    scrollHost.scrollTop = 460;
    (component as any).messagesContainer = new ElementRef(scrollHost);

    const scrollSpy = spyOn<any>(component, 'scrollToBottom').and.callThrough();
    component.currentQuestion = 'Trigger scroll';

    component.ask();
    component.ngAfterViewChecked();

    expect(scrollSpy).toHaveBeenCalled();
  });

  it('assistantAnswer_keepsMarkdownFromMetadataResponseSoItCanBeRendered', () => {
    const answer = '## LDAP setup\n**Define** _chain_ and [restart](https://example.com)\n- check properties';
    ragApiSpy.streamPrompt.and.returnValue(of(
      { type: 'metadata', response: { ...promptResponse, answer } } as RagPromptStreamEvent,
      { type: 'done' } as RagPromptStreamEvent
    ));

    component.currentQuestion = 'How do I configure LDAP?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    // Held verbatim: the template renders it with <markdown>. Stripping it here is what made every
    // heading, list and generated table arrive as flat text.
    expect(assistant?.content).toBe(answer);
    // The streaming mirror has done its job by now and must not linger, or the finished answer would
    // keep rendering as plain text.
    expect(assistant?.streamPreview).toBeUndefined();
  });

  it('assistantAnswer_showsAStrippedMirrorWhileStreamingAndKeepsTheMarkdown', () => {
    ragApiSpy.streamPrompt.and.returnValue(of(
      { type: 'token', token: '**Define** _chain_' } as RagPromptStreamEvent,
      { type: 'token', token: '\n- check properties' } as RagPromptStreamEvent
    ));

    component.currentQuestion = 'How do I configure LDAP?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    // Accumulated raw, so the completed answer renders as markdown without a second request.
    expect(assistant?.content).toBe('**Define** _chain_\n- check properties');
    // Shown stripped until then: a half-open emphasis or a one-row table renders badly and reflows.
    expect(assistant?.streamPreview).toBe('Define chain\n- check properties');
  });

  it('structuredMode_rendersSourcesFirstThenFillsTheStructuredBlock', () => {
    component.structuredMode = true;
    ragApiSpy.streamPrompt.and.returnValue(of(
      {
        type: 'metadata',
        response: {
          ...promptResponse,
          sourcesUsed: 1,
          sources: [
            {
              documentId: 'doc-1', nodeId: 'doc-1', name: 'Alice.docx', path: '/x',
              chunkText: 'a chunk', score: 0.9
            } as any
          ],
          structured: undefined
        }
      } as RagPromptStreamEvent,
      {
        type: 'structured',
        structured: { summary: 's', keyPoints: ['k'], citations: [{ sourceName: 'Alice.docx', quote: 'q' }] }
      } as RagPromptStreamEvent,
      { type: 'done' } as RagPromptStreamEvent
    ));

    component.currentQuestion = 'What is a bat?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    expect(assistant?.sources?.length).toBe(1);
    expect(assistant?.structured?.summary).toBe('s');
    // The placeholder is cleared once the second pass lands.
    expect(assistant?.structuredPending).toBeFalse();
  });

  it('structuredMode_marksTheStructuredBlockPendingUntilItArrives', () => {
    component.structuredMode = true;
    ragApiSpy.streamPrompt.and.returnValue(of(
      {
        type: 'metadata',
        response: {
          ...promptResponse,
          sourcesUsed: 1,
          sources: [{ documentId: 'd', nodeId: 'd', name: 'n', path: '/p', chunkText: 'c', score: 1 } as any],
          structured: undefined
        }
      } as RagPromptStreamEvent
    ));

    component.currentQuestion = 'What is a bat?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    expect(assistant?.structuredPending).toBeTrue();
    expect(assistant?.structured).toBeUndefined();
  });

  it('assistantAnswer_mapsTokenCountFromMetadata', () => {
    component.currentQuestion = 'How many tokens?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    expect(assistant?.tokenCount).toBe(128);
  });

  it('assistantAnswer_preservesSourceAwareLinksInMergedSources', () => {
    ragApiSpy.streamPrompt.and.returnValue(of(
      {
        type: 'metadata',
        response: {
          ...promptResponse,
          sourcesUsed: 1,
          sources: [
            {
              documentId: 'doc-789',
              nodeId: 'doc-789',
              sourceId: 'nuxeo:nuxeo-demo',
              sourceType: 'nuxeo',
              name: 'Quarterly Report.pdf',
              path: '/default-domain/workspaces/finance',
              chunkText: 'Revenue increased by 12%.',
              score: 0.88,
              openInSourceUrl: 'http://localhost:8081/nuxeo/ui/#!/browse/default-domain/workspaces/finance/Quarterly%20Report.pdf'
            }
          ]
        }
      } as RagPromptStreamEvent,
      { type: 'done' } as RagPromptStreamEvent
    ));

    component.currentQuestion = 'What changed in finance?';
    component.ask();

    const assistant = component.messages.find((message) => message.role === 'assistant');
    expect(assistant?.sources?.[0].sourceType).toBe('nuxeo');
    expect(assistant?.sources?.[0].openInSourceUrl).toContain('/nuxeo/ui/#!/browse/');
  });
});
