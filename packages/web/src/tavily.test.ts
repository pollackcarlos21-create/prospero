import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import {
  TAVILY_SEARCH_ENDPOINT,
  TavilyWebClient,
  WebError,
  resolveCitation,
  type WebDependencies,
  type WebTransportRequest,
  type WebTransportResponse,
} from './index';
import { createPinnedHttpsTransport } from './network';

const key = 'offline-tavily-test-key';
const address = Object.freeze({ address: '8.8.8.8', family: 4 as const });
const now = () => new Date('2026-10-06T06:00:00.000Z');
const result = {
  title: '<b>Public evidence</b>',
  url: 'https://example.org/article#section',
  content: 'A &amp; B from a public source.',
  raw_content: '<main>This is not fetched page evidence.</main>',
};
function response(
  body: string,
  status = 200,
  headers: Readonly<Record<string, string>> = { 'content-type': 'application/json' },
): WebTransportResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}
function searchResponse(results: readonly unknown[] = [result]) {
  return response(
    JSON.stringify({ results, answer: 'Never use a provider answer as page evidence.' }),
  );
}
function dependencies(
  handle: (input: WebTransportRequest) => WebTransportResponse | Promise<WebTransportResponse>,
): WebDependencies {
  return { resolve: async () => [address], transport: async (input) => handle(input), now };
}

describe('Tavily search adapter', () => {
  test('uses one fixed POST endpoint with bearer authentication and bounded basic discovery', async () => {
    let captured: WebTransportRequest | undefined;
    const receipts: number[] = [];
    const body = searchResponse();
    const client = new TavilyWebClient(
      { apiKey: key },
      dependencies((input) => {
        captured = input;
        return body;
      }),
    );
    const sources = await client.search('  公开 evidence  ', {
      maxResults: 3,
      maxResponseBytes: 1024,
      onResponseBytes: (bytes) => receipts.push(bytes),
    });
    expect(captured?.url.href).toBe(TAVILY_SEARCH_ENDPOINT);
    expect(captured?.method).toBe('POST');
    expect(captured?.headers.Authorization).toBe(`Bearer ${key}`);
    expect(captured?.headers['Content-Type']).toBe('application/json');
    expect(captured?.headers['Content-Length']).toBe(String(captured?.body?.byteLength));
    expect(captured?.maxBytes).toBe(1024);
    expect(JSON.parse(new TextDecoder().decode(captured?.body))).toEqual({
      query: '公开 evidence',
      search_depth: 'basic',
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
    });
    expect(new TextDecoder().decode(captured?.body)).not.toContain(key);
    expect(receipts).toEqual([body.body.byteLength]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      url: 'https://example.org/article',
      title: 'Public evidence',
      content: 'A & B from a public source.',
      kind: 'search',
      trust: 'untrusted',
      retrievedAt: now().toISOString(),
    });
    expect(Object.isFrozen(sources)).toBe(true);
    expect(Object.isFrozen(sources[0])).toBe(true);
    expect(JSON.stringify(sources)).not.toContain('fetched page evidence');
    expect(JSON.stringify(sources)).not.toContain('provider answer');
    expect(resolveCitation(sources[0].id, sources)).toMatchObject({
      url: 'https://example.org/article',
      sourceId: sources[0].id,
      contentHash: sources[0].contentHash,
    });
  });

  test('drops unsafe results and deduplicates canonical URLs without upgrading HTTP', async () => {
    const client = new TavilyWebClient(
      { apiKey: key },
      dependencies(() =>
        searchResponse([
          { ...result, url: 'http://example.org/article' },
          { ...result, url: 'https://127.0.0.1/article' },
          { ...result, url: 'https://example.internal/article' },
          result,
          { ...result, url: 'https://example.org/article#duplicate' },
          { ...result, url: 'https://example.net/second' },
          { ...result, url: 'https://example.net/third' },
        ]),
      ),
    );
    expect(
      (await client.search('evidence', { maxResults: 2 })).map((source) => source.url),
    ).toEqual(['https://example.org/article', 'https://example.net/second']);
  });

  test('never follows search redirects or forwards authentication to their destination', async () => {
    const captured: WebTransportRequest[] = [];
    const client = new TavilyWebClient(
      { apiKey: key },
      dependencies((input) => {
        captured.push(input);
        return response('', 307, { location: 'https://example.net/credential-target' });
      }),
    );
    await expect(client.search('evidence')).rejects.toMatchObject({ code: 'http' });
    expect(captured).toHaveLength(1);
    expect(captured[0].url.href).toBe(TAVILY_SEARCH_ENDPOINT);
  });

  test('validates query/count/key before resolving DNS or making HTTP requests', async () => {
    let requests = 0;
    let resolutions = 0;
    const deps = {
      ...dependencies(() => {
        requests++;
        return searchResponse();
      }),
      resolve: async () => {
        resolutions++;
        return [address];
      },
    };
    const client = new TavilyWebClient({ apiKey: key }, deps);
    for (const query of ['', ' ', 'x'.repeat(601), Array(76).fill('word').join(' '), 'foo\nbar'])
      await expect(client.search(query)).rejects.toMatchObject({ code: 'invalid-input' });
    for (const maxResults of [0, 21, 1.5, Number.NaN])
      await expect(client.search('test', { maxResults })).rejects.toMatchObject({
        code: 'invalid-input',
      });
    await expect(new TavilyWebClient({}, deps).search('test')).rejects.toMatchObject({
      code: 'auth',
    });
    expect(() => new TavilyWebClient({ apiKey: 'token\r\nHeader: leak' })).toThrow(WebError);
    expect(requests).toBe(0);
    expect(resolutions).toBe(0);
  });

  test('rejects mixed public/private DNS results before a credential-bearing POST', async () => {
    let requests = 0;
    const client = new TavilyWebClient(
      { apiKey: key },
      {
        ...dependencies(() => {
          requests++;
          return searchResponse();
        }),
        resolve: async () => [address, { address: '198.18.0.1', family: 4 }],
      },
    );
    await expect(client.search('evidence')).rejects.toMatchObject({ code: 'blocked-address' });
    expect(requests).toBe(0);
  });

  test('maps provider errors to fixed safe messages without reflecting error bodies or keys', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate-limit'],
      [432, 'rate-limit'],
      [433, 'rate-limit'],
      [500, 'server'],
      [422, 'http'],
    ] as const) {
      const client = new TavilyWebClient(
        { apiKey: key },
        dependencies(() => response(`secret ${key}`, status)),
      );
      try {
        await client.search('test');
        throw new Error('Expected search failure');
      } catch (error) {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain(key);
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  test('rejects malformed JSON/schema, non-JSON, invalid UTF-8, and reflected credentials', async () => {
    const entity = key.replace(/./g, (letter) => `&#${letter.charCodeAt(0)};`);
    const utf8 = { ...searchResponse(), body: new Uint8Array([0xff]) };
    for (const fake of [
      response('not JSON'),
      response('{"results":"wrong"}'),
      response('{}'),
      response(JSON.stringify({ results: [result] }), 200, { 'content-type': 'text/html' }),
      searchResponse([{ ...result, content: 123 }]),
      searchResponse([{ ...result, title: entity }]),
      searchResponse([{ ...result, content: key }]),
      utf8,
    ]) {
      const client = new TavilyWebClient(
        { apiKey: key },
        dependencies(() => fake),
      );
      await expect(client.search('test')).rejects.toMatchObject({ code: 'incompatible' });
    }
  });

  test('accepts empty results and emits a bounded completed response byte receipt', async () => {
    const receipts: number[] = [];
    const fake = searchResponse([]);
    const client = new TavilyWebClient(
      { apiKey: key },
      dependencies(() => fake),
    );
    expect(
      await client.search('test', {
        maxResponseBytes: fake.body.byteLength,
        onResponseBytes: (bytes) => receipts.push(bytes),
      }),
    ).toEqual([]);
    expect(receipts).toEqual([fake.body.byteLength]);
    await expect(
      client.search('test', { maxResponseBytes: fake.body.byteLength - 1 }),
    ).rejects.toMatchObject({
      code: 'too-large',
    });
    await expect(client.search('test', { maxResponseBytes: 512 * 1024 + 1 })).rejects.toMatchObject(
      {
        code: 'invalid-input',
      },
    );
  });

  test('deadline and Stop cancel a pending POST, including a transport that never settles', async () => {
    let pendingSignal: AbortSignal | undefined;
    const deps = dependencies((input) => {
      pendingSignal = input.signal;
      return new Promise<WebTransportResponse>(() => {});
    });
    const timeout = new TavilyWebClient({ apiKey: key, timeoutMs: 10 }, deps);
    await expect(timeout.search('evidence')).rejects.toMatchObject({ code: 'timeout' });
    expect(pendingSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const stopped = new TavilyWebClient({ apiKey: key }, deps).search('evidence', {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'cancelled' });
  });

  test('page fetch stays credential-free GET across revalidated redirects with page provenance', async () => {
    const captured: WebTransportRequest[] = [];
    const hosts: string[] = [];
    const client = new TavilyWebClient(
      { apiKey: key },
      {
        ...dependencies((input) => {
          captured.push(input);
          return captured.length === 1
            ? response('', 302, { location: 'https://example.net/final' })
            : response('<title>Fetched page</title><main>Actual public evidence.</main>', 200, {
                'content-type': 'text/html',
              });
        }),
        resolve: async (hostname) => {
          hosts.push(hostname);
          return [address];
        },
      },
    );
    const source = await client.fetchPage('https://example.org/start');
    expect(hosts).toEqual(['example.org', 'example.net']);
    expect(source).toMatchObject({
      kind: 'page',
      url: 'https://example.net/final',
      content: 'Actual public evidence.',
      trust: 'untrusted',
    });
    for (const input of captured) {
      expect(input.method ?? 'GET').toBe('GET');
      expect(input.body).toBeUndefined();
      expect(Object.keys(input.headers).sort()).toEqual([
        'Accept',
        'Accept-Encoding',
        'User-Agent',
      ]);
      expect(JSON.stringify(input.headers)).not.toContain(key);
    }
  });

  test('page reads reject reserved DNS addresses and unsafe redirects rather than relaxing SSRF', async () => {
    let requests = 0;
    const blockedDns = new TavilyWebClient(
      { apiKey: key },
      {
        ...dependencies(() => {
          requests++;
          return response('<main>Must not read</main>');
        }),
        resolve: async () => [{ address: 'fc00::1', family: 6 }],
      },
    );
    await expect(blockedDns.fetchPage('https://example.org/')).rejects.toMatchObject({
      code: 'blocked-address',
    });
    expect(requests).toBe(0);
    const redirect = new TavilyWebClient(
      { apiKey: key },
      dependencies(() => {
        requests++;
        return response('', 302, { location: 'https://127.0.0.1/private' });
      }),
    );
    await expect(redirect.fetchPage('https://example.org/')).rejects.toMatchObject({
      code: 'blocked-url',
    });
    expect(requests).toBe(1);
  });
});

describe('bounded pinned HTTPS POST transport', () => {
  function harness(options: { pause?: boolean; contentLength?: string } = {}) {
    let captured: RequestOptions | undefined;
    let sent: Uint8Array | undefined;
    let requestDestroyed = false;
    let responseDestroyed = false;
    const client = new EventEmitter() as EventEmitter & {
      end(body?: Uint8Array): void;
      destroy(): void;
    };
    const incoming = new EventEmitter() as EventEmitter & {
      headers: Record<string, string>;
      statusCode: number;
      destroy(): void;
    };
    incoming.headers = { 'content-type': 'application/json' };
    if (options.contentLength) incoming.headers['content-length'] = options.contentLength;
    incoming.statusCode = 200;
    client.destroy = () => {
      requestDestroyed = true;
    };
    incoming.destroy = () => {
      responseDestroyed = true;
    };
    const transport = createPinnedHttpsTransport((requestOptions, callback) => {
      captured = requestOptions;
      client.end = (body) => {
        sent = body;
        queueMicrotask(() => {
          const socket = new EventEmitter() as EventEmitter & { remoteAddress: string };
          socket.remoteAddress = address.address;
          client.emit('socket', socket);
          socket.emit('secureConnect');
          if (requestDestroyed) return;
          callback(incoming as unknown as IncomingMessage);
          if (options.pause || responseDestroyed) return;
          incoming.emit('data', Buffer.from('{"results":[]}'));
          if (!responseDestroyed) incoming.emit('end');
        });
      };
      return client as unknown as ClientRequest;
    });
    return {
      transport,
      captured: () => captured,
      sent: () => sent,
      destroyed: () => ({ requestDestroyed, responseDestroyed }),
    };
  }
  const input = (signal = new AbortController().signal): WebTransportRequest => ({
    url: new URL(TAVILY_SEARCH_ENDPOINT),
    address,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    method: 'POST',
    body: new TextEncoder().encode('{"query":"evidence"}'),
    signal,
    maxBytes: 1024,
  });

  test('sends an immutable body copy while preserving TLS validation, pinning and SNI', async () => {
    const native = harness();
    const request = input();
    const pending = native.transport(request);
    request.body?.fill(0);
    const result = await pending;
    expect(new TextDecoder().decode(native.sent())).toBe('{"query":"evidence"}');
    expect(new TextDecoder().decode(result.body)).toBe('{"results":[]}');
    expect(native.captured()).toMatchObject({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      agent: false,
      rejectUnauthorized: true,
      servername: 'api.tavily.com',
      family: 4,
      autoSelectFamily: false,
    });
  });

  test('rejects missing/empty/oversized POST bodies, GET bodies, and unsupported methods before dispatch', async () => {
    for (const request of [
      { ...input(), body: undefined },
      { ...input(), body: new Uint8Array() },
      { ...input(), body: new Uint8Array(16 * 1024 + 1) },
      { ...input(), method: 'GET' as const },
      { ...input(), method: 'PUT' as 'POST' },
    ]) {
      const native = harness();
      await expect(native.transport(request)).rejects.toMatchObject({ code: 'invalid-input' });
      expect(native.captured()).toBeUndefined();
    }
  });

  test('bounds a POST response and destroys a pending POST on abort', async () => {
    const bounded = harness({ contentLength: '1025' });
    await expect(bounded.transport(input())).rejects.toMatchObject({ code: 'too-large' });
    expect(bounded.destroyed()).toEqual({ requestDestroyed: true, responseDestroyed: true });
    const controller = new AbortController();
    const native = harness({ pause: true });
    const pending = native.transport(input(controller.signal));
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(native.destroyed()).toEqual({ requestDestroyed: true, responseDestroyed: true });
  });
});
