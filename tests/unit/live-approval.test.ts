import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PermissionRequest, ResearchPlan } from '../../packages/core/src';
import { captureFileScope, createLocalToolHost } from '../../packages/local-host/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { ReviewedLivePermission, livePermissionFingerprint } from '../acceptance/live-approval';

function action(request: PermissionRequest) {
  const value = request.preview.plan?.actions[0];
  if (!value) throw new Error('Missing host action.');
  return value;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prospero-reviewed-')));
  await writeFile(path.join(root, 'source.txt'), 'fixture original');
  const scope = await captureFileScope(root, 'write');
  const store = new ProsperoStore(path.join(root, 'fixture.sqlite'));
  store.saveConversation({
    id: 'review-conversation',
    title: 'Offline review fixture',
    state: 'planning',
    updatedAt: 1,
  });
  const host = createLocalToolHost({
    scopes: [scope],
    journal: store.actionJournal('review-conversation', 'review-execution'),
  });
  const signal = new AbortController().signal;
  const prepared = await host.prepare(
    {
      id: 'review-call',
      name: 'execute_plan',
      arguments: JSON.stringify({
        title: 'Copy approved fixture',
        actions: [
          {
            kind: 'copy_file',
            source: { scopeId: scope.id, path: 'source.txt' },
            target: { scopeId: scope.id, path: 'copy.txt' },
          },
        ],
      }),
    },
    signal,
  );
  const request: PermissionRequest = {
    requestId: 'review-request',
    call: prepared.call,
    preview: prepared.preview,
    permissionKey: prepared.permissionKey,
    allowSession: prepared.allowSession,
  };
  const options = {
    boundary: { roots: [root], scopeIds: [scope.id] },
    humanReviewed: true,
    expiresAt: 2000,
    now: () => 1000,
  };
  return { root, store, prepared, request, options, signal };
}

test('actual host snapshot review matches full content and only grants one execution', async () => {
  const { root, store, prepared, request, options, signal } = await fixture();
  try {
    const review = new ReviewedLivePermission(request, options);
    expect(review.claim(request)).toBe('allow-once');
    await prepared.onDecision?.('allow-once');
    expect((await prepared.execute(signal)).isError).not.toBe(true);
    expect(await readFile(path.join(root, 'copy.txt'), 'utf8')).toBe('fixture original');
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('fixture original');
    expect(() => review.claim(request)).toThrow('used');
    expect(() => new ReviewedLivePermission(request, options).claim(request)).toThrow('used');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata flags cannot replace trusted human review and mutable options cannot widen it', async () => {
  const { root, store, request, options } = await fixture();
  try {
    const pending = { ...options, humanReviewed: false };
    const review = new ReviewedLivePermission(request, pending);
    pending.humanReviewed = true;
    options.boundary.roots.push('/');
    expect(() => review.claim(request)).toThrow('review');
    expect(() =>
      new ReviewedLivePermission(request, {
        ...options,
        boundary: { roots: [root], scopeIds: [...options.boundary.scopeIds] },
        humanReviewed: undefined,
      }).claim(request),
    ).toThrow('review');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('changed target, bytes, hash, effects, scope, call or snapshot identity needs a new review', async () => {
  const { root, store, request, options } = await fixture();
  try {
    for (const mutate of [
      (r: PermissionRequest) => {
        r.call.arguments += ' ';
      },
      (r: PermissionRequest) => {
        r.requestId = 'new-request';
      },
      (r: PermissionRequest) => {
        if (r.preview.plan) r.preview.plan.digest = 'f'.repeat(64);
      },
      (r: PermissionRequest) => {
        action(r).bytes = 999;
      },
      (r: PermissionRequest) => {
        action(r).afterHash = 'f'.repeat(64);
      },
      (r: PermissionRequest) => {
        action(r).target = path.join(root, 'other.txt');
      },
    ]) {
      const changed = structuredClone(request);
      mutate(changed);
      expect(() => new ReviewedLivePermission(request, options).claim(changed)).toThrow('snapshot');
    }
    const out = structuredClone(request);
    if (!out.preview.plan) throw new Error('Missing host plan.');
    action(out).target = path.join(root, '..', 'outside.txt');
    expect(() => new ReviewedLivePermission(request, options).claim(out)).toThrow('scope');
    const session = { ...request, allowSession: true };
    expect(() => new ReviewedLivePermission(session, options)).toThrow('scope');
    const shell = { ...request, call: { ...request.call, name: 'shell' } };
    expect(() => new ReviewedLivePermission(shell, options)).toThrow('scope');
    const effects = structuredClone(request);
    action(effects).effects = ['process.execute'];
    expect(() => new ReviewedLivePermission(effects, options)).toThrow('scope');
    expect(() =>
      new ReviewedLivePermission(request, { ...options, now: () => 2000 }).claim(request),
    ).toThrow('expired');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('full reviewed research queries and task identity cannot be altered by page data', () => {
  const research: ResearchPlan = {
    version: 1,
    id: 'scope-1',
    digest: 'a'.repeat(64),
    conversationId: 'conversation-1',
    executionId: 'execution-1',
    title: 'Research fixture',
    createdAt: 1000,
    expiresAt: 2000,
    queries: [{ query: 'public fixture paper', maxResults: 3 }],
    maxSearches: 1,
    maxFetches: 2,
    maxResponseBytes: 4096,
  };
  const request: PermissionRequest = {
    requestId: 'research-request',
    call: { id: 'scope-call', name: 'authorize_research', arguments: '{}' },
    preview: { kind: 'research', title: 'Review', research },
    permissionKey: 'exact-snapshot',
    allowSession: false,
  };
  const options = {
    boundary: { roots: ['/private/tmp/prospero-fixture'], scopeIds: ['workspace'] },
    humanReviewed: true,
    expiresAt: 2000,
    now: () => 1000,
  };
  for (const field of ['query', 'execution', 'budget'] as const) {
    const changed = structuredClone(request);
    const value = changed.preview.research;
    if (!value) throw new Error('Missing research snapshot.');
    changed.preview.research =
      field === 'query'
        ? { ...value, queries: [{ query: 'page supplied unauthorized query', maxResults: 3 }] }
        : field === 'execution'
          ? { ...value, executionId: 'new-run' }
          : { ...value, maxFetches: 200 };
    expect(() => new ReviewedLivePermission(request, options).claim(changed)).toThrow('snapshot');
  }
  expect(new ReviewedLivePermission(request, options).claim(request)).toBe('allow-once');
  expect(() =>
    livePermissionFingerprint({
      ...request,
      preview: { ...request.preview, title: (() => {}) as unknown as string },
    }),
  ).toThrow('snapshot');
});
