import { expect, test } from 'bun:test';
import { Channels } from '../ipc';
import { registerDesktopIpc, type InvokeContext } from './ipc-boundary';
import type { DesktopService } from './service';
import {
  clipboardText,
  contextMenuTarget,
  providerInput,
  settingsInput,
  webSearchInput,
  webSearchTestInput,
} from './validation';
test('IPC allowlist rejects untrusted windows, subframes, navigation and extra arguments', async () => {
  const handlers = new Map<string, (context: InvokeContext, ...args: unknown[]) => unknown>();
  let rejected = 0;
  registerDesktopIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    { bootstrap: () => ({ safe: true }) } as unknown as DesktopService,
    () => ({ senderId: 2, url: 'file:///app/index.html' }),
    () => rejected++,
  );
  expect(handlers.size).toBe(Object.keys(Channels).length - 1);
  expect(handlers.has('prospero:eval')).toBe(false);
  expect(handlers.has('prospero:fs')).toBe(false);
  const call = handlers.get(Channels.bootstrap);
  if (!call) throw new Error('Missing handler');
  const good = { senderId: 2, frameUrl: 'file:///app/index.html', isMainFrame: true };
  expect(await call(good)).toEqual({ safe: true });
  for (const bad of [
    { ...good, senderId: 3 },
    { ...good, isMainFrame: false },
    { ...good, frameUrl: 'https://evil.example' },
  ])
    await expect(call(bad)).rejects.toThrow('security boundary');
  await expect(call(good, 'extra')).rejects.toThrow('security boundary');
  expect(rejected).toBe(4);
});
test('IPC rejects unchecked objects, forged settings and unbounded secrets without echoing them', () => {
  expect(() =>
    providerInput({
      displayName: 'x',
      model: 'm',
      baseUrl: 'http://localhost',
      apiKey: 'test\nsecret',
    }),
  ).toThrow('Invalid API key');
  expect(() =>
    providerInput({ displayName: 'x', model: 'm', baseUrl: 'http://localhost', eval: true }),
  ).toThrow('Unexpected');
  expect(() =>
    settingsInput({
      theme: 'dark',
      askBeforeReads: false,
      memory: [
        { id: 'one', text: 'a' },
        { id: 'one', text: 'b' },
      ],
    }),
  ).toThrow('Duplicate');
});
test('native context and clipboard requests reject arbitrary commands, URLs and unbounded data', () => {
  expect(contextMenuTarget({ kind: 'conversation', conversationId: 'one' })).toEqual({
    kind: 'conversation',
    conversationId: 'one',
  });
  expect(contextMenuTarget({ kind: 'message', conversationId: 'one', itemId: 'message' })).toEqual({
    kind: 'message',
    conversationId: 'one',
    itemId: 'message',
  });
  for (const value of [
    { kind: 'open-url', conversationId: 'one', url: 'https://example.com' },
    { kind: 'file', conversationId: 'one', path: '/tmp/file', command: 'anything' },
    { kind: 'message', conversationId: 'one', itemId: 'message', text: 'forged' },
  ])
    expect(() => contextMenuTarget(value)).toThrow();
  expect(clipboardText('')).toBe('');
  expect(() => clipboardText('a'.repeat(256_001))).toThrow('size limit');
  expect(() => clipboardText('bad\0text')).toThrow('size limit');
});

test('Web Search IPC validates both providers while retaining legacy provider omission', () => {
  for (const provider of ['brave', 'tavily'] as const) {
    expect(
      webSearchInput({
        provider,
        enabled: true,
        retention: 'session',
        apiKey: 'offline-search-key',
      }),
    ).toEqual({
      provider,
      enabled: true,
      retention: 'session',
      apiKey: 'offline-search-key',
      clearApiKey: undefined,
    });
    expect(webSearchTestInput({ provider, apiKey: 'offline-search-key' })).toEqual({
      provider,
      apiKey: 'offline-search-key',
    });
    expect(webSearchTestInput({ provider })).toEqual({ provider });
  }
  expect(webSearchInput({ enabled: false, retention: 'sources' }).provider).toBeUndefined();
  expect(webSearchTestInput({})).toEqual({});
  for (const provider of ['unknown', 'Tavily', '', null, 1, { provider: 'tavily' }]) {
    expect(() => webSearchInput({ provider, enabled: true, retention: 'session' })).toThrow(
      'supported Web Search provider',
    );
    expect(() => webSearchTestInput({ provider })).toThrow('supported Web Search provider');
  }
  expect(() =>
    webSearchInput({
      provider: 'tavily',
      enabled: true,
      retention: 'session',
      endpoint: 'https://other.example',
    }),
  ).toThrow('Unexpected');
  expect(() => webSearchTestInput({ provider: 'tavily', apiKey: 'test\nsecret' })).toThrow(
    'valid search API key',
  );
  expect(() => webSearchTestInput({ provider: 'tavily', apiKey: 'a'.repeat(4097) })).toThrow(
    'valid search API key',
  );
  expect(() =>
    webSearchInput({
      provider: 'tavily',
      enabled: true,
      retention: 'session',
      apiKey: 'offline-search-key',
      clearApiKey: true,
    }),
  ).toThrow('replacement or removal');
});
