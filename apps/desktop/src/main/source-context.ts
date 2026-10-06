import type { SourceRecord } from '@prospero/core';

export const SOURCE_CATALOG_CONTEXT_BYTES = 32 * 1024;
type Metadata = Pick<SourceRecord, 'id' | 'url' | 'title' | 'kind' | 'retrievedAt' | 'contentHash'>;

/** Keep complete, recent provenance records; omitted bodies/history never become authority. */
export function sourceCatalogForContext(sources: readonly SourceRecord[]) {
  const catalog: {
    metadataOnly: true;
    sourceBodyRestored: false;
    omittedEarlierSources: number;
    sources: Metadata[];
  } = {
    metadataOnly: true,
    sourceBodyRestored: false,
    omittedEarlierSources: sources.length,
    sources: [],
  };
  for (const { id, url, title, kind, retrievedAt, contentHash } of [...sources].reverse()) {
    const entry = { id, url, title, kind, retrievedAt, contentHash };
    const next = {
      ...catalog,
      omittedEarlierSources: catalog.omittedEarlierSources - 1,
      sources: [entry, ...catalog.sources],
    };
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > SOURCE_CATALOG_CONTEXT_BYTES) break;
    catalog.sources = next.sources;
    catalog.omittedEarlierSources = next.omittedEarlierSources;
  }
  return catalog;
}
