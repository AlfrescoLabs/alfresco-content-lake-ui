/**
 * Naming a content source, wherever it came from (#16).
 *
 * `alfresco` and `nuxeo` are the two types this extension knows by name; anything else is de-slugged
 * from the type itself, which reads better than the raw value: `sample-directory` becomes
 * `Sample Directory`. Both the search and chat components used to switch on the two known types and
 * fall back to the literal string `'source system'`, in two separate copies.
 */

const TYPE_LABELS: Record<string, string> = {
  alfresco: 'Alfresco',
  nuxeo: 'Nuxeo',
  filesystem: 'Filesystem',
  cmis: 'CMIS',
  sharepoint: 'SharePoint'
};

/** Readable name for a source type, whether or not this build has heard of it. */
export function sourceTypeLabel(sourceType?: string): string {
  const type = normalizeType(sourceType);
  if (!type) {
    return 'source system';
  }
  return TYPE_LABELS[type] ?? deslug(type);
}

/**
 * Splits a stored `cin_sourceId` value. The type is everything before the first colon; the id keeps any
 * further colons, since only the first separates the two.
 */
export function splitSourceKey(key: string): { sourceType: string; sourceId: string } {
  const idx = (key ?? '').indexOf(':');
  if (idx < 0) {
    return { sourceType: normalizeType(key), sourceId: '' };
  }
  return { sourceType: normalizeType(key.slice(0, idx)), sourceId: key.slice(idx + 1) };
}

/**
 * Label for one `<sourceType>:<sourceId>` key. The id is what distinguishes two sources of the same
 * type, so it is shown when there is one: two CMIS repositories are both "CMIS".
 */
export function sourceKeyLabel(key?: string): string {
  if (!key) {
    return 'source system';
  }
  const { sourceType, sourceId } = splitSourceKey(key);
  const label = sourceTypeLabel(sourceType);
  return sourceId ? `${label} (${sourceId})` : label;
}

/**
 * Label for the system a hit opens in. A hit from another source of the same type as the UI's own
 * (another Alfresco repository, seen from ACA) is named by its key, so the link does not read as if it
 * opened in the repository the user is in. Every other hit is named by its type alone.
 */
export function openInSourceLabel(
  doc: { sourceType?: string; sourceId?: string },
  ownSourceKey?: string | null
): string {
  const key = doc?.sourceId;
  if (key && ownSourceKey && key !== ownSourceKey
      && splitSourceKey(key).sourceType === splitSourceKey(ownSourceKey).sourceType) {
    return sourceKeyLabel(key);
  }
  return sourceTypeLabel(doc?.sourceType);
}

function normalizeType(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function deslug(type: string): string {
  return type
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The source type of a hit, reading it off the qualified source id when the field is absent.
 *
 * Only the Alfresco and Nuxeo adapters put `source_type` on the document, so a hit from a connector
 * arrives carrying `documentId`, `nodeId` and `sourceId` alone. `sourceId` is the full
 * `<sourceType>:<sourceId>` value, which is where the type comes from in that case; without this, every
 * connector-sourced result is labelled as an unknown source.
 */
export function resolveSourceType(doc?: { sourceType?: string; sourceId?: string }): string | undefined {
  if (doc?.sourceType) {
    return doc.sourceType;
  }
  return splitSourceKey(doc?.sourceId ?? '').sourceType || undefined;
}
