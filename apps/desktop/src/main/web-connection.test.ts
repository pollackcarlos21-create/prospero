import { describe, expect, mock, test } from 'bun:test';
import { WebError, type WebClient, type WebErrorCode } from '@prospero/web';
import type { ConnectionResult } from '../bridge';
import { testWebSearchConnection } from './web-connection';

const key = 'offline-search-key';
function fixture(search: WebClient['search'] = async () => []) {
  const client: WebClient = {
    search: mock(search),
    fetchPage: mock(async () => {
      throw new Error('Page fetch is not part of a connection test');
    }),
  };
  const factory = mock((_apiKey: string) => client);
  return { client, factory };
}

describe('main-owned Web Search connection probe', () => {
  test('uses one fixed non-sensitive search and returns no sources or credential', async () => {
    const value = fixture(async () => [
      {
        id: 'private-source',
        url: 'https://example.com/private-result',
        title: 'private title',
        content: `private body ${key}`,
        excerpt: 'private excerpt',
        contentHash: 'private hash',
        retrievedAt: '2026-10-04T00:00:00Z',
        kind: 'search',
        trust: 'untrusted',
      },
    ]);
    const result = await testWebSearchConnection(key, value.factory);
    expect(result).toEqual({
      status: 'connected',
      message: 'Connected to Brave Search. The test used one search request.',
    });
    expect(value.factory).toHaveBeenCalledWith(key);
    expect(value.client.search).toHaveBeenCalledTimes(1);
    expect(value.client.search).toHaveBeenCalledWith('Prospero web search', {
      signal: expect.any(AbortSignal),
      maxResults: 1,
    });
    expect(value.client.fetchPage).not.toHaveBeenCalled();
    for (const marker of [key, 'private title', 'private-source', 'private body'])
      expect(JSON.stringify(result)).not.toContain(marker);
  });
  test('reports the selected Tavily provider using the same one-request probe', async () => {
    const value = fixture();
    expect(await testWebSearchConnection(key, value.factory, { provider: 'tavily' })).toEqual({
      status: 'connected',
      message: 'Connected to Tavily. The test used one search request.',
    });
    expect(value.client.search).toHaveBeenCalledTimes(1);
    expect(value.client.search).toHaveBeenCalledWith('Prospero web search', {
      signal: expect.any(AbortSignal),
      maxResults: 1,
    });
    const rejected = fixture(async () => {
      throw new WebError('auth');
    });
    expect(
      (await testWebSearchConnection(key, rejected.factory, { provider: 'tavily' })).message,
    ).toBe('The search credential was rejected. Enter or replace the Tavily key.');
  });
  test('empty search results still verify connectivity and missing or invalid keys never send a request', async () => {
    const value = fixture();
    expect((await testWebSearchConnection(key, value.factory)).status).toBe('connected');
    for (const invalid of ['', 'short', 'offline key', 'offline\nkey', 'x'.repeat(4097)])
      expect((await testWebSearchConnection(invalid, value.factory)).status).toBe('auth');
    expect(value.factory).toHaveBeenCalledTimes(1);
    expect(value.client.search).toHaveBeenCalledTimes(1);
  });
  const cases: [WebErrorCode, ConnectionResult['status']][] = [
    ['auth', 'auth'],
    ['rate-limit', 'rate-limit'],
    ['server', 'server'],
    ['incompatible', 'incompatible'],
    ['invalid-input', 'incompatible'],
    ['unsupported-content', 'incompatible'],
    ['too-large', 'incompatible'],
    ['blocked-url', 'network'],
    ['blocked-address', 'network'],
    ['redirect-limit', 'network'],
    ['http', 'network'],
    ['network', 'network'],
    ['timeout', 'timeout'],
    ['cancelled', 'cancelled'],
  ];
  for (const [code, status] of cases)
    test(`classifies ${code} without returning error bodies`, async () => {
      const value = fixture(async () => {
        const error = new WebError(code);
        error.message = `private server body ${key}`;
        throw error;
      });
      const result = await testWebSearchConnection(key, value.factory);
      expect(result.status).toBe(status);
      expect(result.message).not.toContain(key);
      expect(result.message).not.toContain('private server body');
      expect(value.client.search).toHaveBeenCalledTimes(1);
    });
  test('sanitizes factory and unexpected client failures', async () => {
    for (const factory of [
      () => {
        throw new Error(`private factory failure ${key}`);
      },
      fixture(async () => {
        throw new Error(`private transport failure ${key}`);
      }).factory,
    ]) {
      const result = await testWebSearchConnection(key, factory);
      expect(result.status).toBe('network');
      expect(result.message).not.toContain('private');
      expect(result.message).not.toContain(key);
    }
  });
  test('already cancelled probes do not construct a client', async () => {
    const value = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      (await testWebSearchConnection(key, value.factory, { signal: controller.signal })).status,
    ).toBe('cancelled');
    expect(value.factory).not.toHaveBeenCalled();
  });
  test('external cancellation aborts a running search even when the client ignores it', async () => {
    let started = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const value = fixture(async (_query, options) => {
      signal = options?.signal;
      started();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = testWebSearchConnection(key, value.factory, { signal: controller.signal });
    await began;
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(value.client.search).toHaveBeenCalledTimes(1);
  });
  test('finite deadline aborts the search and observes a later rejected request', async () => {
    let rejectLate = (_error: Error) => {};
    let signal: AbortSignal | undefined;
    const value = fixture(async (_query, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    });
    const result = await testWebSearchConnection(key, value.factory, { timeoutMs: 10 });
    expect(result.status).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    rejectLate(new Error(`late private body ${key}`));
    await Promise.resolve();
    expect(value.client.search).toHaveBeenCalledTimes(1);
  });
});
