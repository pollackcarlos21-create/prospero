import { describe, expect, test } from 'bun:test';
import { OpenAICompatibleProvider, ProviderError, normalizeBaseUrl, testConnection } from './index';
import type { ModelRequest } from '@prospero/core';

const config = {
  baseUrl: 'https://api.example.test/v1',
  model: 'test-model',
  apiKey: 'placeholder-test-key',
};
const request: ModelRequest = { messages: [{ role: 'user', content: 'Hello' }], tools: [] };
const packet = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const complete = (text = 'Hello') =>
  `${packet({ content: text }) + packet({}, 'stop')}data: [DONE]\n\n`;
function responseFromChunks(
  chunks: Uint8Array[],
  options: { contentType?: string; close?: boolean } = {},
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (options.close !== false) controller.close();
      },
    }),
    { headers: { 'Content-Type': options.contentType ?? 'text/event-stream' } },
  );
}
const encoder = new TextEncoder();
const streaming = (text: string) => responseFromChunks([encoder.encode(text)]);
const fakeFetch = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch => handler as typeof fetch;
const provider = (response: Response, overrides = {}) =>
  new OpenAICompatibleProvider(
    { ...config, ...overrides },
    fakeFetch(async () => response),
  );
const signal = () => new AbortController().signal;

describe('base URL boundary', () => {
  test('normalizes trailing slashes and full endpoint paths without inventing v1', () => {
    expect(normalizeBaseUrl(' https://api.example.test/v1/// ')).toBe(
      'https://api.example.test/v1',
    );
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('https://api.example.test/v1/chat/completions')).toBe(
      'https://api.example.test/v1',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://[::1]:1234')).toBe('http://[::1]:1234');
  });
  test('rejects credential/query/hash/remote plaintext endpoints', () => {
    for (const url of [
      'not-a-url',
      'http://example.test/v1',
      'https://user:password@example.test',
      'https://example.test?key=secret',
      'https://example.test#secret',
      'file:///tmp/api',
    ])
      expect(() => normalizeBaseUrl(url)).toThrow(ProviderError);
  });
});

describe('OpenAI-compatible streaming', () => {
  test('unauthenticated loopback requests omit Authorization entirely', async () => {
    for (const baseUrl of [
      'http://127.0.0.1:4321/v1',
      'http://localhost:4321',
      'https://localhost/v1',
    ]) {
      let captured: RequestInit | undefined;
      const p = new OpenAICompatibleProvider(
        { ...config, baseUrl, apiKey: '' },
        fakeFetch(async (_url, init) => {
          captured = init;
          return streaming(complete());
        }),
      );
      await p.stream(request, () => {}, signal());
      expect(new Headers(captured?.headers).has('Authorization')).toBe(false);
    }
  });

  test('remote endpoints require a key and return a sanitized authentication error', () => {
    let error: unknown;
    try {
      new OpenAICompatibleProvider({ ...config, apiKey: '' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'auth',
      message: 'Authentication failed. Check the provider API key.',
    });
    expect(String(error)).not.toContain(config.baseUrl);
  });

  test('streams text, finish reason and optional usage with wire message mapping', async () => {
    let captured: RequestInit | undefined;
    const body = complete('Hello').replace(
      'data: [DONE]',
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]`,
    );
    const p = new OpenAICompatibleProvider(
      config,
      fakeFetch(async (url, init) => {
        expect(String(url)).toBe('https://api.example.test/v1/chat/completions');
        captured = init;
        return streaming(body);
      }),
    );
    const text: string[] = [];
    const outcome = await p.stream(
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }],
          },
          { role: 'tool', content: 'file', toolCallId: 'a' },
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read',
            inputSchema: { type: 'object' },
            riskLevel: 'read',
          },
        ],
      },
      (delta) => text.push(delta),
      signal(),
    );
    expect(text).toEqual(['Hello']);
    expect(outcome).toEqual({
      content: 'Hello',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const wire = JSON.parse(captured?.body as string);
    expect(wire.messages[0].tool_calls[0].function.name).toBe('read_file');
    expect(wire.messages[1].tool_call_id).toBe('a');
    expect(wire.tool_choice).toBe('auto');
    expect(captured?.redirect).toBe('error');
  });

  test('preserves multi-chunk UTF-8 and CRLF boundaries', async () => {
    const bytes = encoder.encode(complete('你好🌊').replaceAll('\n', '\r\n'));
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const text: string[] = [];
    const outcome = await provider(responseFromChunks(chunks)).stream(
      request,
      (delta) => text.push(delta),
      signal(),
    );
    expect(text.join('')).toBe('你好🌊');
    expect(outcome.content).toBe('你好🌊');
  });

  test('assembles interleaved tool-call deltas and arguments', async () => {
    const body = `${
      packet({
        tool_calls: [
          {
            index: 0,
            id: 'call_',
            type: 'function',
            function: { name: 'read_', arguments: '{"pa' },
          },
          { index: 1, id: 'second', function: { name: 'shell', arguments: '{' } },
        ],
      }) +
      packet({
        tool_calls: [
          { index: 0, id: 'first', function: { name: 'file', arguments: 'th":"file.txt"}' } },
          { index: 1, function: { arguments: '"command":"pwd"}' } },
        ],
      }) +
      packet({}, 'tool_calls')
    }data: [DONE]\n\n`;
    const outcome = await provider(streaming(body)).stream(request, () => {}, signal());
    expect(outcome.toolCalls).toEqual([
      { id: 'call_first', name: 'read_file', arguments: '{"path":"file.txt"}' },
      { id: 'second', name: 'shell', arguments: '{"command":"pwd"}' },
    ]);
  });

  test('private provider reasoning is never streamed', async () => {
    const text: string[] = [];
    const body = `${packet({ reasoning_content: 'private reasoning', content: 'Safe summary' }) + packet({}, 'stop')}data: [DONE]\n\n`;
    const outcome = await provider(streaming(body)).stream(
      request,
      (delta) => text.push(delta),
      signal(),
    );
    expect(text).toEqual(['Safe summary']);
    expect(JSON.stringify(outcome)).not.toContain('private reasoning');
  });

  test('successful text never reflects the configured credential across delta boundaries', async () => {
    const text: string[] = [];
    const key = config.apiKey;
    const body =
      packet({ content: `Before ${key.slice(0, 5)}` }) +
      packet({ content: key.slice(5, 12) }) +
      packet({ content: `${key.slice(12)} after` }) +
      packet({}, 'stop') +
      'data: [DONE]\n\n';
    const outcome = await provider(streaming(body)).stream(
      request,
      (delta) => text.push(delta),
      signal(),
    );
    expect(text.join('')).not.toContain(key);
    expect(outcome.content).toBe(text.join(''));
    expect(outcome.content).toContain('redacted credential');
    expect(outcome.content).toStartWith('Before ');
    expect(outcome.content).toEndWith(' after');
  });

  test('possible secret prefix is buffered only until a mismatch or successful finish', async () => {
    const text: string[] = [];
    const body =
      packet({ content: 'Normal p' }) +
      packet({ content: 'izza p' }) +
      packet({}, 'stop') +
      'data: [DONE]\n\n';
    const outcome = await provider(streaming(body)).stream(
      request,
      (delta) => text.push(delta),
      signal(),
    );
    expect(outcome.content).toBe('Normal pizza p');
    expect(text.length).toBeGreaterThan(1);
  });

  test('credential-bearing tool calls are rejected rather than silently rewriting commands', async () => {
    for (const key of [config.apiKey, 'quoted"credential\\value']) {
      const body =
        packet({
          tool_calls: [
            {
              index: 0,
              id: 'safe-call-id',
              function: { name: 'shell', arguments: JSON.stringify({ command: `echo ${key}` }) },
            },
          ],
        }) +
        packet({}, 'tool_calls') +
        'data: [DONE]\n\n';
      await expect(
        provider(streaming(body), { apiKey: key }).stream(request, () => {}, signal()),
      ).rejects.toMatchObject({ code: 'incompatible' });
    }
  });

  test('short credentials cannot reappear through a masking boundary', async () => {
    const key = 'redacted';
    const body = complete(`Before ${key} after`);
    const outcome = await provider(streaming(body), { apiKey: key }).stream(
      request,
      () => {},
      signal(),
    );
    expect(outcome.content).not.toContain(key);
    expect(outcome.content).toStartWith('Before ');
  });

  test('DONE completes even when server leaves socket open', async () => {
    const outcome = await provider(
      responseFromChunks([encoder.encode(complete())], { close: false }),
      { timeoutMs: 50 },
    ).stream(request, () => {}, signal());
    expect(outcome.finishReason).toBe('stop');
  });

  test('clean EOF with explicit finish reason is accepted', async () => {
    const outcome = await provider(
      streaming(packet({ content: 'Hello' }) + packet({}, 'stop')),
    ).stream(request, () => {}, signal());
    expect(outcome.content).toBe('Hello');
  });

  test('capability false omits tools and rejects unexpected tool calls', async () => {
    let wire: Record<string, unknown> = {};
    const p = new OpenAICompatibleProvider(
      { ...config, supportsTools: false },
      fakeFetch(async (_url, init) => {
        wire = JSON.parse(init?.body as string);
        return streaming(complete());
      }),
    );
    await p.stream(
      {
        ...request,
        tools: [{ name: 'read_file', description: 'Read', inputSchema: {}, riskLevel: 'read' }],
      },
      () => {},
      signal(),
    );
    expect(wire.tools).toBeUndefined();
    const body = `${packet({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } }] }) + packet({}, 'tool_calls')}data: [DONE]\n\n`;
    await expect(
      provider(streaming(body), { supportsTools: false }).stream(request, () => {}, signal()),
    ).rejects.toMatchObject({ code: 'incompatible' });
  });

  test('401, 429 and 500 are classified without returning response secrets', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [429, 'rate-limit'],
      [500, 'server'],
    ] as const) {
      let error: unknown;
      try {
        await provider(new Response('private-secret-body', { status })).stream(
          request,
          () => {},
          signal(),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain('private-secret-body');
      expect(String(error)).not.toContain(config.apiKey);
    }
  });

  test('fetch failures never leak exception URL or key', async () => {
    const p = new OpenAICompatibleProvider(
      config,
      fakeFetch(async () => {
        throw new Error('placeholder-test-key private-url');
      }),
    );
    await expect(p.stream(request, () => {}, signal())).rejects.toMatchObject({
      code: 'network',
      message: 'Could not connect to the provider. Check your endpoint and connection.',
    });
  });

  test('timeout bounds hanging fetch and hanging response stream', async () => {
    const p = new OpenAICompatibleProvider(
      { ...config, timeoutMs: 5 },
      fakeFetch(async () => new Promise<Response>(() => {})),
    );
    await expect(p.stream(request, () => {}, signal())).rejects.toMatchObject({ code: 'timeout' });
    await expect(
      provider(responseFromChunks([], { close: false }), { timeoutMs: 5 }).stream(
        request,
        () => {},
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  test('abort before/during a request is cancellation', async () => {
    const controller = new AbortController();
    const p = new OpenAICompatibleProvider(
      config,
      fakeFetch(async () => {
        controller.abort();
        return new Promise<Response>(() => {});
      }),
    );
    await expect(p.stream(request, () => {}, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    const preaborted = new AbortController();
    preaborted.abort();
    let called = false;
    const stopped = new OpenAICompatibleProvider(
      config,
      fakeFetch(async () => {
        called = true;
        return streaming(complete());
      }),
    );
    await expect(stopped.stream(request, () => {}, preaborted.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(called).toBe(false);
  });

  test('synchronous fetch abort plus rejection is observed safely', async () => {
    const controller = new AbortController();
    const p = new OpenAICompatibleProvider(
      config,
      fakeFetch(async () => {
        controller.abort();
        throw new Error('Late network rejection');
      }),
    );
    await expect(p.stream(request, () => {}, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  test('abort mid-text does not publish later deltas', async () => {
    const controller = new AbortController();
    const text: string[] = [];
    const body = `${packet({ content: 'First' }) + packet({ content: 'Second' }) + packet({}, 'stop')}data: [DONE]\n\n`;
    await expect(
      provider(streaming(body)).stream(
        request,
        (delta) => {
          text.push(delta);
          controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(text).toEqual(['First']);
  });

  test('rejects malformed SSE/JSON, missing choices and unexpected response shapes', async () => {
    const cases = [
      'this is not SSE',
      'data: {broken}\n\n',
      'data: {"object":"completion"}\n\n',
      'data: []\n\n',
      'data: {"choices":[]}\n\n',
      packet({ content: 123 }) + packet({}, 'stop'),
      `${packet({ content: 'unfinished' })}data: [DONE]\n\n`,
      packet({}, 'unknown'),
      packet({ role: 'user' }) + packet({}, 'stop'),
      packet({
        tool_calls: [{ index: 1, id: 'a', function: { name: 'read_file', arguments: '{}' } }],
      }) + packet({}, 'tool_calls'),
    ];
    for (const body of cases)
      await expect(
        provider(streaming(body)).stream(request, () => {}, signal()),
      ).rejects.toMatchObject({ code: 'incompatible' });
    await expect(
      provider(
        responseFromChunks([encoder.encode(complete())], { contentType: 'application/json' }),
      ).stream(request, () => {}, signal()),
    ).rejects.toMatchObject({ code: 'incompatible' });
  });

  test('invalid UTF-8 is a protocol error', async () => {
    const chunks = [
      encoder.encode('data: {"choices":[{"delta":{"content":"'),
      new Uint8Array([0xff]),
    ];
    await expect(
      provider(responseFromChunks(chunks)).stream(request, () => {}, signal()),
    ).rejects.toMatchObject({ code: 'incompatible' });
  });
});

describe('DeepSeek completion compatibility', () => {
  const baseUrls = [
    'https://API.DEEPSEEK.COM:443/',
    'https://api.deepseek.com/v1///',
    'https://api.deepseek.com/beta/chat/completions',
  ];
  const tools: ModelRequest['tools'] = [
    {
      name: 'read_file',
      description: 'Read the offline fixture',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      riskLevel: 'read',
    },
  ];
  for (const model of ['deepseek-flash', 'deepseek-v4-pro'])
    for (const baseUrl of baseUrls) {
      test(`${model} at ${normalizeBaseUrl(baseUrl)} completes two tool turns without reasoning replay`, async () => {
        const captured: Record<string, unknown>[] = [];
        const text: string[] = [];
        const privateReasoning = 'PRIVATE_DEEPSEEK_REASONING';
        const p = new OpenAICompatibleProvider(
          { ...config, baseUrl, model },
          fakeFetch(async (url, init) => {
            expect(String(url)).toBe(`${normalizeBaseUrl(baseUrl)}/chat/completions`);
            const wire = JSON.parse(init?.body as string);
            captured.push(wire);
            // A thinking-mode endpoint would require reasoning replay on the next request.
            if (wire.thinking?.type !== 'disabled') return new Response('', { status: 400 });
            expect(wire.tools[0].function.name).toBe('read_file');
            if (captured.length === 1)
              return streaming(
                `${packet({ reasoning_content: privateReasoning })}${packet(
                  {
                    content: 'I will read the file.',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_read',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
                      },
                    ],
                  },
                  'tool_calls',
                )}data: [DONE]\n\n`,
              );
            expect(wire.messages).toEqual([
              { role: 'user', content: 'Read the offline fixture.' },
              {
                role: 'assistant',
                content: 'I will read the file.',
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call_read', content: 'Offline fixture bytes.' },
            ]);
            return streaming(complete('Read complete.'));
          }),
        );
        const firstRequest: ModelRequest = {
          messages: [{ role: 'user', content: 'Read the offline fixture.' }],
          tools,
        };
        const first = await p.stream(firstRequest, (delta) => text.push(delta), signal());
        expect(first.finishReason).toBe('tool_calls');
        expect(first.toolCalls).toEqual([
          { id: 'call_read', name: 'read_file', arguments: '{"path":"notes.txt"}' },
        ]);
        const second = await p.stream(
          {
            messages: [
              ...firstRequest.messages,
              { role: 'assistant', content: first.content, toolCalls: first.toolCalls },
              {
                role: 'tool',
                toolCallId: first.toolCalls[0].id,
                content: 'Offline fixture bytes.',
              },
            ],
            tools,
          },
          (delta) => text.push(delta),
          signal(),
        );
        expect(second).toEqual({ content: 'Read complete.', toolCalls: [], finishReason: 'stop' });
        expect(captured).toHaveLength(2);
        expect(text).toEqual(['I will read the file.', 'Read complete.']);
        expect(JSON.stringify([captured, first, second, text])).not.toContain(privateReasoning);
        expect(JSON.stringify(captured)).not.toContain('reasoning_content');
      });

      test(`${model} at ${normalizeBaseUrl(baseUrl)} uses a non-thinking one-token completion fallback`, async () => {
        const urls: string[] = [];
        const result = await testConnection(
          { ...config, baseUrl, model },
          fakeFetch(async (url, init) => {
            urls.push(String(url));
            if (init?.method === 'GET') return new Response('', { status: 404 });
            const wire = JSON.parse(init?.body as string);
            if (wire.thinking?.type !== 'disabled') return new Response('', { status: 400 });
            expect(wire.model).toBe(model);
            expect(wire.stream).toBe(false);
            expect(wire.max_tokens).toBe(1);
            expect(wire.tools).toBeUndefined();
            expect(wire.messages).toEqual([{ role: 'user', content: 'Reply OK.' }]);
            return Response.json({ choices: [{ message: { content: 'OK' } }] });
          }),
        );
        expect(result.status).toBe('connected');
        expect(urls).toEqual([
          `${normalizeBaseUrl(baseUrl)}/models`,
          `${normalizeBaseUrl(baseUrl)}/chat/completions`,
        ]);
      });
    }

  for (const [baseUrl, model] of [
    ['https://api.example.test/v1', 'deepseek-flash'],
    ['https://api.deepseek.com.example.test/v1', 'deepseek-v4-pro'],
    ['https://deepseek.com/v1', 'deepseek-flash'],
    ['https://api.deepseek.com:444/v1', 'deepseek-flash'],
    ['https://api.deepseek.com/custom', 'deepseek-flash'],
    ['https://api.deepseek.com/v1', 'other-model'],
    ['https://api.deepseek.com/beta', 'deepseek-flash-extra'],
  ])
    test(`${baseUrl} with ${model} receives no DeepSeek-specific completion parameters`, async () => {
      const captured: Record<string, unknown>[] = [];
      const fetchPort = fakeFetch(async (_url, init) => {
        if (init?.method === 'GET') return new Response('', { status: 404 });
        const wire = JSON.parse(init?.body as string);
        captured.push(wire);
        if (Object.hasOwn(wire, 'thinking')) return new Response('', { status: 400 });
        return wire.stream
          ? streaming(complete())
          : Response.json({ choices: [{ message: { content: 'OK' } }] });
      });
      const selected = { ...config, baseUrl, model };
      const outcome = await new OpenAICompatibleProvider(selected, fetchPort).stream(
        request,
        () => {},
        signal(),
      );
      expect(outcome.content).toBe('Hello');
      expect((await testConnection(selected, fetchPort)).status).toBe('connected');
      expect(captured).toHaveLength(2);
      for (const wire of captured) expect(wire.thinking).toBeUndefined();
    });
});

describe('connection compatibility check', () => {
  test('loopback connection tests omit Authorization when no key is configured', async () => {
    const result = await testConnection(
      { ...config, baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' },
      fakeFetch(async (_url, init) => {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        return Response.json({ data: [] });
      }),
    );
    expect(result.status).toBe('connected');
  });

  test('remote connection test with no key returns auth without an HTTP request', async () => {
    let calls = 0;
    const result = await testConnection(
      { ...config, apiKey: '' },
      fakeFetch(async () => {
        calls += 1;
        return Response.json({ data: [] });
      }),
    );
    expect(result.status).toBe('auth');
    expect(calls).toBe(0);
  });

  test('models endpoint success uses no completion tokens', async () => {
    let calls = 0;
    const result = await testConnection(
      config,
      fakeFetch(async (url) => {
        calls += 1;
        expect(String(url)).toEndWith('/models');
        return Response.json({ data: [{ id: 'test-model' }] });
      }),
    );
    expect(result.status).toBe('connected');
    expect(calls).toBe(1);
  });
  test('unsupported models endpoint falls back to one-token non-streaming completion', async () => {
    let calls = 0;
    const result = await testConnection(
      config,
      fakeFetch(async (_url, init) => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 404 });
        const body = JSON.parse(init?.body as string);
        expect(body.max_tokens).toBe(1);
        expect(body.stream).toBe(false);
        return Response.json({ choices: [{ message: { content: 'OK' } }] });
      }),
    );
    expect(result.status).toBe('connected');
    expect(calls).toBe(2);
  });
  test('authentication errors do not trigger paid fallback and bodies stay private', async () => {
    let calls = 0;
    const result = await testConnection(
      config,
      fakeFetch(async () => {
        calls += 1;
        return new Response('private-key-body', { status: 401 });
      }),
    );
    expect(result.status).toBe('auth');
    expect(calls).toBe(1);
    expect(result.message).not.toContain('private-key-body');
  });
  test('incompatible fallback, network and timeout return desktop-safe status', async () => {
    expect(
      (
        await testConnection(
          config,
          fakeFetch(async () => Response.json({ unexpected: true })),
        )
      ).status,
    ).toBe('incompatible');
    expect(
      (
        await testConnection(
          config,
          fakeFetch(async () => {
            throw new Error('private-network-details');
          }),
        )
      ).status,
    ).toBe('network');
    expect(
      (
        await testConnection(
          { ...config, timeoutMs: 5 },
          fakeFetch(async () => new Promise<Response>(() => {})),
        )
      ).status,
    ).toBe('timeout');
  });
});
