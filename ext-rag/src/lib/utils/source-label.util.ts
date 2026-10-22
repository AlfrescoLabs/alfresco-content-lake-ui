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

/** Docker-style short ids start this long and grow only until they are unique within the type. */
const SHORT_ID_MIN = 4;

/**
 * Label for one `<sourceType>:<sourceId>` key among the `keys` known beside it. The type label alone when
 * the type has one source; else the type label and a short id, the first four characters of the id
 * extended only until no other source of the type shares them: two CMIS repositories read
 * "CMIS (docm)" and "CMIS (arch)".
 */
export function sourceKeyLabel(key?: string, keys: readonly string[] = []): string {
  if (!key) {
    return 'source system';
  }
  const { sourceType, sourceId } = splitSourceKey(key);
  const label = sourceTypeLabel(sourceType);
  const ids = new Set([key, ...keys]
    .map((other) => splitSourceKey(other))
    .filter((other) => other.sourceType === sourceType && other.sourceId)
    .map((other) => other.sourceId));
  return sourceId && ids.size > 1 ? `${label} (${shortSourceId(sourceId, [...ids])})` : label;
}

/** The shortest prefix of `id`, at least four characters, that no other id in `ids` starts with. */
export function shortSourceId(id: string, ids: readonly string[]): string {
  const others = ids.filter((other) => other !== id);
  for (let length = SHORT_ID_MIN; length < id.length; length++) {
    const prefix = id.slice(0, length);
    if (!others.some((other) => other.startsWith(prefix))) {
      return prefix;
    }
  }
  return id;
}

/**
 * Label for the system a hit opens in. A hit from another source of the same type as the UI's own
 * (another Alfresco repository, seen from ACA) is named by a short id, so the link does not read as if it
 * opened in the repository the user is in. Every other hit is named by its type alone.
 */
export function openInSourceLabel(
  doc: { sourceType?: string; sourceId?: string },
  ownSourceKey?: string | null
): string {
  const key = doc?.sourceId;
  if (key && ownSourceKey && key !== ownSourceKey
      && splitSourceKey(key).sourceType === splitSourceKey(ownSourceKey).sourceType) {
    return sourceKeyLabel(key, [ownSourceKey]);
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
