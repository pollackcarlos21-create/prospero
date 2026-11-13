import { expect, test } from 'bun:test';
import { ProsperoStore } from '@prospero/persistence';
import { ExecutionAdmission } from './execution-admission';
import { DesktopService } from './service';

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('Chat and Dot ownership is exclusive and a released generation cannot release a newer one', () => {
  const admission = new ExecutionAdmission();
  const chat = admission.acquire({ kind: 'chat', id: 'chat-1' });
  expect(admission.owner).toEqual({ kind: 'chat', id: 'chat-1' });
  expect(Object.isFrozen(admission.owner)).toBe(true);
  expect(() => admission.acquire({ kind: 'dot', id: 'dot-1' })).toThrow('running task or Dot');
  chat.release();
  const dot = admission.acquire({ kind: 'dot', id: 'dot-1' });
  chat.release();
  expect(admission.owner).toEqual({ kind: 'dot', id: 'dot-1' });
  expect(() => admission.acquire({ kind: 'chat', id: 'chat-2' })).toThrow();
  dot.release();
  expect(admission.owner).toBeUndefined();
});

test('Dot admission blocks actual Chat dispatch before credential access; Stop releases a hung initialization', async () => {
  const admission = new ExecutionAdmission();
  const store = new ProsperoStore(':memory:');
  const entered = barrier<void>();
  const credential = barrier<string>();
  let reads = 0;
  let requests = 0;
  store.saveProvider({
    id: 'offline',
    displayName: 'Offline',
    baseUrl: 'https://offline.example.test/v1',
    model: 'fixture',
    timeoutMs: 60000,
    supportsTools: true,
    hasApiKey: true,
  });
  store.setSetting('ui', {
    theme: 'light',
    defaultProviderId: 'offline',
    askBeforeReads: false,
    memory: [],
  });
  const fetchPort: typeof fetch = Object.assign(
    async () => {
      requests++;
      throw new Error('This test must not dispatch a model request.');
    },
    { preconnect: () => {} },
  );
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: async () => {
        reads++;
        entered.release();
        return credential.promise;
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    'test',
    undefined,
    undefined,
    undefined,
    30000,
    fetchPort,
    admission,
  );
  let dot = admission.acquire({ kind: 'dot', id: 'dot-1' });
  try {
    const conversation = service.createConversation();
    await expect(service.sendTask(conversation.id, 'Read the evidence.')).rejects.toThrow(
      'running task or Dot',
    );
    expect(reads).toBe(0);
    expect(requests).toBe(0);
    expect(service.getConversation(conversation.id).messages).toEqual([]);
    dot.release();
    await service.sendTask(conversation.id, 'Read the evidence.');
    await entered.promise;
    expect(admission.owner).toEqual({ kind: 'chat', id: conversation.id });
    expect(() => admission.acquire({ kind: 'dot', id: 'dot-2' })).toThrow();
    await service.stopTask(conversation.id);
    expect(service.getConversation(conversation.id).state).toBe('cancelled');
    expect(admission.owner).toBeUndefined();
    dot = admission.acquire({ kind: 'dot', id: 'dot-2' });
    credential.release('offline-fixture-only');
    await service.shutdown();
    expect(admission.owner).toEqual({ kind: 'dot', id: 'dot-2' });
    expect(requests).toBe(0);
  } finally {
    credential.release('offline-fixture-only');
    dot.release();
    await service.shutdown();
    store.close();
  }
});

test('failed preflight leaves the shared execution slot available', async () => {
  const admission = new ExecutionAdmission();
  const store = new ProsperoStore(':memory:');
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    'test',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    admission,
  );
  try {
    await expect(
      service.sendTask(service.createConversation().id, 'No configured provider.'),
    ).rejects.toThrow('model provider');
    expect(admission.owner).toBeUndefined();
    const dot = admission.acquire({ kind: 'dot', id: 'dot-next' });
    dot.release();
  } finally {
    await service.shutdown();
    store.close();
  }
});
