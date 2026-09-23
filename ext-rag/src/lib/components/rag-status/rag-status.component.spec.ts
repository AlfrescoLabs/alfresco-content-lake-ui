import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { RagStatusComponent } from './rag-status.component';
import { RagApiService } from '../../services/rag-api.service';
import { StatusResponse } from '../../models/rag.models';

describe('RagStatusComponent', () => {
  let fixture: ComponentFixture<RagStatusComponent>;
  let component: RagStatusComponent;
  let ragApiSpy: jasmine.SpyObj<RagApiService>;

  const status: StatusResponse = {
    hxprStatus: 'UP',
    totalDocuments: 42,
    sourceCounts: { 'alfresco:acs': 30, 'nuxeo:demo': 12 },
    embeddingModel: { status: 'UP', url: 'http://model:12434' }
  };

  beforeEach(async () => {
    ragApiSpy = jasmine.createSpyObj<RagApiService>('RagApiService', ['getStatus', 'getConnectors']);
    // No connectors URL configured, which is the default: the panel is absent (#17).
    (ragApiSpy as any).connectorsConfigured = false;
    ragApiSpy.getConnectors.and.returnValue(null);
    await TestBed.configureTestingModule({
      imports: [RagStatusComponent],
      providers: [{ provide: RagApiService, useValue: ragApiSpy }]
    }).compileComponents();
    fixture = TestBed.createComponent(RagStatusComponent);
    component = fixture.componentInstance;
  });

  it('loads the status snapshot on init and sorts sources by count', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    component.ngOnInit();

    expect(ragApiSpy.getStatus).toHaveBeenCalled();
    expect(component.status?.totalDocuments).toBe(42);
    expect(component.loading).toBeFalse();
    expect(component.sourceEntries.map((e) => e.key)).toEqual(['alfresco:acs', 'nuxeo:demo']);
    expect(component.isUp('UP')).toBeTrue();
    expect(component.isUp('DOWN')).toBeFalse();
  });

  /**
   * The platform tile's label, asserted against the rendered DOM in the host workspace.
   *
   * This could not be checked until the bundle compiled here at all, which is what #22 blocked. The full phrase
   * is what a trademark is registered for, so the bare word must not appear on its own anywhere in the rendered
   * output.
   */
  it('labelsThePlatformTileWithTheFullProductNameAndNeverTheBareWord', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    component.ngOnInit();
    fixture.detectChanges();

    const rendered: string = fixture.nativeElement.textContent;
    expect(rendered).toContain('Hyland OpenArch');
    // No occurrence of "OpenArch" that is not preceded by "Hyland ".
    expect(rendered.replace(/Hyland OpenArch/g, '')).not.toContain('OpenArch');
  });

  /** `hxprStatus` is the wire field name and stays bound; only the label moved. */
  it('stillBindsTheHxprStatusFieldItAlwaysDid', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    component.ngOnInit();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('UP');
    expect(component.status?.hxprStatus).toBe('UP');
  });

  it('labelsEachSourceRatherThanShowingTheRawKey', () => {
    ragApiSpy.getStatus.and.returnValue(of({
      ...status,
      sourceCounts: { 'cmis:docmgr': 9, 'sample-directory:local': 1 }
    }));
    component.ngOnInit();

    expect(component.sourceEntries.map((e) => e.label)).toEqual(['CMIS', 'Sample Directory']);
    expect(component.sourceEntries.map((e) => e.sourceId)).toEqual(['docmgr', 'local']);
  });

  it('surfaces an error message when the status call fails', () => {
    ragApiSpy.getStatus.and.returnValue(throwError(() => ({ message: 'boom' })));
    component.refresh();

    expect(component.error).toBe('boom');
    expect(component.loading).toBeFalse();
    expect(component.status).toBeNull();
  });

  it('omitsTheConnectorPanelAndIssuesNoRequestWhenNoUrlIsConfigured', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    component.ngOnInit();

    expect(component.connectorsConfigured).toBeFalse();
    expect(component.connectors).toBeNull();
    expect(component.connectorsLoading).toBeFalse();
  });

  it('reportsLoadedConnectorsAndAnyThatFailedToLoad', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    ragApiSpy.getConnectors.and.returnValue(of({
      connectors: [{
        sourceType: 'sample-directory',
        displayName: 'Sample Directory',
        origin: '/opt/content-lake/connectors/sample.jar',
        implementation: 'org.hyland.example.connector.directory.DirectoryConnectorClient',
        settings: 2
      }],
      problems: ['broken.jar: no ConnectorPlugin service entry']
    }));
    (ragApiSpy as any).connectorsConfigured = true;
    component.refresh();

    expect(component.connectors?.connectors.length).toBe(1);
    // A jar that failed to load is the question this panel exists to answer, so it must not be dropped.
    expect(component.connectors?.problems).toEqual(['broken.jar: no ConnectorPlugin service entry']);
    expect(component.connectorsError).toBeNull();

    // Render it: the panel's markup is otherwise never compiled, since these specs are the only thing
    // that executes it.
    fixture.detectChanges();
  });

  it('keepsTheRestOfThePageWorkingWhenTheConnectorUrlIsUnreachable', () => {
    ragApiSpy.getStatus.and.returnValue(of(status));
    ragApiSpy.getConnectors.and.returnValue(throwError(() => ({ status: 0 })));
    component.refresh();

    expect(component.connectorsError).toBe('Cannot reach the configured connectors URL.');
    expect(component.status?.totalDocuments).toBe(42);
    expect(component.error).toBeNull();
  });
});
