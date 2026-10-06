import { expect, test } from 'bun:test';
import { ProsperoStore } from '@prospero/persistence';
import {
  BRAVE_SEARCH_ENDPOINT,
  TAVILY_SEARCH_ENDPOINT,
  WebError,
  type WebClient,
} from '@prospero/web';
import type { WebSearchProvider } from '../bridge';
import { DesktopService, type CredentialVault } from './service';
import { startFakeProvider } from '../../../../tests/e2e/fake-provider';
import { CredentialBindingError } from './credential-storage';
import { CredentialOperationTimeout } from './credential-operation';

function fixture(vault: CredentialVault, client: WebClient, credentialTimeoutMs = 30_000) {
  const store = new ProsperoStore(':memory:');
  const service = new DesktopService(
    store,
    vault,
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    undefined,
    () => client,
    credentialTimeoutMs,
  );
  return { store, service };
}

test('a text-only selected model completes chat without decrypting an unavailable search credential', async () => {
  const fake = await startFakeProvider(() => ({
    text: 'This model cannot research the live web.',
  }));
  const store = new ProsperoStore(':memory:');
  const reads: string[] = [];
  let webClients = 0;
  store.saveProvider({
    id: 'text-only',
    displayName: 'Text only',
    baseUrl: fake.baseUrl,
    model: 'offline-model',
    supportsTools: false,
  });
  store.setSetting('web-search', { enabled: true, retention: 'sources' });
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: async (id) => {
        reads.push(id);
        if (id === 'brave-search') throw new Error('Unavailable Web tools must not decrypt a key.');
        return undefined;
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    undefined,
    () => {
      webClients++;
      throw new Error('Unavailable Web tools must not create a network client.');
    },
  );
  try {
    const conversation = service.createConversation();
    service.selectProvider(conversation.id, 'text-only');
    await service.sendTask(conversation.id, 'Research this topic');
    const deadline = Date.now() + 5000;
    while (service.getConversation(conversation.id).state !== 'completed') {
      if (Date.now() >= deadline) throw new Error('Offline text-only chat did not finish.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reads).toEqual(['text-only']);
    expect(webClients).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].tools).toBeUndefined();
    expect(JSON.stringify(fake.requests[0].messages)).toContain('unavailable for this model');
    expect(service.bootstrap().webSearch?.enabled).toBe(true);
    expect(service.getConversation(conversation.id).sources).toEqual([]);
  } finally {
    await service.shutdown();
    await fake.close();
    store.close();
  }
});

for (const supportsTools of [true, undefined]) {
  test(`enabled Web without a key exposes no network tools (${supportsTools === true ? 'explicit' : 'default'} model tool support)`, async () => {
    const fake = await startFakeProvider(() => ({ text: 'Configure a search key first.' }));
    const store = new ProsperoStore(':memory:');
    const reads: string[] = [];
    store.saveProvider({
      id: 'selected',
      displayName: 'Offline',
      baseUrl: fake.baseUrl,
      model: 'offline-model',
      supportsTools,
    });
    store.setSetting('web-search', { enabled: true, retention: 'sources' });
    const service = new DesktopService(
      store,
      {
        put: async () => {},
        get: async (id) => {
          reads.push(id);
          return undefined;
        },
      },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      '0.2.0',
      undefined,
      undefined,
      () => {
        throw new Error('No search key means no Web client.');
      },
    );
    try {
      const conversation = service.createConversation();
      service.selectProvider(conversation.id, 'selected');
      await service.sendTask(conversation.id, 'Research this topic');
      const deadline = Date.now() + 5000;
      while (service.getConversation(conversation.id).state !== 'completed') {
        if (Date.now() >= deadline) throw new Error('Offline missing-key chat did not finish.');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reads).toEqual(['selected', 'brave-search']);
      expect(fake.requests).toHaveLength(1);
      const names = (fake.requests[0].tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      expect(names).toContain('read_file');
      for (const name of ['web_search', 'fetch_page', 'fetch_source', 'authorize_research'])
        expect(names).not.toContain(name);
      expect(JSON.stringify(fake.requests[0].messages)).toContain('the search key is missing');
      expect(service.getConversation(conversation.id).sources).toEqual([]);
      expect(service.bootstrap().webSearch?.enabled).toBe(true);
    } finally {
      await service.shutdown();
      await fake.close();
      store.close();
    }
  });
}

test('draft search connection probe makes one fixed request and changes no settings or retained sources', async () => {
  let reads = 0;
  const calls: unknown[] = [];
  const { store, service } = fixture(
    {
      put: async () => {
        throw new Error('Probe must not save');
      },
      get: async () => {
        reads++;
        return 'stored-test-key';
      },
    },
    {
      search: async (query, options) => {
        calls.push({ query, count: options?.maxResults });
        return [];
      },
      fetchPage: async () => {
        throw new Error('Probe must not fetch');
      },
    },
  );
  try {
    const before = service.bootstrap().webSearch;
    expect((await service.testWebSearch({ apiKey: 'draft-test-key' })).status).toBe('connected');
    expect(reads).toBe(0);
    expect(calls).toEqual([{ query: 'Prospero web search', count: 1 }]);
    expect(service.bootstrap().webSearch).toEqual(before);
    expect(store.sources('any')).toEqual([]);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('Web provider switches keep separate endpoint-bound credentials and legacy settings remain Brave', async () => {
  const store = new ProsperoStore(':memory:');
  const keys = new Map<string, string>([['brave-search', 'offline-saved-brave-key']]);
  const reads: { id: string; endpoint?: string }[] = [];
  const writes: { id: string; endpoint?: string }[] = [];
  const selected: { key: string; provider: WebSearchProvider }[] = [];
  const client: WebClient = {
    search: async () => [],
    fetchPage: async () => {
      throw new Error('Connection probes must not fetch pages.');
    },
  };
  // Explicit fake vault markers, not OS crypto or a real credential envelope.
  store.saveEncryptedCredential('brave-search', new Uint8Array([1]));
  store.setSetting('web-search', { enabled: true, retention: 'sources' });
  const service = new DesktopService(
    store,
    {
      put: async (id, key, _signal, endpoint) => {
        writes.push({ id, endpoint });
        keys.set(id, key);
        store.saveEncryptedCredential(id, new Uint8Array([id === 'brave-search' ? 1 : 2]));
      },
      get: async (id, _signal, endpoint) => {
        reads.push({ id, endpoint });
        return store.encryptedCredential(id) ? keys.get(id) : undefined;
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    undefined,
    (key, provider) => {
      selected.push({ key, provider });
      return client;
    },
  );
  try {
    expect(service.bootstrap().webSearch).toEqual({
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'sources',
    });
    expect((await service.testWebSearch({})).status).toBe('connected');
    expect(reads).toEqual([{ id: 'brave-search', endpoint: BRAVE_SEARCH_ENDPOINT }]);
    expect(selected).toEqual([{ key: 'offline-saved-brave-key', provider: 'brave' }]);

    expect(
      await service.saveWebSearch({ provider: 'tavily', enabled: true, retention: 'sources' }),
    ).toMatchObject({ provider: 'tavily', hasApiKey: false });
    expect((await service.testWebSearch({})).status).toBe('auth');
    expect(reads.at(-1)).toEqual({ id: 'tavily-search', endpoint: TAVILY_SEARCH_ENDPOINT });
    expect(selected).toHaveLength(1);
    expect(store.encryptedCredential('brave-search')).toEqual(new Uint8Array([1]));

    await service.saveWebSearch({
      enabled: true,
      retention: 'sources',
      apiKey: 'offline-saved-tavily-key',
    });
    expect(writes).toEqual([{ id: 'tavily-search', endpoint: TAVILY_SEARCH_ENDPOINT }]);
    expect((await service.testWebSearch({})).status).toBe('connected');
    expect(selected.at(-1)).toEqual({ key: 'offline-saved-tavily-key', provider: 'tavily' });
    await service.saveWebSearch({ provider: 'brave', enabled: true, retention: 'sources' });
    expect((await service.testWebSearch({})).status).toBe('connected');
    expect(selected.at(-1)).toEqual({ key: 'offline-saved-brave-key', provider: 'brave' });
    await service.saveWebSearch({ enabled: true, retention: 'sources', clearApiKey: true });
    expect(store.encryptedCredential('brave-search')).toBeUndefined();
    expect(store.encryptedCredential('tavily-search')).toEqual(new Uint8Array([2]));
    expect(
      await service.saveWebSearch({ provider: 'tavily', enabled: true, retention: 'sources' }),
    ).toMatchObject({ provider: 'tavily', hasApiKey: true });
    expect((await service.testWebSearch({})).status).toBe('connected');
    expect(reads.at(-1)).toEqual({ id: 'tavily-search', endpoint: TAVILY_SEARCH_ENDPOINT });
    expect(selected.at(-1)).toEqual({ key: 'offline-saved-tavily-key', provider: 'tavily' });
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('a Tavily draft connection uses its selected provider without saving or changing current Brave settings', async () => {
  const store = new ProsperoStore(':memory:');
  store.setSetting('web-search', { provider: 'brave', enabled: true, retention: 'sources' });
  const calls: { key: string; provider: WebSearchProvider; query: string; count?: number }[] = [];
  const service = new DesktopService(
    store,
    {
      put: async () => {
        throw new Error('A draft connection test must not save credentials.');
      },
      get: async () => {
        throw new Error('An explicit draft key must not read saved credentials.');
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    undefined,
    (key, provider) => ({
      search: async (query, options) => {
        calls.push({ key, provider, query, count: options?.maxResults });
        return [];
      },
      fetchPage: async () => {
        throw new Error('A connection test must not fetch pages.');
      },
    }),
  );
  try {
    const before = service.bootstrap().webSearch;
    expect(
      (await service.testWebSearch({ provider: 'tavily', apiKey: 'offline-draft-tavily-key' }))
        .status,
    ).toBe('connected');
    expect(calls).toEqual([
      {
        key: 'offline-draft-tavily-key',
        provider: 'tavily',
        query: 'Prospero web search',
        count: 1,
      },
    ]);
    expect(service.bootstrap().webSearch).toEqual(before);
    expect(store.encryptedCredential('brave-search')).toBeUndefined();
    expect(store.encryptedCredential('tavily-search')).toBeUndefined();
    expect(store.sources('any')).toEqual([]);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test('search probe reserves configuration and tasks while decrypting, then shutdown settles before native reply', async () => {
  let release: (value: string | undefined) => void = () => {};
  let searches = 0;
  let signal: AbortSignal | undefined;
  const { store, service } = fixture(
    {
      put: async () => {},
      get: (_id, inner) => {
        signal = inner;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    {
      search: async () => {
        searches++;
        return [];
      },
      fetchPage: async () => {
        throw new Error('Unused');
      },
    },
  );
  store.saveProvider({
    id: 'local',
    displayName: 'Local',
    baseUrl: 'http://127.0.0.1:1234',
    model: 'm',
  });
  const c = service.createConversation();
  service.selectProvider(c.id, 'local');
  const probe = service.testWebSearch({});
  await Promise.resolve();
  await expect(service.saveWebSearch({ enabled: true, retention: 'sources' })).rejects.toThrow(
    'wait',
  );
  await expect(service.testWebSearch({ apiKey: 'second-key' })).rejects.toThrow('wait');
  await expect(service.sendTask(c.id, 'task')).rejects.toThrow('Web Search');
  await service.suspendWindow();
  expect((await probe).status).toBe('cancelled');
  expect(signal?.aborted).toBe(true);
  expect(searches).toBe(0);
  store.close();
  release('late-test-key');
  await Promise.resolve();
  expect(searches).toBe(0);
});

test('stored-key probe reads only Brave credential and sanitizes provider failures', async () => {
  const ids: string[] = [];
  const { store, service } = fixture(
    {
      put: async () => {},
      get: async (id) => {
        ids.push(id);
        return 'stored-test-key';
      },
    },
    {
      search: async () => {
        throw new WebError('rate-limit');
      },
      fetchPage: async () => {
        throw new Error('Unused');
      },
    },
  );
  try {
    const result = await service.testWebSearch({});
    expect(ids).toEqual(['brave-search']);
    expect(result.status).toBe('rate-limit');
    expect(JSON.stringify(result)).not.toContain('stored-test-key');
    expect(service.bootstrap().webSearch?.enabled).toBe(false);
  } finally {
    await service.shutdown();
    store.close();
  }
});

for (const binding of [false, true]) {
  test(`stored-key ${binding ? 'binding' : 'storage'} failure gives safe local recovery guidance before any search`, async () => {
    let searches = 0;
    const error = binding ? new CredentialBindingError() : new Error('private native failure');
    error.message = 'OFFLINE_PRIVATE_KEY private native details';
    const { store, service } = fixture(
      {
        put: async () => {},
        get: async () => {
          throw error;
        },
      },
      {
        search: async () => {
          searches++;
          return [];
        },
        fetchPage: async () => {
          throw new Error('Unused');
        },
      },
    );
    try {
      const before = service.bootstrap().webSearch;
      expect(await service.testWebSearch({})).toEqual({
        status: 'auth',
        message: binding
          ? new CredentialBindingError().message
          : 'Unlock secure credential storage and try again.',
      });
      expect(searches).toBe(0);
      expect(service.bootstrap().webSearch).toEqual(before);
    } finally {
      await service.shutdown();
      store.close();
    }
  });
}

test('stored search key deadline identifies secure storage and a late reply starts no request', async () => {
  let release = (_key: string) => {};
  let searches = 0;
  const { store, service } = fixture(
    {
      put: async () => {},
      get: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    },
    {
      search: async () => {
        searches++;
        return [];
      },
      fetchPage: async () => {
        throw new Error('Unused');
      },
    },
    10,
  );
  const result = await service.testWebSearch({});
  expect(result).toEqual({ status: 'timeout', message: new CredentialOperationTimeout().message });
  expect(searches).toBe(0);
  await service.shutdown();
  store.close();
  release('late-offline-search-key');
  await Promise.resolve();
  await Promise.resolve();
  expect(searches).toBe(0);
});

test('a deadline after the key is loaded reports the search timeout rather than an OS storage failure', async () => {
  let searches = 0;
  let signal: AbortSignal | undefined;
  const { store, service } = fixture(
    { put: async () => {}, get: async () => 'offline-search-key' },
    {
      search: async (_query, options) => {
        searches++;
        signal = options?.signal;
        return new Promise(() => {});
      },
      fetchPage: async () => {
        throw new Error('Unused');
      },
    },
    10,
  );
  try {
    expect(await service.testWebSearch({})).toEqual({
      status: 'timeout',
      message: 'The Brave Search connection test timed out.',
    });
    expect(searches).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(store.sources('any')).toEqual([]);
  } finally {
    await service.shutdown();
    store.close();
  }
});
