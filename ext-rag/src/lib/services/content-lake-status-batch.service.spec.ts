import { fakeAsync, flushMicrotasks, tick, TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '@alfresco/adf-core';
import { of } from 'rxjs';

import { ContentLakeStatusBatchService } from './content-lake-status-batch.service';
import { ContentLakeNodeStatus } from '../models/rag.models';

describe('ContentLakeStatusBatchService', () => {
  let service: ContentLakeStatusBatchService;
  let httpSpy: jasmine.SpyObj<HttpClient>;

  beforeEach(() => {
    httpSpy = jasmine.createSpyObj<HttpClient>('HttpClient', ['post']);
    const appConfigSpy = jasmine.createSpyObj<AppConfigService>('AppConfigService', ['get']);
    appConfigSpy.get.and.callFake((key: string, defaultValue: any) => {
      const config: Record<string, string> = {
        'plugins.contentLakeService.baseUrl': '/api/content-lake'
      };
      return config[key] ?? defaultValue;
    });

    TestBed.configureTestingModule({
      providers: [
        ContentLakeStatusBatchService,
        { provide: HttpClient, useValue: httpSpy },
        { provide: AppConfigService, useValue: appConfigSpy }
      ]
    });

    service = TestBed.inject(ContentLakeStatusBatchService);
  });

  it('getNodeStatus_batchesWithoutFolderAggregate', fakeAsync(() => {
    const folderStatus: ContentLakeNodeStatus = {
      nodeId: 'folder-1',
      status: 'INDEXED',
      exists: true,
      folder: true,
      inScope: true,
      excluded: false,
      error: null
    };
    httpSpy.post.and.returnValue(of({ 'folder-1': folderStatus }));

    let observed: ContentLakeNodeStatus | null = null;
    service.getNodeStatus('folder-1').subscribe((status) => {
      observed = status;
    });

    flushMicrotasks();

    expect(httpSpy.post).toHaveBeenCalledWith('/api/content-lake/nodes/status', {
      nodeIds: ['folder-1']
    });
    expect(observed).toEqual(folderStatus);
  }));

  it('getNodeStatus_servesCachedResultWithoutSecondRequest', fakeAsync(() => {
    const fileStatus: ContentLakeNodeStatus = {
      nodeId: 'file-1', status: 'INDEXED', exists: true, folder: false,
      inScope: true, excluded: false, error: null
    };
    httpSpy.post.and.returnValue(of({ 'file-1': fileStatus }));

    service.getNodeStatus('file-1').subscribe();
    flushMicrotasks();
    expect(httpSpy.post).toHaveBeenCalledTimes(1);

    let observed: ContentLakeNodeStatus | null = null;
    service.getNodeStatus('file-1').subscribe((s) => { observed = s; });
    flushMicrotasks();

    expect(httpSpy.post).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(fileStatus);
  }));

  it('invalidate_forcesRefetchOnNextCall', fakeAsync(() => {
    const fileStatus: ContentLakeNodeStatus = {
      nodeId: 'file-1', status: 'INDEXED', exists: true, folder: false,
      inScope: true, excluded: false, error: null
    };
    httpSpy.post.and.returnValue(of({ 'file-1': fileStatus }));

    service.getNodeStatus('file-1').subscribe();
    flushMicrotasks();
    expect(httpSpy.post).toHaveBeenCalledTimes(1);

    service.invalidate('file-1');
    service.getNodeStatus('file-1').subscribe();
    flushMicrotasks();

    expect(httpSpy.post).toHaveBeenCalledTimes(2);
  }));

  it('invalidateAll_dropsEveryCachedNodeAndNotifies', fakeAsync(() => {
    const fileStatus: ContentLakeNodeStatus = {
      nodeId: 'file-1', status: 'INDEXED', exists: true, folder: false,
      inScope: true, excluded: false, error: null
    };
    httpSpy.post.and.returnValue(of({ 'file-1': fileStatus, 'file-2': fileStatus }));

    service.getNodeStatus('file-1').subscribe();
    service.getNodeStatus('file-2').subscribe();
    flushMicrotasks();
    expect(httpSpy.post).toHaveBeenCalledTimes(1);

    let notified = 0;
    service.changes$.subscribe(() => notified++);
    service.invalidateAll();

    service.getNodeStatus('file-1').subscribe();
    service.getNodeStatus('file-2').subscribe();
    flushMicrotasks();

    expect(notified).toBe(1);
    expect(httpSpy.post).toHaveBeenCalledTimes(2);
  }));

  it('startRefreshWindow_notifiesImmediatelyThenOnIntervalUntilTheWindowCloses', fakeAsync(() => {
    httpSpy.post.and.returnValue(of({}));

    let notified = 0;
    service.changes$.subscribe(() => notified++);

    service.startRefreshWindow();
    expect(notified).toBe(1);

    tick(5000);
    expect(notified).toBe(2);

    tick(5000);
    expect(notified).toBe(3);

    // Past the 60s window: whatever it reached, it stops there.
    tick(60000);
    const afterWindow = notified;
    expect(afterWindow).toBeGreaterThan(3);

    tick(60000);
    expect(notified).toBe(afterWindow);
  }));

  it('startRefreshWindow_restartsRatherThanStackingTimers', fakeAsync(() => {
    httpSpy.post.and.returnValue(of({}));

    let notified = 0;
    service.changes$.subscribe(() => notified++);

    service.startRefreshWindow();
    tick(2000);
    service.startRefreshWindow();
    expect(notified).toBe(2);

    tick(5000);
    expect(notified).toBe(3);

    service.stopRefreshWindow();
    tick(60000);
    expect(notified).toBe(3);
  }));

  it('getNodeStatusDetailed_sendsIncludeFolderAggregateFlag', () => {
    const folderStatus: ContentLakeNodeStatus = {
      nodeId: 'folder-1',
      status: 'INDEXED',
      exists: true,
      folder: true,
      inScope: true,
      excluded: false,
      error: null,
      folderSummary: {
        totalDocuments: 3,
        indexedDocuments: 3,
        pendingDocuments: 0,
        failedDocuments: 0,
        skippedDocuments: 0
      }
    };
    httpSpy.post.and.returnValue(of({ 'folder-1': folderStatus }));

    let observed: ContentLakeNodeStatus | null = null;
    service.getNodeStatusDetailed('folder-1').subscribe((status) => {
      observed = status;
    });

    expect(httpSpy.post).toHaveBeenCalledWith('/api/content-lake/nodes/status', {
      nodeIds: ['folder-1'],
      includeFolderAggregate: true
    });
    expect(observed).toEqual(folderStatus);
  });
});
