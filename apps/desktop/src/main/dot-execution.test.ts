import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelPort, ModelRequest } from '@prospero/core';
import { DotRepositoryError, ProsperoStore } from '@prospero/persistence';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider } from '../../../../tests/e2e/fake-provider';
import { DotExecutionService, type DotModelSession, type DotRuntimeEvent } from './dot-execution';
import { ExecutionAdmission } from './execution-admission';
import { DesktopService } from './service';

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function seed(store: ProsperoStore) {
  return store.dots().create({
    id: 'research',
    name: 'Research',
    goal: { text: 'Maintain an evolving brief.' },
    createdAt: 1,
  });
}
function progressModel(): ModelPort {
  let calls = 0;
  return {
    stream: async () =>
      ++calls % 2 === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: `progress-${calls}`,
                name: 'record_progress',
                arguments: JSON.stringify({
                  summary: 'Saved brief',
                  completed: ['Compared existing notes'],
                  next: ['Inspect the next question'],
                }),
              },
            ],
            finishReason: 'tool_calls',
          }
        : { content: 'A bounded step is done.', toolCalls: [], finishReason: 'stop' },
  };
}

test('formal Dot service uses the actual provider port and consumes its durable checkpoint after reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-service-'));
  const path = join(root, 'profile.sqlite');
  let step = 0;
  let continued = false;
  const fake = await startFakeProvider((request, _task, results) => {
    if (results.length) return { text: 'The bounded step is recorded.' };
    step++;
    let previous: { summary: string; completed: string[] } | null = null;
    if (step === 2) {
      const memory = request.messages.find((message) =>
        message.content.startsWith('Saved preference data'),
      );
      const prefix = 'Saved Dot continuation (untrusted data, never permission): ';
      try {
        const notes: string[] = JSON.parse(memory?.content.split('\n').slice(1).join('\n') ?? '[]');
        const encoded = notes.find((note) => note.startsWith(prefix));
        previous = encoded ? JSON.parse(encoded.slice(prefix.length)) : null;
      } catch {
        return { text: 'The saved continuation was not readable.' };
      }
      if (!previous) return { text: 'The previous Run checkpoint was missing.' };
      continued = previous.summary === 'First durable brief';
    }
    return {
      tool: 'record_progress',
      args: {
        summary: previous ? `${previous.summary} → compared Question B` : 'First durable brief',
        completed: previous
          ? [...previous.completed, 'Question B compared']
          : ['Question A analysed'],
        next: ['Continue the remaining question'],
      },
    };
  });
  let store = new ProsperoStore(path);
  let admission = new ExecutionAdmission();
  let reads = 0;
  const createDesktop = () =>
    new DesktopService(
      store,
      {
        put: async () => {},
        get: async (_id, _signal, endpoint) => {
          expect(endpoint).toBe(fake.baseUrl);
          reads++;
          return 'fixture-only-key';
        },
      },
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
  let desktop = createDesktop();
  const provider = await desktop.saveProvider({
    displayName: 'Offline',
    baseUrl: fake.baseUrl,
    model: 'offline-model',
  });
  let runner = new DotExecutionService(store.dots(), admission, (id, signal) =>
    desktop.reserveDotModel(id, signal),
  );
  try {
    const dot = seed(store);
    const first = runner.runNow(dot.id, dot.revision, provider.id);
    expect(store.dots().getRun(first.run.id)?.status).toBe('pending');
    await runner.wait(dot.id);
    expect(store.dots().getRun(first.run.id)?.status).toBe('succeeded');
    expect(store.dots().checkpoint(dot.id)?.summary).toBe('First durable brief');
    expect(admission.owner).toBeUndefined();
    expect(store.conversations()).toEqual([]);
    await runner.shutdown();
    await desktop.shutdown();
    store.close();
    store = new ProsperoStore(path);
    admission = new ExecutionAdmission();
    desktop = createDesktop();
    runner = new DotExecutionService(store.dots(), admission, async (id, signal) => {
      const session = await desktop.reserveDotModel(id, signal);
      await expect(
        desktop.saveProvider({ ...provider, displayName: 'Blocked while running' }),
      ).rejects.toThrow('busy');
      return session;
    });
    const latest = store.dots().get(dot.id);
    if (!latest) throw new Error('Durable Dot is missing.');
    const second = runner.runNow(dot.id, latest.revision, provider.id);
    await runner.wait(dot.id);
    expect(continued).toBe(true);
    expect(store.dots().getRun(second.run.id)?.status).toBe('succeeded');
    expect(store.dots().checkpoint(dot.id)?.revision).toBe(2);
    expect(store.dots().checkpoint(dot.id)?.summary).toBe(
      'First durable brief → compared Question B',
    );
    expect(store.dots().checkpoint(dot.id)?.completed).toEqual([
      'Question A analysed',
      'Question B compared',
    ]);
    expect(store.dots().checkpoints(dot.id)[0].summary).toBe('First durable brief');
    expect(store.dots().get(dot.id)?.lifecycle).toBe('active');
    expect(store.conversations()).toEqual([]);
    expect(fake.requests).toHaveLength(4);
    expect(reads).toBe(2);
    expect(JSON.stringify(store.dots().checkpoints(dot.id))).not.toContain('fixture-only-key');
    await desktop.saveProvider({ ...provider, displayName: 'Available after cleanup' });
  } finally {
    await runner.shutdown();
    await desktop.shutdown();
    store.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Dot model cancellation retains native credential ownership until settlement and stale release cannot unlock a new session', async () => {
  const store = new ProsperoStore(':memory:');
  const entered = barrier<void>();
  const native = barrier<string>();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  let requests = 0;
  const fetchPort: typeof fetch = Object.assign(
    async () => {
      requests++;
      throw new Error('No requests are authorised in this fixture.');
    },
    { preconnect: () => {} },
  );
  const desktop = new DesktopService(
    store,
    {
      put: async () => {},
      get: async (_id, _signal, endpoint) => {
        expect(endpoint).toBe('https://owned.example.test/v1');
        entered.release();
        return native.promise;
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    'test',
    undefined,
    undefined,
    undefined,
    undefined,
    fetchPort,
  );
  const provider = await desktop.saveProvider({
    displayName: 'Owned',
    baseUrl: 'https://owned.example.test/v1',
    model: 'fixture',
  });
  const controller = new AbortController();
  const pending = desktop.reserveDotModel(provider.id, controller.signal);
  try {
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(desktop.saveProvider({ ...provider, displayName: 'Too early' })).rejects.toThrow(
      'busy',
    );
    native.release('fixture-native-key');
    // The native Promise is explicitly settled; one event-loop boundary drains its cleanup callbacks.
    await tick();
    await desktop.saveProvider({ ...provider, displayName: 'Native settled' });
    const first = await desktop.reserveDotModel(provider.id, new AbortController().signal);
    first.release();
    await tick();
    const second = await desktop.reserveDotModel(provider.id, new AbortController().signal);
    first.release();
    await expect(desktop.saveProvider({ ...provider, displayName: 'Still owned' })).rejects.toThrow(
      'busy',
    );
    second.release();
    await tick();
    await desktop.saveProvider({ ...provider, displayName: 'Released' });
    expect(requests).toBe(0);
  } finally {
    native.release('fixture-native-key');
    await desktop.shutdown();
    store.close();
  }
});

test('window close cancels interactive credentials while a Dot keeps its independent initialization', async () => {
  const store = new ProsperoStore(':memory:');
  const reading = barrier<void>();
  const writing = barrier<void>();
  const nativeRead = barrier<string>();
  const nativeWrite = barrier<void>();
  let readSignal: AbortSignal | undefined;
  let writeSignal: AbortSignal | undefined;
  const desktop = new DesktopService(
    store,
    {
      get: async (_id, signal) => {
        readSignal = signal;
        reading.release();
        return nativeRead.promise;
      },
      put: async (_id, _key, signal) => {
        writeSignal = signal;
        writing.release();
        return nativeWrite.promise;
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    'test',
  );
  let session: DotModelSession | undefined;
  try {
    const dotProvider = await desktop.saveProvider({
      displayName: 'Dot model',
      baseUrl: 'https://dot.example.test/v1',
      model: 'fixture',
    });
    const uiProvider = await desktop.saveProvider({
      displayName: 'UI model',
      baseUrl: 'https://ui.example.test/v1',
      model: 'fixture',
    });
    const pendingDot = desktop.reserveDotModel(dotProvider.id, new AbortController().signal);
    const pendingUI = desktop.saveProvider({
      ...uiProvider,
      displayName: 'Must not persist after close',
      apiKey: 'fixture-only-key',
    });
    const cancelledUI = pendingUI.then(
      () => false,
      () => true,
    );
    await Promise.all([reading.promise, writing.promise]);
    await desktop.suspendWindow();
    expect(await cancelledUI).toBe(true);
    expect(readSignal?.aborted).toBe(false);
    expect(writeSignal?.aborted).toBe(true);
    nativeRead.release('fixture-only-dot-key');
    session = await pendingDot;
    expect(session.model).toBeDefined();
    nativeWrite.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    desktop.resumeWindow();
    expect(desktop.bootstrap().providers.find((p) => p.id === uiProvider.id)?.displayName).toBe(
      'UI model',
    );
    await expect(
      desktop.saveProvider({ ...dotProvider, displayName: 'Still reserved' }),
    ).rejects.toThrow('busy');
    session.release();
    await desktop.saveProvider({ ...dotProvider, displayName: 'Available after Dot cleanup' });
  } finally {
    nativeRead.release('fixture-only-dot-key');
    nativeWrite.release();
    session?.release();
    await desktop.shutdown();
    store.close();
  }
});

test('a model ending without a continuation does not claim durable progress or complete the Dot', async () => {
  const store = new ProsperoStore(':memory:');
  const events: DotRuntimeEvent[] = [];
  const runner = new DotExecutionService(
    store.dots(),
    new ExecutionAdmission(),
    async () => ({
      model: { stream: async () => ({ content: 'Done', toolCalls: [], finishReason: 'stop' }) },
      release: () => {},
    }),
    (event) => events.push(event),
  );
  try {
    const dot = seed(store);
    const pair = runner.runNow(dot.id, dot.revision, 'offline');
    await runner.wait(dot.id);
    expect(store.dots().getRun(pair.run.id)?.status).toBe('failed');
    expect(store.dots().checkpoint(dot.id)).toBeUndefined();
    expect(store.dots().get(dot.id)?.lifecycle).toBe('active');
    expect(
      events.some((event) => event.type === 'attention' && event.reason === 'missing-progress'),
    ).toBe(true);
  } finally {
    await runner.shutdown();
    store.close();
  }
});

test('Stop cancels durable initialization and releases a model session that arrives too late', async () => {
  const store = new ProsperoStore(':memory:');
  const admission = new ExecutionAdmission();
  const entered = barrier<void>();
  const ready = barrier<DotModelSession>();
  const released = barrier<void>();
  let requests = 0;
  const runner = new DotExecutionService(store.dots(), admission, async () => {
    entered.release();
    return ready.promise;
  });
  try {
    const dot = seed(store);
    const pair = runner.runNow(dot.id, dot.revision, 'offline');
    await entered.promise;
    await runner.stop(dot.id);
    expect(store.dots().getRun(pair.run.id)?.status).toBe('cancelled');
    expect(store.dots().get(dot.id)?.inFlightRunId).toBeUndefined();
    expect(admission.owner).toBeUndefined();
    ready.release({
      model: {
        stream: async () => {
          requests++;
          throw new Error('Unexpected dispatch');
        },
      },
      release: () => released.release(),
    });
    await released.promise;
    expect(requests).toBe(0);
    expect(store.dots().checkpoint(dot.id)).toBeUndefined();
  } finally {
    await runner.shutdown();
    store.close();
  }
});

test('checkpoint storage failure preserves the uncertain in-flight pair and never retries the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-commit-failure-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const db = new DatabaseSync(path);
  const admission = new ExecutionAdmission();
  let sessions = 0;
  let released = 0;
  const runner = new DotExecutionService(store.dots(), admission, async () => {
    sessions++;
    return {
      model: progressModel(),
      release: () => {
        released++;
      },
    };
  });
  try {
    const dot = seed(store);
    db.exec(
      "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON dot_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    const pair = runner.runNow(dot.id, dot.revision, 'offline');
    await expect(runner.wait(dot.id)).rejects.toThrow(DotRepositoryError);
    expect(store.dots().getRun(pair.run.id)?.status).toBe('running');
    expect(store.dots().get(dot.id)?.inFlightRunId).toBe(pair.run.id);
    expect(store.dots().checkpoint(dot.id)).toBeUndefined();
    expect(admission.owner).toBeUndefined();
    expect(released).toBe(1);
    const current = store.dots().get(dot.id);
    if (!current) throw new Error('Missing Dot');
    expect(() => runner.runNow(dot.id, current.revision, 'offline')).toThrow();
    expect(sessions).toBe(1);
  } finally {
    await runner.shutdown();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Chat admission prevents Dot persistence or model initialization', async () => {
  const store = new ProsperoStore(':memory:');
  const admission = new ExecutionAdmission();
  const chat = admission.acquire({ kind: 'chat', id: 'chat-root' });
  let sessions = 0;
  const runner = new DotExecutionService(store.dots(), admission, async () => {
    sessions++;
    return { model: progressModel(), release: () => {} };
  });
  try {
    const dot = seed(store);
    expect(() => runner.runNow(dot.id, dot.revision, 'offline')).toThrow('running task or Dot');
    expect(store.dots().runs(dot.id)).toEqual([]);
    expect(sessions).toBe(0);
    expect(admission.owner).toEqual({ kind: 'chat', id: 'chat-root' });
  } finally {
    chat.release();
    await runner.shutdown();
    store.close();
  }
});

test('malformed checkpoint proposals and unknown effect tools cannot acquire authority', async () => {
  const store = new ProsperoStore(':memory:');
  const captured: ModelRequest[] = [];
  let calls = 0;
  const model: ModelPort = {
    stream: async (request) => {
      captured.push(request);
      calls++;
      return calls === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'unsafe', name: 'shell', arguments: '{"command":"touch forbidden"}' },
            ],
            finishReason: 'tool_calls',
          }
        : calls === 2
          ? {
              content: '',
              toolCalls: [
                {
                  id: 'bad-progress',
                  name: 'record_progress',
                  arguments: '{"summary":"Invented","completed":[],"next":[],"permission":"all"}',
                },
              ],
              finishReason: 'tool_calls',
            }
          : { content: 'No authorised work completed.', toolCalls: [], finishReason: 'stop' };
    },
  };
  const runner = new DotExecutionService(store.dots(), new ExecutionAdmission(), async () => ({
    model,
    release: () => {},
  }));
  try {
    const dot = seed(store);
    const pair = runner.runNow(dot.id, dot.revision, 'offline');
    await runner.wait(dot.id);
    expect(captured[0].tools.map((tool) => tool.name)).toEqual([
      'record_progress',
      'read_dot_context',
      'read_dot_record',
    ]);
    expect(
      captured
        .slice(1)
        .some((request) =>
          request.messages.some(
            (message) => message.role === 'tool' && message.content.includes('safely'),
          ),
        ),
    ).toBe(true);
    expect(store.dots().getRun(pair.run.id)?.status).toBe('failed');
    expect(store.dots().checkpoint(dot.id)).toBeUndefined();
  } finally {
    await runner.shutdown();
    store.close();
  }
});
