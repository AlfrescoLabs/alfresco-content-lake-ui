import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';

import { ContentLakeStatusBadgeComponent } from './content-lake-status-badge.component';
import { ContentLakeStatusBatchService } from '../../services/content-lake-status-batch.service';
import { ContentLakeNodeStatus } from '../../models/rag.models';

describe('ContentLakeStatusBadgeComponent', () => {
  let component: ContentLakeStatusBadgeComponent;
  let batchServiceSpy: jasmine.SpyObj<ContentLakeStatusBatchService>;
  let changes: Subject<void>;

  const status = (overrides: Partial<ContentLakeNodeStatus>): ContentLakeNodeStatus => ({
    nodeId: 'n',
    status: null,
    exists: true,
    folder: false,
    inScope: false,
    excluded: false,
    error: null,
    ...overrides
  });

  beforeEach(async () => {
    changes = new Subject<void>();
    batchServiceSpy = jasmine.createSpyObj<ContentLakeStatusBatchService>(
      'ContentLakeStatusBatchService',
      ['getNodeStatus'],
      { changes$: changes.asObservable() }
    );

    await TestBed.configureTestingModule({
      imports: [ContentLakeStatusBadgeComponent],
      providers: [
        { provide: ContentLakeStatusBatchService, useValue: batchServiceSpy }
      ]
    }).compileComponents();

    component = TestBed.createComponent(ContentLakeStatusBadgeComponent).componentInstance;
  });

  it('folderInScope_resolvesScopeFromServerAndShows', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'folder-1', folder: true, inScope: true })));
    component.data = { node: { id: 'folder-1', isFolder: true, isFile: false } as any };
    component.ngOnChanges();

    expect(batchServiceSpy.getNodeStatus).toHaveBeenCalledWith('folder-1');
    expect(component.visible).toBeTrue();
    expect(component.statusIcon).toBe('check_circle');
    expect(component.statusClass).toBe('ext-rag-status-badge--in-scope');
    expect(component.statusTooltip).toBe('Content Lake: In scope');
  });

  it('folderExcluded_showsExcludedIndicator', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'folder-2', folder: true, excluded: true })));
    component.data = { node: { id: 'folder-2', isFolder: true, isFile: false } as any };
    component.ngOnChanges();

    expect(component.visible).toBeTrue();
    expect(component.statusIcon).toBe('block');
    expect(component.statusTooltip).toBe('Content Lake: Excluded');
  });

  it('folderOutOfScope_hidesBadge', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'folder-3', folder: true, inScope: false, excluded: false })));
    component.data = { node: { id: 'folder-3', isFolder: true, isFile: false } as any };
    component.ngOnChanges();

    expect(batchServiceSpy.getNodeStatus).toHaveBeenCalledWith('folder-3');
    expect(component.visible).toBeFalse();
  });

  it('fileInScope_usesServerStatusAndShows', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'file-1', inScope: true, status: 'FAILED', error: 'parse error' })));
    component.data = { node: { id: 'file-1', isFolder: false, isFile: true } as any };
    component.ngOnChanges();

    expect(batchServiceSpy.getNodeStatus).toHaveBeenCalledWith('file-1');
    expect(component.visible).toBeTrue();
    expect(component.statusIcon).toBe('error');
    expect(component.statusTooltip).toBe('Content Lake status: Error (parse error)');
  });

  it('fileSkipped_readsAsSkippedNotError', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({
      nodeId: 'file-2',
      inScope: true,
      status: 'SKIPPED',
      error: 'Content not read, because its extension .p7s cannot contain text'
    })));
    component.data = { node: { id: 'file-2', isFolder: false, isFile: true } as any };
    component.ngOnChanges();

    // A skip is not a failure: it must not render the error icon or read as an error.
    expect(component.statusIcon).toBe('do_not_disturb_on');
    expect(component.statusClass).toBe('ext-rag-status-badge--skipped');
    expect(component.statusTooltip).toBe(
      'Content Lake status: Skipped (Content not read, because its extension .p7s cannot contain text)'
    );
  });

  it('fileOutOfScope_hidesBadge', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'file-2', inScope: false })));
    component.data = { node: { id: 'file-2', isFolder: false, isFile: true } as any };
    component.ngOnChanges();

    expect(component.visible).toBeFalse();
  });

  it('missingServerStatus_hidesBadge', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(null));
    component.data = { node: { id: 'file-3', isFolder: false, isFile: true } as any };
    component.ngOnChanges();

    expect(component.visible).toBeFalse();
  });

  it('statusInvalidated_refetchesWithoutRowDataChange', () => {
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'file-4', inScope: false })));
    component.data = { node: { id: 'file-4', isFolder: false, isFile: true } as any };
    component.ngOnChanges();
    expect(component.visible).toBeFalse();

    // Ingestion has since picked the document up; the row data itself never changes.
    batchServiceSpy.getNodeStatus.and.returnValue(of(status({ nodeId: 'file-4', inScope: true, status: 'INDEXED' })));
    changes.next();

    expect(batchServiceSpy.getNodeStatus).toHaveBeenCalledTimes(2);
    expect(component.visible).toBeTrue();
    expect(component.statusIcon).toBe('check_circle');
  });

  it('nonFileOrFolder_hidesBadgeWithoutServerCall', () => {
    component.data = { node: { id: 'node-1', isFolder: false, isFile: false } as any };
    component.ngOnChanges();

    expect(batchServiceSpy.getNodeStatus).not.toHaveBeenCalled();
    expect(component.visible).toBeFalse();
  });
});
