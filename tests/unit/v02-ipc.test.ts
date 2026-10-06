import { describe, expect, mock, test } from 'bun:test';
import { Channels } from '../../apps/desktop/src/ipc';
import { registerDesktopIpc, type InvokeContext } from '../../apps/desktop/src/main/ipc-boundary';
import type { DesktopService } from '../../apps/desktop/src/main/service';
import {
  planDigest,
  researchDigest,
  scopeMode,
  webSearchInput,
  webSearchTestInput,
} from '../../apps/desktop/src/main/validation';

function fixture() {
  const calls = {
    addScope: mock(async (_id: string, _mode: 'read' | 'write') => ({ safe: true })),
    removeScope: mock(async (_id: string, _scope: string) => ({ safe: true })),
    decideActionPlan: mock(
      async (_id: string, _request: string, _digest: string, _decision: string) => {},
    ),
    decideResearch: mock(
      async (_id: string, _request: string, _digest: string, _decision: string) => {},
    ),
    saveWebSearch: mock(async (_input: unknown) => ({
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    })),
    testWebSearch: mock(async (_input: unknown) => ({
      status: 'connected',
      message: 'Connected to Brave Search.',
    })),
    openSource: mock(async (_id: string, _source: string) => {}),
  };
  const handlers = new Map<string, (context: InvokeContext, ...args: unknown[]) => unknown>();
  registerDesktopIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    calls as unknown as DesktopService,
    () => ({ senderId: 42, url: 'file:///prospero/index.html' }),
    () => {},
  );
  const context = { senderId: 42, frameUrl: 'file:///prospero/index.html', isMainFrame: true };
  return {
    calls,
    context,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error('Missing test handler');
      return handler(context, ...args);
    },
    handlers,
  };
}

describe('v0.2 secure IPC contracts', () => {
  test('scope mode and source operations expose only narrow typed arguments', async () => {
    const value = fixture();
    await value.invoke(Channels.addScope, 'task', 'read');
    await value.invoke(Channels.addScope, 'task', 'write');
    await value.invoke(Channels.removeScope, 'task', 'scope-root');
    await value.invoke(Channels.openSource, 'task', 'src_abcdef');
    expect(value.calls.addScope).toHaveBeenNthCalledWith(1, 'task', 'read');
    expect(value.calls.addScope).toHaveBeenNthCalledWith(2, 'task', 'write');
    expect(value.calls.openSource).toHaveBeenCalledWith('task', 'src_abcdef');
    for (const mode of ['all', '/Users', true, { mode: 'write' }])
      await expect(value.invoke(Channels.addScope, 'task', mode)).rejects.toThrow();
    for (const source of ['https://example.org/', '../secret', { url: 'https://example.org/' }])
      await expect(value.invoke(Channels.openSource, 'task', source)).rejects.toThrow();
    await expect(
      value.invoke(Channels.addScope, 'task', 'write', '/arbitrary/path'),
    ).rejects.toThrow('security boundary');
    expect(value.calls.addScope).toHaveBeenCalledTimes(2);
    expect(value.calls.openSource).toHaveBeenCalledTimes(1);
  });
  test('requires the exact SHA-256 digest and rejects session approval before service invocation', async () => {
    const value = fixture();
    const digest = 'a'.repeat(64);
    await value.invoke(Channels.decideActionPlan, 'task', 'request', digest, 'allow-once');
    await value.invoke(Channels.decideActionPlan, 'task', 'request', digest, 'deny');
    expect(value.calls.decideActionPlan).toHaveBeenNthCalledWith(
      1,
      'task',
      'request',
      digest,
      'allow-once',
    );
    await expect(
      value.invoke(Channels.decideActionPlan, 'task', 'request', digest, 'allow-session'),
    ).rejects.toThrow('one-time');
    for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), { digest }])
      await expect(
        value.invoke(Channels.decideActionPlan, 'task', 'request', invalid, 'allow-once'),
      ).rejects.toThrow('Invalid plan digest');
    expect(value.calls.decideActionPlan).toHaveBeenCalledTimes(2);
  });
  test('research approval carries only an exact digest and one-time decision', async () => {
    const value = fixture();
    const digest = 'b'.repeat(64);
    expect(Channels.decideResearch).toBe('prospero:research:decide');
    await value.invoke(Channels.decideResearch, 'task', 'research-request', digest, 'allow-once');
    await value.invoke(Channels.decideResearch, 'task', 'research-request', digest, 'deny');
    expect(value.calls.decideResearch).toHaveBeenNthCalledWith(
      1,
      'task',
      'research-request',
      digest,
      'allow-once',
    );
    expect(value.calls.decideResearch).toHaveBeenNthCalledWith(
      2,
      'task',
      'research-request',
      digest,
      'deny',
    );
    for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), { digest }])
      await expect(
        value.invoke(Channels.decideResearch, 'task', 'research-request', invalid, 'allow-once'),
      ).rejects.toThrow('Invalid research digest');
    for (const invalid of ['allow-session', 'approve', true, { decision: 'deny' }])
      await expect(
        value.invoke(Channels.decideResearch, 'task', 'research-request', digest, invalid),
      ).rejects.toThrow();
    for (const id of ['../task', 'https://example.org/', { id: 'task' }])
      await expect(
        value.invoke(Channels.decideResearch, id, 'research-request', digest, 'deny'),
      ).rejects.toThrow();
    for (const request of ['', 'x'.repeat(301), { requestId: 'research-request' }])
      await expect(
        value.invoke(Channels.decideResearch, 'task', request, digest, 'deny'),
      ).rejects.toThrow();
    expect(value.calls.decideResearch).toHaveBeenCalledTimes(2);
    expect(researchDigest(digest)).toBe(digest);
  });
  test('Web settings reject endpoint/header/credential retrieval fields and reflected secrets', async () => {
    const value = fixture();
    const input = { enabled: true, retention: 'session', apiKey: 'offline-search-key' };
    const saved = await value.invoke(Channels.saveWebSearch, input);
    expect(saved).toEqual({
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    });
    expect(JSON.stringify(saved)).not.toContain(input.apiKey);
    for (const extra of [
      { endpoint: 'https://evil.example/' },
      { headers: { Authorization: 'secret' } },
      { getApiKey: true },
    ])
      await expect(value.invoke(Channels.saveWebSearch, { ...input, ...extra })).rejects.toThrow(
        'Unexpected',
      );
    for (const invalid of [
      { ...input, provider: 'different' },
      { ...input, provider: 'https://evil.example/' },
      { ...input, enabled: 'yes' },
      { ...input, retention: 'forever' },
      { ...input, apiKey: 'short' },
      { ...input, apiKey: 'offline\nsecret' },
      { ...input, apiKey: 'x'.repeat(4097) },
      { ...input, apiKey: 1 },
      { ...input, clearApiKey: 'yes' },
      { ...input, clearApiKey: true },
    ])
      await expect(value.invoke(Channels.saveWebSearch, invalid)).rejects.toThrow();
    expect(value.calls.saveWebSearch).toHaveBeenCalledTimes(1);
    expect(value.handlers.has('prospero:web:credential:get')).toBe(false);
    expect(value.handlers.has('prospero:web:fetch')).toBe(false);
  });
  test('all added IPC methods retain sender/frame/arity enforcement', async () => {
    const value = fixture();
    const cases = [
      [Channels.addScope, ['task', 'read']],
      [Channels.removeScope, ['task', 'root']],
      [Channels.openSource, ['task', 'source']],
      [Channels.decideActionPlan, ['task', 'request', 'a'.repeat(64), 'deny']],
      [Channels.decideResearch, ['task', 'request', 'b'.repeat(64), 'deny']],
      [Channels.saveWebSearch, [{ enabled: false, retention: 'session' }]],
      [Channels.testWebSearch, [{}]],
    ] as const;
    for (const [channel, args] of cases) {
      const call = value.handlers.get(channel);
      if (!call) throw new Error('Missing handler in test fixture');
      for (const context of [
        { ...value.context, senderId: 43 },
        { ...value.context, isMainFrame: false },
        { ...value.context, frameUrl: 'https://example.org/' },
      ])
        await expect(call(context, ...args)).rejects.toThrow('security boundary');
      await expect(call(value.context, ...args, 'extra')).rejects.toThrow('security boundary');
    }
    expect(value.calls.saveWebSearch).not.toHaveBeenCalled();
    expect(value.calls.testWebSearch).not.toHaveBeenCalled();
    expect(value.calls.decideActionPlan).not.toHaveBeenCalled();
    expect(value.calls.decideResearch).not.toHaveBeenCalled();
  });
  test('search connection testing accepts an optional selected provider/key and no destination or query override', async () => {
    const value = fixture();
    await value.invoke(Channels.testWebSearch, {});
    await value.invoke(Channels.testWebSearch, { apiKey: '' });
    await value.invoke(Channels.testWebSearch, { apiKey: 'offline-search-key' });
    expect(value.calls.testWebSearch).toHaveBeenNthCalledWith(1, {});
    expect(value.calls.testWebSearch).toHaveBeenNthCalledWith(2, {});
    expect(value.calls.testWebSearch).toHaveBeenNthCalledWith(3, { apiKey: 'offline-search-key' });
    for (const extra of [
      { endpoint: 'https://evil.example/' },
      { query: 'private task content' },
      { headers: { Authorization: 'secret' } },
      { getApiKey: true },
      { enabled: true },
      { retention: 'sources' },
      { clearApiKey: true },
      { timeoutMs: 300_000 },
    ])
      await expect(value.invoke(Channels.testWebSearch, extra)).rejects.toThrow('Unexpected');
    for (const invalid of [
      null,
      [],
      { apiKey: 'short' },
      { apiKey: 'offline\nkey' },
      { apiKey: 1 },
      { provider: 'different' },
    ])
      await expect(value.invoke(Channels.testWebSearch, invalid)).rejects.toThrow();
    expect(value.calls.testWebSearch).toHaveBeenCalledTimes(3);
    await expect(value.invoke(Channels.testWebSearch)).rejects.toThrow('security boundary');
    expect(webSearchTestInput({ apiKey: 'offline-search-key' })).toEqual({
      apiKey: 'offline-search-key',
    });
    expect(() => webSearchTestInput({ apiKey: 'x'.repeat(4097) })).toThrow('valid search');
    await value.invoke(Channels.testWebSearch, {
      provider: 'tavily',
      apiKey: 'offline-tavily-key',
    });
    expect(value.calls.testWebSearch).toHaveBeenNthCalledWith(4, {
      provider: 'tavily',
      apiKey: 'offline-tavily-key',
    });
  });
  test('validation helpers return only exact safe records and no network destination override', () => {
    expect(scopeMode('read')).toBe('read');
    expect(planDigest('f'.repeat(64))).toBe('f'.repeat(64));
    const input = webSearchInput({ enabled: false, retention: 'sources', clearApiKey: true });
    expect(input.enabled).toBe(false);
    expect(input.clearApiKey).toBe(true);
    expect(() => webSearchInput({ ...input, arbitrary: true })).toThrow('Unexpected');
  });
});
