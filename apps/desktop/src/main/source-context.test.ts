import { expect, test } from 'bun:test';
import type { SourceRecord } from '@prospero/core';
import { sourceCatalogForContext, SOURCE_CATALOG_CONTEXT_BYTES } from './source-context';

test('large retained URLs cannot make the pinned source catalog unbounded; newest complete provenance stays', () => {
  const sources: SourceRecord[] = Array.from({ length: 50 }, (_, index) => ({
    id: `src_${index.toString(16).padStart(24, '0')}`,
    url: `https://source.acceptance.example/${index}/${'x'.repeat(7900)}`,
    title: `Synthetic source ${index}`,
    kind: 'page',
    retrievedAt: 1791070000000,
    contentHash: 'd'.repeat(64),
    excerpt: 'SESSION_ONLY_EXCERPT_MUST_NOT_BE_CONTEXT_PINNED',
  }));
  const before = JSON.stringify(sources);
  const catalog = sourceCatalogForContext(sources);
  expect(Buffer.byteLength(JSON.stringify(catalog), 'utf8')).toBeLessThanOrEqual(
    SOURCE_CATALOG_CONTEXT_BYTES,
  );
  expect(catalog.sources.length).toBeGreaterThan(0);
  expect(catalog.sources.length + catalog.omittedEarlierSources).toBe(50);
  expect(catalog.sources.at(-1)?.id).toBe(sources.at(-1)?.id);
  for (const entry of catalog.sources) {
    const source = sources.find((value) => value.id === entry.id);
    if (!source) throw new Error('Context contained a fabricated source.');
    expect(entry.url).toBe(source.url);
    expect(entry.contentHash).toBe(source.contentHash);
  }
  expect(JSON.stringify(catalog)).not.toContain('SESSION_ONLY_EXCERPT');
  expect(catalog.metadataOnly).toBe(true);
  expect(catalog.sourceBodyRestored).toBe(false);
  expect(JSON.stringify(sources)).toBe(before);
});
