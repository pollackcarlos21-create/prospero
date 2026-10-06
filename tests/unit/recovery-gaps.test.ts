import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore } from '../../packages/persistence/src';
import { WebError, type WebClient, type WebSource } from '../../packages/web/src';
import type { Conversation, DesktopEvent } from '../../apps/desktop/src/bridge';
import { DesktopService } from '../../apps/desktop/src/main/service';
import { startFakeProvider, type CapturedRequest, type FakeResponse } from '../e2e/fake-provider';

// These are source-grounded gap reproducers, not the fixed-30 acceptance harness.
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing recovery fixture value.');
  return value;
}
async function until<T>(read: () => T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Recovery fixture did not settle.');
}
function runtime(database: string, root: string, web?: WebClient) {
  const store = new ProsperoStore(database);
  const events: DesktopEvent[] = [];
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => 'OFFLINE_SEARCH_MARKER' },
    { folder: async () => root, files: async () => [] },
    (event) => events.push(structuredClone(event)),
    '0.2.0',
    undefined,
    undefined,
    web ? () => web : undefined,
  );
  return { store, service, events };
}
async function fixture(
  respond: (
    request: CapturedRequest,
    task: string,
    results: CapturedRequest['messages'],
  ) => FakeResponse,
  web?: WebClient,
) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'prospero-recovery-gaps-')));
  const root = join(temp, 'files');
  await mkdir(root);
  await writeFile(join(root, 'original.txt'), 'Known original content.\n');
  const database = join(temp, 'app.sqlite');
  const provider = await startFakeProvider(respond);
  let current = runtime(database, root, web);
  const config = await current.service.saveProvider({
    displayName: 'Offline recovery fixture',
    baseUrl: provider.baseUrl,
    model: 'offline',
    supportsTools: true,
  });
  const conversation = current.service.createConversation();
  const id = conversation.id;
  current.service.selectProvider(id, config.id);
  await current.service.chooseWorkspace(id);
  let open = true;
  return {
    temp,
    root,
    database,
    id,
    provider,
    get service() {
      return current.service;
    },
    get store() {
      return current.store;
    },
    get events() {
      return current.events;
    },
    async closeRuntime() {
      if (!open) return;
      await current.service.shutdown();
      current.store.close();
      open = false;
    },
    reopen() {
      if (open) throw new Error('Close the old runtime before reopening.');
      current = runtime(database, root, web);
      open = true;
    },
    async close() {
      if (open) {
        await current.service.shutdown();
        current.store.close();
      }
      await provider.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
async function pending(value: Awaited<ReturnType<typeof fixture>>) {
  const c = await until(
    () => value.service.getConversation(value.id),
    (entry) => !!entry.pendingPermission,
  );
  return required(c.pendingPermission);
}
async function finished(value: Awaited<ReturnType<typeof fixture>>) {
  return until(
    () => value.service.getConversation(value.id),
    (entry) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.state),
  );
}
function plan(title: string, names: string[]): FakeResponse {
  return {
    tool: 'execute_plan',
    args: {
      title,
      actions: names.map((name) => ({
        kind: 'write_text',
        target: { scopeId: 'workspace', path: name },
        content: `${name} approved content.\n`,
      })),
    },
  };
}
function lastStatuses(c: Conversation, index = 0) {
  const record = required(c.actionPlans?.[index]);
  const latest = new Map(record.journal.map((entry) => [entry.actionId, entry.status]));
  return record.plan.actions.map((action) => latest.get(action.id));
}

test('C04 full service Stop reports completed and unfinished research without another model request', async () => {
  const queries = ['First recovery paper', 'Second recovery paper'];
  const source: WebSource = {
    id: `src_${'1'.repeat(24)}`,
    url: 'https://example.org/first-paper',
    title: 'First paper',
    kind: 'search',
    retrievedAt: new Date().toISOString(),
    contentHash: 'a'.repeat(64),
    excerpt: 'Public evidence excerpt',
    content: 'EPHEMERAL_C04_BODY',
    trust: 'untrusted',
  };
  let startedSecond: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    startedSecond = resolve;
  });
  const requests: string[] = [];
  const web: WebClient = {
    async search(query, options = {}) {
      requests.push(query);
      if (query === queries[0]) {
        options.onResponseBytes?.(100);
        return [source];
      }
      return new Promise<readonly WebSource[]>((_resolve, reject) => {
        const stopped = () => reject(new WebError('cancelled'));
        options.signal?.addEventListener('abort', stopped, { once: true });
        startedSecond?.();
        if (options.signal?.aborted) stopped();
      });
    },
    async fetchPage() {
      throw new Error('No page request is expected.');
    },
  };
  const value = await fixture((_request, _task, results) => {
    if (!results.length)
      return {
        tool: 'authorize_research',
        args: {
          title: 'Research two papers',
          queries: queries.map((query) => ({ query, maxResults: 1 })),
          maxFetches: 0,
          maxResponseBytes: 1024 * 1024,
          lifetimeSeconds: 60,
        },
      };
    return { tool: 'web_search', args: { query: queries[results.length - 1] } };
  }, web);
  try {
    await value.service.saveWebSearch({ enabled: true, retention: 'sources' });
    await value.service.sendTask(value.id, 'C04 research two papers, stopping must report a list');
    const request = await pending(value);
    value.service.decideResearch(
      value.id,
      request.requestId,
      required(request.preview.research).digest,
      'allow-once',
    );
    await secondStarted;
    await value.service.stopTask(value.id);
    const stopped = value.service.getConversation(value.id);
    expect(stopped.state).toBe('cancelled');
    expect(requests).toEqual(queries);
    expect(stopped.sources?.map((entry) => entry.id)).toEqual([source.id]);
    const audit = required(stopped.researchPlans?.[0]).events;
    expect(audit.filter((event) => event.type === 'completed')).toHaveLength(1);
    expect(audit.filter((event) => event.type === 'failed')).toHaveLength(1);
    expect(audit.at(-1)?.type).toBe('closed');
    const report = required(
      stopped.messages.findLast((message) => message.role === 'assistant'),
    ).content;
    expect(report).toContain('Search completed (1 sources): First recovery paper');
    expect(report).toContain('Search not completed: Second recovery paper');
    expect(report).toContain(`Saved search source: First paper [source:${source.id}]`);
    expect(report).not.toContain('EPHEMERAL_C04_BODY');
    expect(report).not.toContain('Public evidence excerpt');
    expect(JSON.stringify(value.store.getConversation(value.id))).not.toContain(
      'EPHEMERAL_C04_BODY',
    );
    expect(value.provider.requests).toHaveLength(3);
  } finally {
    await value.close();
  }
});

test('C07 actual process exit exposes saved per-action facts and finishes only remaining work after a new approval', async () => {
  const value = await fixture((_request, task, results) => {
    if (task.startsWith('C07 crash'))
      return plan('Crash after second effect', ['first.txt', 'second.txt', 'third.txt']);
    if (!results.length) return { tool: 'list_directory', args: { path: '.' } };
    if (results.length === 1) return { tool: 'read_file', args: { path: 'second.txt' } };
    if (results.length === 2) return plan('New approval for remaining work', ['third.txt']);
    return { text: 'Verified existing first and second files, then completed the remaining file.' };
  });
  try {
    await value.closeRuntime();
    const servicePath = new URL('../../apps/desktop/src/main/service.ts', import.meta.url).pathname;
    const storePath = new URL('../../packages/persistence/src/index.ts', import.meta.url).pathname;
    const childCode = `
      import { DesktopService } from ${JSON.stringify(servicePath)};
      import { ProsperoStore } from ${JSON.stringify(storePath)};
      const store = new ProsperoStore(process.env.PROSPERO_RECOVERY_DB);
      const original = store.actionJournal.bind(store);
      store.actionJournal = (...args) => {
        const journal = original(...args);
        return {
          ...journal,
          transition(planId, actionId, status, detail) {
            if (actionId === 'action-2' && status === 'succeeded') process.exit(23);
            journal.transition(planId, actionId, status, detail);
          },
        };
      };
      let service;
      const approvedRequests = new Set();
      service = new DesktopService(store,
        { put: async () => {}, get: async () => undefined },
        { folder: async () => undefined, files: async () => [] },
        event => {
          if (event.type !== 'conversation' || !event.conversation.pendingPermission) return;
          const request = event.conversation.pendingPermission;
          if (!request.preview.plan || approvedRequests.has(request.requestId)) return;
          approvedRequests.add(request.requestId);
          queueMicrotask(() => service.decideActionPlan(event.conversation.id,
            request.requestId, request.preview.plan.digest, 'allow-once'));
        }, '0.2.0');
      await service.sendTask(process.env.PROSPERO_RECOVERY_ID, 'C07 crash after real file effects');
    `;
    const child = Bun.spawn([process.execPath, '--eval', childCode], {
      cwd: new URL('../../', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: value.temp,
        PROSPERO_RECOVERY_DB: value.database,
        PROSPERO_RECOVERY_ID: value.id,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const exit = await child.exited;
    clearTimeout(timer);
    const stderr = await new Response(child.stderr).text();
    expect({ exit, stderr }).toEqual({ exit: 23, stderr: '' });
    expect(await readFile(join(value.root, 'first.txt'), 'utf8')).toBe(
      'first.txt approved content.\n',
    );
    expect(await readFile(join(value.root, 'second.txt'), 'utf8')).toBe(
      'second.txt approved content.\n',
    );
    await expect(stat(join(value.root, 'third.txt'))).rejects.toThrow();
    value.reopen();
    const restored = value.service.getConversation(value.id);
    expect(restored.state).toBe('interrupted');
    expect(lastStatuses(restored)).toEqual(['succeeded', 'interrupted', 'interrupted']);
    const oldPlan = required(restored.actionPlans?.[0]);
    expect(oldPlan.journal.findLast((entry) => entry.actionId === 'action-2')?.detail).toContain(
      'effect may have occurred',
    );
    expect(restored.pendingPermission).toBeUndefined();
    expect(value.provider.requests).toHaveLength(1);
    await value.service.sendTask(
      value.id,
      'C07 recover: inspect existing files and finish third.txt',
    );
    const newRequest = await pending(value);
    const recoveryInput = required(value.provider.requests[1]);
    expect(JSON.stringify(recoveryInput.messages)).toContain('effect may have occurred');
    expect(JSON.stringify(recoveryInput.messages)).toContain(oldPlan.plan.id);
    expect(JSON.stringify(recoveryInput.messages)).toContain('needs-inspection');
    expect(JSON.stringify(recoveryInput.messages)).toContain('approvalRestored');
    expect(JSON.stringify(recoveryInput.messages)).toContain('Execution interrupted');
    expect(required(newRequest.preview.plan).id).not.toBe(oldPlan.plan.id);
    expect(required(newRequest.preview.plan).actions.map((action) => action.target)).toEqual([
      join(value.root, 'third.txt'),
    ]);
    value.service.decideActionPlan(
      value.id,
      newRequest.requestId,
      required(newRequest.preview.plan).digest,
      'allow-once',
    );
    const recovered = await finished(value);
    expect(recovered.state).toBe('completed');
    expect(recovered.actionPlans?.map((entry) => entry.status)).toEqual([
      'interrupted',
      'completed',
    ]);
    expect(await readFile(join(value.root, 'third.txt'), 'utf8')).toBe(
      'third.txt approved content.\n',
    );
    expect(lastStatuses(recovered)).toEqual(['succeeded', 'interrupted', 'interrupted']);
  } finally {
    await value.close();
  }
}, 15000);

test('C09 full service blocks a failed running commit, then inspection and a fresh approval actually finish the task', async () => {
  const value = await fixture((_request, task, results) => {
    if (task.startsWith('C09 initial'))
      return results.length
        ? { text: 'Storage prevented this task from completing.' }
        : plan('Initial storage-sensitive plan', ['recovered.txt']);
    if (!results.length) return { tool: 'list_directory', args: { path: '.' } };
    if (results.length === 1) return plan('Rechecked recovery plan', ['recovered.txt']);
    return { text: 'Recovery completed after rechecking and a new approval.' };
  });
  const observer = new DatabaseSync(value.database);
  try {
    observer.exec(
      "CREATE TRIGGER c09_fail_running BEFORE INSERT ON action_journal WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'C09_PRIVATE_DB_FAILURE'); END;",
    );
    await value.service.sendTask(value.id, 'C09 initial create recovered.txt');
    const first = await pending(value);
    const firstPlan = required(first.preview.plan);
    value.service.decideActionPlan(value.id, first.requestId, firstPlan.digest, 'allow-once');
    const failed = await finished(value);
    expect(failed.actionPlans?.[0].status).toBe('failed');
    expect(lastStatuses(failed)).toEqual(['failed']);
    await expect(stat(join(value.root, 'recovered.txt'))).rejects.toThrow();
    expect(JSON.stringify(failed)).not.toContain('C09_PRIVATE_DB_FAILURE');
    observer.exec('DROP TRIGGER c09_fail_running');
    await value.service.sendTask(
      value.id,
      'C09 recover: inspect the directory, then create recovered.txt',
    );
    const second = await pending(value);
    const secondPlan = required(second.preview.plan);
    expect(second.requestId).not.toBe(first.requestId);
    expect(secondPlan.id).not.toBe(firstPlan.id);
    expect(() =>
      value.service.decideActionPlan(value.id, first.requestId, firstPlan.digest, 'allow-once'),
    ).toThrow('changed');
    expect(
      value.service
        .getConversation(value.id)
        .timeline.some(
          (item) => item.call?.name === 'list_directory' && !!item.result && !item.result.isError,
        ),
    ).toBe(true);
    await expect(stat(join(value.root, 'recovered.txt'))).rejects.toThrow();
    value.service.decideActionPlan(value.id, second.requestId, secondPlan.digest, 'allow-once');
    const recovered = await finished(value);
    expect(recovered.state).toBe('completed');
    expect(recovered.actionPlans?.map((entry) => entry.status)).toEqual(['failed', 'completed']);
    expect(lastStatuses(recovered, 1)).toEqual(['succeeded']);
    expect(await readFile(join(value.root, 'recovered.txt'), 'utf8')).toBe(
      'recovered.txt approved content.\n',
    );
    expect(value.store.getConversation<Conversation>(value.id)?.state).toBe('completed');
  } finally {
    observer.close();
    await value.close();
  }
});

test('successful alternative-page research preserves the final answer after a failed page attempt', async () => {
  const query = 'Alternative page paper';
  const makeSource = (number: string, kind: WebSource['kind']): WebSource => ({
    id: `src_${number.repeat(24)}`,
    url: `https://example.org/alternative-${number}`,
    title: `Alternative ${number}`,
    kind,
    retrievedAt: new Date().toISOString(),
    contentHash: number.repeat(64),
    excerpt: 'Public fixture excerpt',
    content: 'EPHEMERAL_ALTERNATIVE_PAGE',
    trust: 'untrusted',
  });
  const first = makeSource('1', 'search');
  const second = makeSource('2', 'search');
  const page = { ...makeSource('3', 'page'), url: second.url };
  const web: WebClient = {
    async search(_query, options) {
      options?.onResponseBytes?.(100);
      return [first, second];
    },
    async fetchPage(url, options) {
      if (url === first.url) throw new WebError('http');
      options?.onResponseBytes?.(200);
      return page;
    },
  };
  const answer = `Alternative research completed using the fetched page [source:${page.id}]`;
  const value = await fixture((_request, _task, results) => {
    if (!results.length)
      return {
        tool: 'authorize_research',
        args: {
          title: 'Research with an alternative page',
          queries: [{ query, maxResults: 2 }],
          maxFetches: 2,
          maxResponseBytes: 4 * 1024 * 1024,
          lifetimeSeconds: 60,
        },
      };
    if (results.length === 1) return { tool: 'web_search', args: { query } };
    if (results.length === 2) return { tool: 'fetch_source', args: { sourceId: first.id } };
    if (results.length === 3) return { tool: 'fetch_source', args: { sourceId: second.id } };
    return { text: answer };
  }, web);
  try {
    await value.service.saveWebSearch({ enabled: true, retention: 'sources' });
    await value.service.sendTask(
      value.id,
      'Research a paper, using an alternative after a failed page',
    );
    const request = await pending(value);
    value.service.decideResearch(
      value.id,
      request.requestId,
      required(request.preview.research).digest,
      'allow-once',
    );
    const completed = await finished(value);
    expect(completed.state).toBe('completed');
    expect(completed.messages.at(-1)?.content).toBe(answer);
    expect(
      completed.sources?.some((source) => source.id === page.id && source.kind === 'page'),
    ).toBe(true);
    expect(completed.researchPlans?.[0].events.some((event) => event.type === 'failed')).toBe(true);
    expect(completed.messages.some((message) => message.content.startsWith('Task stopped.'))).toBe(
      false,
    );
    expect(value.provider.requests).toHaveLength(5);
  } finally {
    await value.close();
  }
});
