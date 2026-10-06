import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolHost } from '../../packages/core/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { TOOL_LIMITS } from '../../packages/tools/src';
import { BRAVE_SEARCH_ENDPOINT, type WebClient, type WebSource } from '../../packages/web/src';
import type { Conversation, DesktopEvent } from '../../apps/desktop/src/bridge';
import {
  DesktopService,
  type DesktopHost,
  type CredentialVault,
} from '../../apps/desktop/src/main/service';
import { retainedWebResult, withWebTools } from '../../apps/desktop/src/main/web-tools';
import { startFakeProvider, type CapturedRequest, type FakeResponse } from '../e2e/fake-provider';

const fullBody = 'EPHEMERAL_FULL_PAGE_BODY_MARKER';
const excerptMarker = 'SESSION_ONLY_SOURCE_EXCERPT_MARKER';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing required test fixture value');
  return value;
}
function source(index = 1, content = fullBody): WebSource {
  return {
    id: `src_${String(index).padStart(24, '0')}`,
    url: `https://example.org/evidence-${index}`,
    title: `Evidence ${index}`,
    kind: 'page',
    retrievedAt: new Date().toISOString(),
    contentHash: 'd'.repeat(64),
    excerpt: excerptMarker,
    content,
    trust: 'untrusted',
  };
}
function fakeWeb() {
  const search = mock(
    async (_query: string, _options?: { signal?: AbortSignal; maxResults?: number }) => [source()],
  );
  const fetchPage = mock(async (_url: string, _options?: { signal?: AbortSignal }) => source());
  const client: WebClient = { search, fetchPage };
  return { client, search, fetchPage };
}
function emptyLocal(): ToolHost {
  return {
    definitions: [],
    prepare: async () => {
      throw new Error('No local tools in this fixture');
    },
  };
}
async function waitUntil<T>(read: () => T, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read();
    if (accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the local test execution');
}
async function permission(service: DesktopService, id: string) {
  const conversation: Conversation = await waitUntil(
    () => service.getConversation(id),
    (value) => !!value.pendingPermission,
  );
  return required(conversation.pendingPermission);
}
async function fixture(
  respond?: (
    request: CapturedRequest,
    task: string,
    results: CapturedRequest['messages'],
  ) => FakeResponse | undefined,
) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'prospero-v02-service-')));
  const root = join(temp, 'files');
  await mkdir(root);
  await writeFile(join(root, 'input.txt'), 'Public local fixture.\n');
  const provider = await startFakeProvider(respond);
  const store = new ProsperoStore(join(temp, 'prospero.sqlite'));
  const events: DesktopEvent[] = [];
  const credentials = new Map<string, string>();
  const puts = mock(async (id: string, key: string) => {
    credentials.set(id, key);
    store.saveEncryptedCredential(id, new Uint8Array([1, 2, 3, 4]));
  });
  const gets = mock(async (id: string) => credentials.get(id));
  const vault: CredentialVault = { put: puts, get: gets };
  const opened: string[] = [];
  const web = fakeWeb();
  const webFactory = mock((_apiKey: string) => web.client);
  let selectedFolder: string | undefined = root;
  const host: DesktopHost = {
    appearance: () => ({ dark: false, reducedMotion: false }),
    ready: () => {},
    contextMenu: () => {},
    copy: () => {},
    reveal: () => {},
    taskFinished: () => {},
    openSource: async (url) => {
      opened.push(url);
    },
  };
  const service = new DesktopService(
    store,
    vault,
    { folder: async () => selectedFolder, files: async () => [] },
    (event) => events.push(structuredClone(event)),
    '0.2.0',
    undefined,
    host,
    webFactory,
  );
  const config = await service.saveProvider({
    displayName: 'Offline',
    baseUrl: provider.baseUrl,
    model: 'offline',
    supportsTools: true,
  });
  const conversation = service.createConversation();
  service.selectProvider(conversation.id, config.id);
  return {
    temp,
    root,
    provider,
    store,
    service,
    conversation,
    events,
    credentials,
    puts,
    gets,
    web,
    webFactory,
    opened,
    selectFolder: (value: string | undefined) => {
      selectedFolder = value;
    },
    close: async () => {
      await service.shutdown();
      await provider.close();
      store.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
const webResearch = (
  _request: CapturedRequest,
  _task: string,
  results: CapturedRequest['messages'],
): FakeResponse =>
  !results.length
    ? { tool: 'fetch_page', args: { url: 'https://example.org/evidence-1' } }
    : { text: 'Research task complete.' };

describe('v0.2 main service with offline provider and WebClient', () => {
  test('explicit read selection downgrades legacy workspace access and revocation removes all aliases', async () => {
    const value = await fixture();
    try {
      const id = value.conversation.id;
      const workspace = await value.service.chooseWorkspace(id);
      expect(workspace.workspace).toBe(value.root);
      expect(workspace.scopes?.[0].mode).toBe('write');
      const read = await value.service.addScope(id, 'read');
      expect(read.workspace).toBeUndefined();
      expect(read.scopes).toHaveLength(1);
      expect(read.scopes?.[0].mode).toBe('read');
      const writable = await value.service.addScope(id, 'write');
      expect(writable.scopes).toHaveLength(1);
      expect(writable.scopes?.[0].mode).toBe('write');
      expect(value.service.removeScope(id, required(writable.scopes?.[0]).id).scopes).toEqual([]);
      expect(value.service.getConversation(id).workspace).toBeUndefined();
      await value.service.chooseWorkspace(id);
      const replaced = await value.service.addScope(id, 'write');
      expect(replaced.scopes?.[0].id).not.toBe('workspace');
      const revoked = value.service.removeScope(id, required(replaced.scopes?.[0]).id);
      expect(revoked.workspace).toBeUndefined();
      expect(revoked.scopes).toEqual([]);
    } finally {
      await value.close();
    }
  });
  test('exact plan digest is required and legacy/session decisions cannot grant batch execution', async () => {
    let scopeId = '';
    const value = await fixture((_request, _task, results) =>
      !results.length
        ? {
            tool: 'execute_plan',
            args: {
              title: 'Create a note',
              actions: [
                {
                  kind: 'write_text',
                  target: { scopeId, path: 'note.txt' },
                  content: 'Approved note.\n',
                },
              ],
            },
          }
        : { text: 'Plan complete.' },
    );
    try {
      const id = value.conversation.id;
      scopeId = required((await value.service.addScope(id, 'write')).scopes?.[0]).id;
      await value.service.sendTask(id, 'Create a local note');
      const pending = await permission(value.service, id);
      expect(pending.preview.plan?.actions).toHaveLength(1);
      expect(pending.allowSession).toBe(false);
      expect(() => value.service.decidePermission(id, pending.requestId, 'allow-session')).toThrow(
        'digest',
      );
      expect(() => value.service.decidePermission(id, pending.requestId, 'allow-once')).toThrow(
        'digest',
      );
      expect(() =>
        value.service.decideActionPlan(id, pending.requestId, 'f'.repeat(64), 'allow-once'),
      ).toThrow('changed');
      await expect(readFile(join(value.root, 'note.txt'), 'utf8')).rejects.toThrow();
      value.service.decideActionPlan(
        id,
        pending.requestId,
        required(pending.preview.plan).digest,
        'allow-once',
      );
      const finished = await waitUntil(
        () => value.service.getConversation(id),
        (c) => c.state === 'completed',
      );
      expect(await readFile(join(value.root, 'note.txt'), 'utf8')).toBe('Approved note.\n');
      expect(finished.actionPlans?.[0].status).toBe('completed');
      expect(finished.actionPlans?.[0].journal.map((entry) => entry.status)).toContain('succeeded');
    } finally {
      await value.close();
    }
  });
  test('enabled Web networking is pending until one-time approval and deny performs no fetch', async () => {
    const value = await fixture(webResearch);
    try {
      const id = value.conversation.id;
      await value.service.saveWebSearch({
        enabled: true,
        retention: 'sources',
        apiKey: 'offline-search-key',
      });
      await value.service.sendTask(id, 'Read public research');
      const pending = await permission(value.service, id);
      expect(pending.preview.kind).toBe('web');
      expect(pending.allowSession).toBe(false);
      expect(value.web.fetchPage).not.toHaveBeenCalled();
      expect(() => value.service.decidePermission(id, pending.requestId, 'allow-session')).toThrow(
        'every time',
      );
      value.service.decidePermission(id, pending.requestId, 'deny');
      await waitUntil(
        () => value.service.getConversation(id),
        (c) => c.state === 'completed',
      );
      expect(value.web.fetchPage).not.toHaveBeenCalled();
      expect(value.web.search).not.toHaveBeenCalled();
    } finally {
      await value.close();
    }
  });
  test('stored search credential is injected into main adapter only, never returned in IPC/bootstrap or SQLite plaintext', async () => {
    const value = await fixture(webResearch);
    try {
      const key = 'offline-main-only-search-credential';
      const saved = await value.service.saveWebSearch({
        enabled: true,
        retention: 'sources',
        apiKey: key,
      });
      expect(saved).toEqual({
        provider: 'brave',
        enabled: true,
        retention: 'sources',
        hasApiKey: true,
      });
      expect(value.puts).toHaveBeenCalledWith(
        'brave-search',
        key,
        expect.any(AbortSignal),
        BRAVE_SEARCH_ENDPOINT,
      );
      const id = value.conversation.id;
      await value.service.sendTask(id, 'Research');
      const pending = await permission(value.service, id);
      expect(value.webFactory).toHaveBeenCalledWith(key, 'brave');
      expect(JSON.stringify(value.service.bootstrap())).not.toContain(key);
      expect(JSON.stringify(value.events)).not.toContain(key);
      expect(JSON.stringify(value.store.getSetting('web-search', {}))).not.toContain(key);
      value.service.decidePermission(id, pending.requestId, 'deny');
      await waitUntil(
        () => value.service.getConversation(id),
        (c) => c.state === 'completed',
      );
      const removed = await value.service.saveWebSearch({
        enabled: false,
        retention: 'session',
        clearApiKey: true,
      });
      expect(removed.hasApiKey).toBe(false);
      expect(value.store.encryptedCredential('brave-search')).toBeUndefined();
    } finally {
      await value.close();
    }
  });
  test('full web body reaches only the current model execution and never renderer events or durable conversation snapshots', async () => {
    const value = await fixture(webResearch);
    try {
      const id = value.conversation.id;
      await value.service.saveWebSearch({
        enabled: true,
        retention: 'sources',
        apiKey: 'offline-search-key',
      });
      await value.service.sendTask(id, 'Research');
      const pending = await permission(value.service, id);
      value.service.decidePermission(id, pending.requestId, 'allow-once');
      const finished = await waitUntil(
        () => value.service.getConversation(id),
        (c) => c.state === 'completed',
      );
      expect(value.web.fetchPage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(value.provider.requests)).toContain(fullBody);
      expect(JSON.stringify(value.events)).not.toContain(fullBody);
      expect(JSON.stringify(finished)).not.toContain(fullBody);
      expect(JSON.stringify(value.store.conversations())).not.toContain(fullBody);
      expect(JSON.stringify(value.store.conversations())).not.toContain(excerptMarker);
      expect(value.store.sources(id)).toHaveLength(1);
      expect(finished.sources).toHaveLength(1);
      await value.service.openSource(id, source().id);
      expect(value.opened).toEqual([source().url]);
      await expect(value.service.openSource(id, 'src_unknown')).rejects.toThrow('retained');
      await expect(value.service.openSource(id, 'https://evil.example/')).rejects.toThrow();
      expect(value.opened).toHaveLength(1);
    } finally {
      await value.close();
    }
  });
  test('session source provenance is absent from durable snapshots and does not survive restart', async () => {
    const value = await fixture(webResearch);
    try {
      const id = value.conversation.id;
      await value.service.saveWebSearch({
        enabled: true,
        retention: 'session',
        apiKey: 'offline-search-key',
      });
      await value.service.sendTask(id, 'Research');
      const pending = await permission(value.service, id);
      value.service.decidePermission(id, pending.requestId, 'allow-once');
      const finished = await waitUntil(
        () => value.service.getConversation(id),
        (c) => c.state === 'completed',
      );
      expect(finished.sources).toHaveLength(1);
      expect(value.store.sources(id)).toEqual([]);
      expect(JSON.stringify(value.store.conversations())).not.toContain(excerptMarker);
      expect(JSON.stringify(value.store.conversations())).not.toContain(fullBody);
      await value.service.shutdown();
      const restored = new DesktopService(
        value.store,
        { put: async () => {}, get: async () => undefined },
        { folder: async () => undefined, files: async () => [] },
        () => {},
        '0.2.0',
      );
      expect(restored.getConversation(id).sources).toEqual([]);
      expect(JSON.stringify(restored.getConversation(id))).not.toContain(excerptMarker);
      await restored.shutdown();
    } finally {
      await value.close();
    }
  });
});

describe('v0.2 main Web adapter bounds and independent approval', () => {
  test('UTF-8 and JSON escaping cannot exceed the 32 KiB tool output budget', async () => {
    const hostileBody = '中文😀"\\\n'.repeat(20_000);
    const values = Array.from({ length: 10 }, (_, index) => ({
      ...source(index + 1, hostileBody),
      excerpt: '摘录'.repeat(600),
    }));
    const web: WebClient = { search: async () => values, fetchPage: async () => values[0] };
    const host = withWebTools(emptyLocal(), web);
    const signal = new AbortController().signal;
    const tool = await host.prepare(
      { id: 'search', name: 'web_search', arguments: '{"query":"中文 evidence","maxResults":10}' },
      signal,
    );
    await tool.onDecision?.('allow-once');
    const result = await tool.execute(signal);
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
    const body = JSON.parse(result.content) as {
      sources: Array<{ content: string; contentHash: string }>;
    };
    expect(body.sources.length).toBeLessThan(values.length);
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources.every((entry) => entry.contentHash.length === 64)).toBe(true);
    expect(result.sources).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(retainedWebResult(result).content).not.toContain(hostileBody);
    expect(retainedWebResult(result).sources).toBeUndefined();
  });
  test('a single approval cannot be reused or replayed to perform additional web requests', async () => {
    const value = fakeWeb();
    const host = withWebTools(emptyLocal(), value.client);
    const signal = new AbortController().signal;
    const prepared = await host.prepare(
      {
        id: 'fetch-once',
        name: 'fetch_page',
        arguments: '{"url":"https://example.org/evidence-1"}',
      },
      signal,
    );
    await prepared.onDecision?.('allow-once');
    const results = await Promise.all([prepared.execute(signal), prepared.execute(signal)]);
    expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(value.fetchPage).toHaveBeenCalledTimes(1);
    await prepared.onDecision?.('allow-once');
    expect((await prepared.execute(signal)).isError).toBe(true);
    expect(value.fetchPage).toHaveBeenCalledTimes(1);
  });
  test('host-side approval is required even if execute is called directly; denial cannot be retried', async () => {
    const value = fakeWeb();
    const host = withWebTools(emptyLocal(), value.client);
    const signal = new AbortController().signal;
    const call = {
      id: 'fetch',
      name: 'fetch_page',
      arguments: '{"url":"https://example.org/evidence-1"}',
    };
    const pending = await host.prepare(call, signal);
    expect((await pending.execute(signal)).isError).toBe(true);
    expect(value.fetchPage).not.toHaveBeenCalled();
    await pending.onDecision?.('deny');
    await pending.onDecision?.('allow-once');
    expect((await pending.execute(signal)).isError).toBe(true);
    await expect(host.prepare({ ...call, id: 'repeat' }, signal)).rejects.toThrow('denied');
    expect(value.fetchPage).not.toHaveBeenCalled();
  });
  test('search and page inputs containing credentials fail before WebClient I/O', async () => {
    const value = fakeWeb();
    const key = 'private-credential-marker';
    const host = withWebTools(emptyLocal(), value.client, [key]);
    const signal = new AbortController().signal;
    await expect(
      host.prepare(
        { id: 'search', name: 'web_search', arguments: JSON.stringify({ query: key }) },
        signal,
      ),
    ).rejects.toThrow('credential');
    await expect(
      host.prepare(
        {
          id: 'fetch',
          name: 'fetch_page',
          arguments: JSON.stringify({ url: `https://example.org/?key=${key}` }),
        },
        signal,
      ),
    ).rejects.toThrow('credential');
    expect(value.search).not.toHaveBeenCalled();
    expect(value.fetchPage).not.toHaveBeenCalled();
  });
});
