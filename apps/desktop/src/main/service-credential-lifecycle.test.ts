import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore } from '@prospero/persistence';
import { BRAVE_SEARCH_ENDPOINT, type WebClient } from '@prospero/web';
import type { ProviderInput } from '../bridge';
import { SignalCredentialVault, type CredentialCrypto } from './credential-storage';
import { DesktopService } from './service';

// This pure port simulates native encryption only; all keys are offline test markers.
function cryptoPort(overrides: Partial<CredentialCrypto> = {}): CredentialCrypto {
  return {
    getSelectedStorageBackend: () => 'keychain',
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plaintext) => Buffer.from(plaintext),
    decryptStringAsync: async (ciphertext) => ({
      result: ciphertext.toString(),
      shouldReEncrypt: false,
    }),
    ...overrides,
  };
}
function serviceFor(
  store: ProsperoStore,
  crypto: CredentialCrypto,
  timeout = 30_000,
  web?: WebClient,
) {
  return new DesktopService(
    store,
    new SignalCredentialVault(store, crypto, 'darwin'),
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    undefined,
    web ? () => web : undefined,
    timeout,
  );
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Credential fixture did not settle.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
async function turn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const savedInput: ProviderInput = {
  id: 'saved',
  displayName: 'Offline',
  baseUrl: 'https://offline.example/v1',
  model: 'offline',
};
function saveExisting(store: ProsperoStore, baseUrl = savedInput.baseUrl) {
  const config = { ...savedInput, id: 'saved', baseUrl, supportsTools: true, timeoutMs: 1000 };
  store.saveProvider(config);
}
function storedCipher(store: ProsperoStore, id: string) {
  const ciphertext = store.encryptedCredential(id);
  if (!ciphertext) throw new Error('Missing offline credential fixture.');
  return Buffer.from(ciphertext);
}
async function endpointServer() {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
    for await (const _chunk of request) {
      /* consume actual request */
    }
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'offline' }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Offline task complete.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Offline endpoint did not listen.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function run(service: DesktopService, id: string, text = 'offline conversation') {
  await service.sendTask(id, text);
  await until(() =>
    ['completed', 'failed', 'cancelled'].includes(service.getConversation(id).state),
  );
  return service.getConversation(id);
}

test('provider save deadline returns safely but keeps id reserved until late encryption settles', async () => {
  const store = new ProsperoStore(':memory:');
  saveExisting(store);
  let release: (ciphertext: Buffer) => void = () => {};
  let pendingNative = true;
  let started = false;
  const crypto = cryptoPort({
    encryptStringAsync: (plaintext) => {
      if (!pendingNative) return Promise.resolve(Buffer.from(plaintext));
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const service = serviceFor(store, crypto, 15);
  try {
    const c = service.createConversation();
    service.selectProvider(c.id, 'saved');
    const update = service.saveProvider({
      ...savedInput,
      baseUrl: 'https://other.example/v1',
      apiKey: 'OFFLINE_NEW',
    });
    await until(() => started);
    await expect(update).rejects.toThrow('timed out');
    expect(store.encryptedCredential('saved')).toBeUndefined();
    expect(service.bootstrap().providers[0].baseUrl).toBe(savedInput.baseUrl);
    await expect(service.saveProvider({ ...savedInput, apiKey: 'OFFLINE_SECOND' })).rejects.toThrow(
      'busy',
    );
    await expect(service.testProvider(savedInput)).rejects.toThrow('busy');
    expect(() => service.deleteProvider('saved')).toThrow('busy');
    await expect(service.sendTask(c.id, 'task')).rejects.toThrow('busy');
    release(Buffer.from('OFFLINE_LATE_CIPHERTEXT'));
    await turn();
    expect(store.encryptedCredential('saved')).toBeUndefined();
    expect(service.bootstrap().providers[0].baseUrl).toBe(savedInput.baseUrl);
    pendingNative = false;
    await service.saveProvider({ ...savedInput, apiKey: 'OFFLINE_EXPLICIT' });
    expect(
      await new SignalCredentialVault(store, crypto, 'darwin').get(
        'saved',
        undefined,
        savedInput.baseUrl,
      ),
    ).toBe('OFFLINE_EXPLICIT');
  } finally {
    release(Buffer.from('OFFLINE_LATE'));
    await service.shutdown();
    store.close();
  }
});

for (const cancellation of ['timeout', 'window-close'] as const) {
  test(`new provider ${cancellation} retains creation reservation until native availability actually settles`, async () => {
    const store = new ProsperoStore(':memory:');
    saveExisting(store);
    let held = true;
    let availabilityCalls = 0;
    let encryptedWrites = 0;
    let release = () => {};
    const saveEncrypted = store.saveEncryptedCredential.bind(store);
    store.saveEncryptedCredential = (id, ciphertext) => {
      encryptedWrites++;
      saveEncrypted(id, ciphertext);
    };
    const crypto = cryptoPort({
      isAsyncEncryptionAvailable: async () => {
        availabilityCalls++;
        if (!held) return true;
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
      },
    });
    const service = serviceFor(store, crypto, cancellation === 'timeout' ? 15 : 30_000);
    const draft: ProviderInput = {
      displayName: 'New offline draft',
      baseUrl: 'https://new.offline.example/v1',
      model: 'offline',
      apiKey: 'OFFLINE_NEW_DRAFT',
    };
    try {
      const saving = service.saveProvider(draft).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await until(() => availabilityCalls === 1);
      if (cancellation === 'window-close') await service.suspendWindow();
      const result = await saving;
      expect('error' in result ? result.error : undefined).toMatchObject(
        cancellation === 'timeout'
          ? { message: expect.stringContaining('timed out') }
          : { name: 'AbortError' },
      );
      if (cancellation === 'window-close') service.resumeWindow();
      await expect(service.saveProvider(draft)).rejects.toThrow('creation is busy');
      await expect(
        service.saveProvider({
          ...draft,
          displayName: 'Another new offline draft',
          baseUrl: 'https://different.offline.example/v1',
          apiKey: 'OFFLINE_DIFFERENT_DRAFT',
        }),
      ).rejects.toThrow('creation is busy');
      expect(availabilityCalls).toBe(1);
      expect(encryptedWrites).toBe(0);
      // An existing id still follows its own reservation rather than the new-provider gate.
      await service.saveProvider({ ...savedInput, displayName: 'Existing offline update' });
      expect(service.bootstrap().providers).toHaveLength(1);
      expect(service.bootstrap().providers[0].displayName).toBe('Existing offline update');
      expect(availabilityCalls).toBe(1);
      held = false;
      release();
      await turn();
      expect(encryptedWrites).toBe(0);
      expect(service.bootstrap().providers).toHaveLength(1);
      const fresh = await service.saveProvider(draft);
      expect(fresh.id).not.toBe('saved');
      expect(fresh.hasApiKey).toBe(true);
      expect(service.bootstrap().providers).toHaveLength(2);
      expect(availabilityCalls).toBe(2);
      expect(encryptedWrites).toBe(1);
      expect(
        await new SignalCredentialVault(store, crypto, 'darwin').get(
          fresh.id,
          undefined,
          draft.baseUrl,
        ),
      ).toBe('OFFLINE_NEW_DRAFT');
    } finally {
      held = false;
      release();
      await service.shutdown();
      await turn();
      store.close();
    }
  });
}

test('window close cancels Web Search save, rejects new work, and keeps reservation through reopen', async () => {
  const store = new ProsperoStore(':memory:');
  saveExisting(store);
  let release: (ciphertext: Buffer) => void = () => {};
  let started = false;
  let pendingNative = true;
  const crypto = cryptoPort({
    encryptStringAsync: (plaintext) => {
      if (!pendingNative) return Promise.resolve(Buffer.from(plaintext));
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const service = serviceFor(store, crypto);
  try {
    const c = service.createConversation();
    service.selectProvider(c.id, 'saved');
    const before = service.bootstrap().webSearch;
    const update = service.saveWebSearch({
      enabled: true,
      retention: 'session',
      apiKey: 'OFFLINE_WEB',
    });
    await until(() => started);
    const observed = update.then(
      () => ({ name: 'unexpected-success' }),
      (error: unknown) => error,
    );
    const closing = service.suspendWindow();
    await expect(service.saveProvider(savedInput)).rejects.toThrow('Reopen');
    await expect(service.testProvider(savedInput)).rejects.toThrow('Reopen');
    await expect(service.testWebSearch({ apiKey: 'OFFLINE_DRAFT' })).rejects.toThrow('Reopen');
    await expect(service.sendTask(c.id, 'task')).rejects.toThrow('Reopen');
    await closing;
    expect(await observed).toMatchObject({ name: 'AbortError' });
    service.resumeWindow();
    await expect(service.saveWebSearch({ enabled: false, retention: 'sources' })).rejects.toThrow(
      'wait',
    );
    await expect(service.sendTask(c.id, 'task')).rejects.toThrow('Web Search');
    release(Buffer.from('OFFLINE_LATE_CIPHERTEXT'));
    await turn();
    expect(store.encryptedCredential('brave-search')).toBeUndefined();
    expect(service.bootstrap().webSearch).toEqual(before);
    pendingNative = false;
    await service.saveWebSearch({
      enabled: true,
      retention: 'sources',
      apiKey: 'OFFLINE_EXPLICIT_WEB',
    });
    expect(
      await new SignalCredentialVault(store, crypto, 'darwin').get(
        'brave-search',
        undefined,
        BRAVE_SEARCH_ENDPOINT,
      ),
    ).toBe('OFFLINE_EXPLICIT_WEB');
  } finally {
    release(Buffer.from('OFFLINE_LATE'));
    await service.shutdown();
    store.close();
  }
});

test('shutdown cancels stored-provider probe before native decrypt returns and sends no HTTP', async () => {
  const endpoint = await endpointServer();
  const store = new ProsperoStore(':memory:');
  saveExisting(store, endpoint.baseUrl);
  let release: (value: { result: string; shouldReEncrypt: boolean }) => void = () => {};
  let started = false;
  const crypto = cryptoPort({
    decryptStringAsync: () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const vault = new SignalCredentialVault(store, crypto, 'darwin');
  await vault.put('saved', 'OFFLINE_STORED', undefined, endpoint.baseUrl);
  const service = serviceFor(store, crypto);
  try {
    const input = { ...savedInput, baseUrl: endpoint.baseUrl };
    const probe = service.testProvider(input);
    await until(() => started);
    const closing = service.shutdown();
    await expect(service.saveProvider(input)).rejects.toThrow('Reopen');
    await closing;
    expect((await probe).status).toBe('cancelled');
    service.resumeWindow();
    await expect(service.testProvider({ ...input, apiKey: 'OFFLINE_DRAFT' })).rejects.toThrow(
      'busy',
    );
    release({ result: 'OFFLINE_LATE_PRIVATE_KEY', shouldReEncrypt: true });
    await turn();
    expect(endpoint.requests).toEqual([]);
    expect((await service.testProvider({ ...input, apiKey: 'OFFLINE_EXPLICIT' })).status).toBe(
      'connected',
    );
    expect(endpoint.requests).toEqual([
      { url: '/v1/models', authorization: 'Bearer OFFLINE_EXPLICIT' },
    ]);
  } finally {
    release({ result: '', shouldReEncrypt: false });
    await service.shutdown();
    store.close();
    await endpoint.close();
  }
});

test('Stop during task key initialization retains provider reservation and discards late key without HTTP', async () => {
  const endpoint = await endpointServer();
  const store = new ProsperoStore(':memory:');
  saveExisting(store, endpoint.baseUrl);
  let release: (value: { result: string; shouldReEncrypt: boolean }) => void = () => {};
  let started = false;
  const crypto = cryptoPort({
    decryptStringAsync: () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await new SignalCredentialVault(store, crypto, 'darwin').put(
    'saved',
    'OFFLINE_STORED',
    undefined,
    endpoint.baseUrl,
  );
  const service = serviceFor(store, crypto);
  try {
    const c = service.createConversation();
    service.selectProvider(c.id, 'saved');
    await service.sendTask(c.id, 'offline conversation');
    await until(() => started);
    await service.stopTask(c.id);
    expect(service.getConversation(c.id).state).toBe('cancelled');
    await expect(
      service.saveProvider({ ...savedInput, baseUrl: endpoint.baseUrl, apiKey: 'OFFLINE_NEW' }),
    ).rejects.toThrow('busy');
    await expect(service.sendTask(c.id, 'second task')).rejects.toThrow('busy');
    release({ result: 'OFFLINE_LATE_KEY', shouldReEncrypt: true });
    await turn();
    expect(endpoint.requests).toEqual([]);
    await service.saveProvider({
      ...savedInput,
      baseUrl: endpoint.baseUrl,
      apiKey: 'OFFLINE_EXPLICIT',
    });
    service.deleteProvider('saved');
  } finally {
    release({ result: '', shouldReEncrypt: false });
    await service.shutdown();
    store.close();
    await endpoint.close();
  }
});

test('Web Search stored-key deadline includes native decryption and cannot emit a late probe', async () => {
  const store = new ProsperoStore(':memory:');
  let release: (value: { result: string; shouldReEncrypt: boolean }) => void = () => {};
  let searches = 0;
  const crypto = cryptoPort({
    decryptStringAsync: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await new SignalCredentialVault(store, crypto, 'darwin').put(
    'brave-search',
    'OFFLINE_STORED',
    undefined,
    BRAVE_SEARCH_ENDPOINT,
  );
  const service = serviceFor(store, crypto, 5, {
    search: async () => {
      searches++;
      return [];
    },
    fetchPage: async () => {
      throw new Error('Unused');
    },
  });
  try {
    const result = await service.testWebSearch({});
    expect(result.status).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('OFFLINE_STORED');
    await expect(service.testWebSearch({ apiKey: 'OFFLINE_DRAFT' })).rejects.toThrow('wait');
    release({ result: 'OFFLINE_LATE_KEY', shouldReEncrypt: true });
    await turn();
    expect(searches).toBe(0);
    expect((await service.testWebSearch({ apiKey: 'OFFLINE_EXPLICIT' })).status).toBe('connected');
    expect(searches).toBe(1);
  } finally {
    release({ result: '', shouldReEncrypt: false });
    await service.shutdown();
    store.close();
  }
});

test('ciphertext committed before provider SQL failure cannot send the new key to old endpoint, including after restart', async () => {
  const oldEndpoint = await endpointServer();
  const newEndpoint = await endpointServer();
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'prospero-credential-fault-')));
  const database = join(temp, 'app.sqlite');
  const crypto = cryptoPort();
  let store = new ProsperoStore(database);
  let service = serviceFor(store, crypto);
  const fault = new DatabaseSync(database);
  try {
    const input = {
      displayName: 'Offline provider',
      baseUrl: oldEndpoint.baseUrl,
      model: 'offline',
      apiKey: 'OFFLINE_OLD',
    };
    const config = await service.saveProvider(input);
    const c = service.createConversation();
    service.selectProvider(c.id, config.id);
    const originalCipher = storedCipher(store, config.id);
    fault.exec(
      "CREATE TRIGGER fail_provider BEFORE INSERT ON providers BEGIN SELECT RAISE(ABORT, 'offline provider write fault'); END",
    );
    await expect(
      service.saveProvider({
        ...input,
        id: config.id,
        baseUrl: newEndpoint.baseUrl,
        apiKey: 'OFFLINE_NEW',
      }),
    ).rejects.toThrow('offline provider write fault');
    expect(storedCipher(store, config.id)).not.toEqual(originalCipher);
    expect(service.bootstrap().providers[0].baseUrl).toBe(oldEndpoint.baseUrl);
    let failed = await run(service, c.id);
    expect(failed.state).toBe('failed');
    expect(failed.timeline.some((item) => item.text?.includes('Re-enter the API key'))).toBe(true);
    expect(oldEndpoint.requests).toEqual([]);
    expect(newEndpoint.requests).toEqual([]);
    expect(
      (await service.testProvider({ ...input, id: config.id, apiKey: undefined })).status,
    ).toBe('auth');
    expect(oldEndpoint.requests).toEqual([]);
    await service.shutdown();
    store.close();
    store = new ProsperoStore(database);
    service = serviceFor(store, crypto);
    failed = await run(service, c.id, 'continue after restart');
    expect(failed.state).toBe('failed');
    expect(oldEndpoint.requests).toEqual([]);
    expect(newEndpoint.requests).toEqual([]);
    fault.exec('DROP TRIGGER fail_provider');
    await service.saveProvider({
      ...input,
      id: config.id,
      baseUrl: newEndpoint.baseUrl,
      apiKey: 'OFFLINE_EXPLICIT_REPAIR',
    });
    const completed = await run(service, c.id, 'offline conversation after explicit repair');
    expect(completed.state).toBe('completed');
    expect(oldEndpoint.requests).toEqual([]);
    expect(newEndpoint.requests).toEqual([
      { url: '/v1/chat/completions', authorization: 'Bearer OFFLINE_EXPLICIT_REPAIR' },
    ]);
    expect(JSON.stringify(completed)).not.toContain('OFFLINE_EXPLICIT_REPAIR');
  } finally {
    await service.shutdown();
    store.close();
    fault.close();
    await oldEndpoint.close();
    await newEndpoint.close();
    await rm(temp, { recursive: true, force: true });
  }
});

for (const stage of ['availability', 'encrypt', 'decrypt', 're-encrypt'] as const) {
  test(`shutdown closes SQLite safely before late native ${stage} settles`, async () => {
    const endpoint = await endpointServer();
    const store = new ProsperoStore(':memory:');
    saveExisting(store, endpoint.baseUrl);
    let active = false;
    let held = false;
    let closed = false;
    let closedAccesses = 0;
    let release = () => {};
    const crypto = cryptoPort({
      isAsyncEncryptionAvailable: async () => {
        if (!active || stage !== 'availability') return true;
        held = true;
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
      },
      encryptStringAsync: async (plaintext) => {
        if (!active || !['encrypt', 're-encrypt'].includes(stage)) return Buffer.from(plaintext);
        held = true;
        return new Promise<Buffer>((resolve) => {
          release = () => resolve(Buffer.from(plaintext));
        });
      },
      decryptStringAsync: async (ciphertext) => {
        const result = {
          result: ciphertext.toString(),
          shouldReEncrypt: active && stage === 're-encrypt',
        };
        if (!active || stage !== 'decrypt') return result;
        held = true;
        return new Promise<typeof result>((resolve) => {
          release = () => resolve(result);
        });
      },
    });
    await new SignalCredentialVault(store, crypto, 'darwin').put(
      'saved',
      'OFFLINE_STORED',
      undefined,
      endpoint.baseUrl,
    );
    const service = serviceFor(store, crypto);
    const originalRead = store.encryptedCredential.bind(store);
    const originalWrite = store.saveEncryptedCredential.bind(store);
    store.encryptedCredential = (id) => {
      if (closed) closedAccesses++;
      return originalRead(id);
    };
    store.saveEncryptedCredential = (id, ciphertext) => {
      if (closed) closedAccesses++;
      originalWrite(id, ciphertext);
    };
    try {
      active = true;
      const input = { ...savedInput, baseUrl: endpoint.baseUrl };
      const saving = stage === 'availability' || stage === 'encrypt';
      const pending = saving
        ? service.saveProvider({ ...input, apiKey: 'OFFLINE_REPLACEMENT' })
        : service.testProvider(input);
      const observed = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await until(() => held);
      await service.shutdown();
      const result = await observed;
      if (saving)
        expect('error' in result ? result.error : undefined).toMatchObject({ name: 'AbortError' });
      else
        expect('value' in result ? result.value : undefined).toMatchObject({ status: 'cancelled' });
      store.close();
      closed = true;
      release();
      await turn();
      await turn();
      expect(closedAccesses).toBe(0);
      expect(endpoint.requests).toEqual([]);
    } finally {
      release();
      if (!closed) {
        await service.shutdown();
        store.close();
      }
      await endpoint.close();
    }
  });
}
