import { openInSourceLabel, sourceKeyLabel, sourceTypeLabel, splitSourceKey } from './source-label.util';

describe('source-label.util', () => {

  it('labelsAKnownTypeByNameAndDeslugsAnUnknownOne', () => {
    expect(sourceTypeLabel('alfresco')).toBe('Alfresco');
    expect(sourceTypeLabel('nuxeo')).toBe('Nuxeo');
    expect(sourceTypeLabel('cmis')).toBe('CMIS');
    expect(sourceTypeLabel('sharepoint')).toBe('SharePoint');

    // 'Sample-directory' is what a titlecase pipe produces, and is the label issue #16 objects to.
    expect(sourceTypeLabel('sample-directory')).toBe('Sample Directory');
    expect(sourceTypeLabel('acme_vault')).toBe('Acme Vault');
  });

  it('keepsTheOldFallbackWordingForAnAbsentType', () => {
    // Both components rendered 'source system' in an "Open in ..." hint; that reads correctly still.
    expect(sourceTypeLabel(undefined)).toBe('source system');
    expect(sourceTypeLabel('')).toBe('source system');
  });

  it('isCaseAndWhitespaceInsensitiveAboutTheType', () => {
    expect(sourceTypeLabel(' Nuxeo ')).toBe('Nuxeo');
    expect(sourceTypeLabel('CMIS')).toBe('CMIS');
  });

  it('splitsASourceKeyOnTheFirstColonOnly', () => {
    expect(splitSourceKey('alfresco:abc-uuid')).toEqual({ sourceType: 'alfresco', sourceId: 'abc-uuid' });

    // A source id may itself contain a colon; only the first separates type from id.
    expect(splitSourceKey('cmis:http://host:8080/repo'))
      .toEqual({ sourceType: 'cmis', sourceId: 'http://host:8080/repo' });

    expect(splitSourceKey('filesystem')).toEqual({ sourceType: 'filesystem', sourceId: '' });
  });

  it('namesASourceByItsIdSoTwoOfATypeAreDistinguishable', () => {
    expect(sourceKeyLabel('cmis:docmgr')).toBe('CMIS (docmgr)');
    expect(sourceKeyLabel('cmis:archive')).toBe('CMIS (archive)');
    expect(sourceKeyLabel('nuxeo')).toBe('Nuxeo');
  });

  it('namesTheRepositoryOnlyForAnotherSourceOfTheOwnType', () => {
    const own = 'alfresco:repo-main';
    expect(openInSourceLabel({ sourceType: 'alfresco', sourceId: 'alfresco:repo-other' }, own))
      .toBe('Alfresco (repo-other)');
    expect(openInSourceLabel({ sourceType: 'alfresco', sourceId: own }, own)).toBe('Alfresco');
    expect(openInSourceLabel({ sourceType: 'nuxeo', sourceId: 'nuxeo:nuxeo-demo' }, own)).toBe('Nuxeo');
    expect(openInSourceLabel({ sourceType: 'alfresco', sourceId: 'alfresco:repo-other' }, null)).toBe('Alfresco');
  });
});
