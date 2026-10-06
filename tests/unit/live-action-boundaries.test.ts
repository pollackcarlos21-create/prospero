import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { PermissionRequest, PreparedTool, StructuredAction } from '../../packages/core/src';
import { captureFileScope, createLocalToolHost } from '../../packages/local-host/src';
import { ProsperoStore } from '../../packages/persistence/src';
import {
  createLiveActionBoundaries,
  type LiveActionBoundaryOptions,
} from '../acceptance/live-action-boundaries';
import { createLiveFixture, LIVE_CONTROLLED_EDIT_TEXT } from '../acceptance/live-fixtures';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ref = (scopeId: string, path: string) => ({ scopeId, path });
async function fixture(caseId: string, hooks: Partial<LiveActionBoundaryOptions> = {}) {
  const files = await createLiveFixture(caseId);
  const profile = join(dirname(files.root), 'owned-profile');
  await mkdir(profile, { mode: 0o700 });
  const databasePath = join(profile, 'profile.sqlite');
  const store = new ProsperoStore(databasePath);
  const conversationId = 'offline-controlled-boundary';
  const initial: Conversation = {
    id: conversationId,
    title: 'Offline actual host/SQLite boundary',
    state: 'idle',
    updatedAt: Date.now(),
    messages: [],
    timeline: [],
    attachments: [],
    streamingText: '',
  };
  store.saveConversation(initial);
  let activePending: PermissionRequest | undefined;
  const get = () => {
    const value = store.getConversation<Conversation>(conversationId);
    if (!value) throw new Error('Offline conversation is missing.');
    return {
      ...value,
      pendingPermission: activePending,
      actionPlans: store.actionPlans(conversationId),
    };
  };
  const update = (patch: Partial<Conversation>) => {
    if (Object.hasOwn(patch, 'pendingPermission')) activePending = patch.pendingPermission;
    const value: Conversation = { ...get(), ...patch };
    delete value.pendingPermission;
    delete value.actionPlans;
    store.saveConversation(value);
  };
  let phaseId = 'initial';
  const controller = new AbortController();
  let stopCalls = 0;
  let nativeCalls = 0;
  const options: LiveActionBoundaryOptions = {
    fixture: files,
    store,
    databasePath,
    conversationId,
    phaseId: () => phaseId,
    getConversation: get,
    stopTask: () => {
      stopCalls++;
      controller.abort();
    },
    nativeTrash: {
      adapter: 'offline-injected',
      trash: async (path) => {
        nativeCalls++;
        await rm(path); // Explicit offline replacement, never native/live evidence.
      },
    },
    ...hooks,
  };
  const boundaries = await createLiveActionBoundaries(options);
  const scope = await captureFileScope(files.root, 'write');
  let run = 0;
  async function prepare(actions: StructuredAction[]) {
    const journal = boundaries.wrapJournal(store.actionJournal(conversationId, `run-${++run}`));
    const host = createLocalToolHost({
      scopes: [scope],
      journal,
      native: { trash: boundaries.trash, reveal() {}, copyPath() {} },
    });
    const prepared = await host.prepare(
      {
        id: `call-${run}`,
        name: 'execute_plan',
        arguments: JSON.stringify({ title: 'Reviewed fixture only', actions }),
      },
      new AbortController().signal,
    );
    const request: PermissionRequest = {
      requestId: `request-${run}`,
      call: prepared.call,
      preview: prepared.preview,
      permissionKey: prepared.permissionKey,
      allowSession: prepared.allowSession,
    };
    update({
      state: 'waiting-permission',
      pendingPermission: request,
      timeline: [
        ...get().timeline,
        { id: request.requestId, at: Date.now(), type: 'permission', request },
      ],
    });
    return { prepared, request };
  }
  async function execute(prepared: PreparedTool, decision: 'allow-once' | 'deny' = 'allow-once') {
    await prepared.onDecision?.(decision);
    const value = get();
    const item = value.timeline.findLast((entry) => entry.type === 'permission');
    if (item) item.decision = decision;
    update({ timeline: value.timeline, pendingPermission: undefined, state: 'tool-running' });
    const signal = phaseId === 'initial' ? controller.signal : new AbortController().signal;
    const result = await prepared.execute(signal);
    update({ state: signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed' });
    return result;
  }
  return {
    files,
    profile,
    databasePath,
    store,
    scope,
    options,
    boundaries,
    controller,
    get,
    update,
    prepare,
    execute,
    phase: (value: string) => {
      phaseId = value;
    },
    stopCalls: () => stopCalls,
    nativeCalls: () => nativeCalls,
    close: async () => {
      await boundaries.dispose();
      store.close();
      await files.close();
    },
  };
}

test('C05 commits the first actual effect before initiating abort; remaining effects wait for a new phase', async () => {
  const f = await fixture('C05');
  try {
    const { prepared } = await f.prepare(
      ['first', 'second', 'third'].map((name) => ({
        kind: 'write_text',
        target: ref(f.scope.id, `${name}.txt`),
        content: `${name}.txt approved content`,
      })),
    );
    const result = await f.execute(prepared);
    expect(f.stopCalls()).toBe(1);
    expect(result.planOutcome?.status).toBe('partial');
    const record = f.store.actionPlans(f.get().id)[0];
    expect(record.journal.findLast((entry) => entry.actionId === 'action-1')?.status).toBe(
      'succeeded',
    );
    expect(
      record.journal.filter((entry) => entry.status === 'running').map((entry) => entry.actionId),
    ).toEqual(['action-1']);
    expect(await readFile(join(f.files.root, 'first.txt'), 'utf8')).toBe(
      'first.txt approved content',
    );
    expect(existsSync(join(f.files.root, 'second.txt'))).toBe(false);
    expect(f.boundaries.evidence().observations).toHaveLength(0);
    await f.boundaries.prepareFollowUp(
      'request-stop-after-effect',
      'after-stop',
      new AbortController().signal,
    );
    expect(f.boundaries.evidence().observations?.[0]).toMatchObject({
      boundaryId: 'request-stop-after-effect',
      phaseId: 'initial',
      planId: record.plan.id,
      actionId: 'action-1',
    });
    expect(f.boundaries.evidence().checkpoints?.[0].label).toBe('after-stop');
    f.phase('after-stop');
    const next = await f.prepare(
      ['second', 'third'].map((name) => ({
        kind: 'write_text',
        target: ref(f.scope.id, `${name}.txt`),
        content: `${name}.txt approved content`,
      })),
    );
    expect((await f.execute(next.prepared)).planOutcome?.status).toBe('completed');
    expect(f.stopCalls()).toBe(1);
    expect(f.store.actionPlans(f.get().id).map((entry) => entry.plan.id)).toHaveLength(2);
    await expect(
      f.boundaries.prepareFollowUp(
        'request-stop-after-effect',
        'after-stop',
        new AbortController().signal,
      ),
    ).rejects.toThrow('inconsistent');
  } finally {
    await f.close();
  }
});

test('F10 edits only a real pending immutable source, forcing stale and preserving the external bytes', async () => {
  const f = await fixture('F10');
  try {
    const first = await f.prepare([
      {
        kind: 'copy_file',
        source: ref(f.scope.id, 'input.txt'),
        target: ref(f.scope.id, 'result.txt'),
      },
    ]);
    await f.boundaries.beforePermissionReview(
      first.request,
      'initial',
      new AbortController().signal,
    );
    expect(await readFile(join(f.files.root, 'input.txt'), 'utf8')).toBe(LIVE_CONTROLLED_EDIT_TEXT);
    expect((await f.execute(first.prepared)).planOutcome?.status).toBe('stale');
    expect(existsSync(join(f.files.root, 'result.txt'))).toBe(false);
    await f.boundaries.prepareFollowUp(
      'stale-before-approve',
      'after-stale',
      new AbortController().signal,
    );
    expect(f.boundaries.evidence().checkpoints?.[0].label).toBe('after-stale');
    f.phase('after-stale');
    const next = await f.prepare([
      {
        kind: 'copy_file',
        source: ref(f.scope.id, 'input.txt'),
        target: ref(f.scope.id, 'result.txt'),
      },
    ]);
    await f.boundaries.beforePermissionReview(
      next.request,
      'after-stale',
      new AbortController().signal,
    );
    expect((await f.execute(next.prepared)).planOutcome?.status).toBe('completed');
    expect(await readFile(join(f.files.root, 'result.txt'), 'utf8')).toBe(
      LIVE_CONTROLLED_EDIT_TEXT,
    );
    expect(next.request.preview.plan?.digest).not.toBe(first.request.preview.plan?.digest);
  } finally {
    await f.close();
  }
});

test('changed pending preview, missing actual pending state and closed/unbranded fixtures cannot authorize an external edit', async () => {
  const f = await fixture('F10');
  try {
    const { request } = await f.prepare([
      {
        kind: 'copy_file',
        source: ref(f.scope.id, 'input.txt'),
        target: ref(f.scope.id, 'result.txt'),
      },
    ]);
    const altered = structuredClone(request);
    altered.call.arguments += ' ';
    await expect(
      f.boundaries.beforePermissionReview(altered, 'initial', new AbortController().signal),
    ).rejects.toThrow('inconsistent');
    expect(await readFile(join(f.files.root, 'input.txt'), 'utf8')).toBe('Original bytes');
    f.update({ pendingPermission: undefined });
    await expect(
      f.boundaries.beforePermissionReview(request, 'initial', new AbortController().signal),
    ).rejects.toThrow('inconsistent');
    await expect(
      createLiveActionBoundaries({ ...f.options, fixture: { ...f.files } }),
    ).rejects.toThrow('invalid');
    await f.boundaries.dispose();
    await expect(f.boundaries.observeConversation()).rejects.toThrow('inconsistent');
  } finally {
    await f.close();
  }
});

test('C03 measures a responsive real pending wait and records absent effect; cancellation leaves no wait proof', async () => {
  const f = await fixture('C03');
  try {
    const pending = await f.prepare([
      {
        kind: 'write_text',
        target: ref(f.scope.id, 'note.txt'),
        content: 'Approved after a responsive wait.\n',
      },
    ]);
    let heartbeats = 0;
    const interval = setInterval(() => {
      heartbeats++;
    }, 10);
    try {
      await f.boundaries.beforePermissionReview(
        pending.request,
        'initial',
        new AbortController().signal,
      );
    } finally {
      clearInterval(interval);
    }
    expect(heartbeats).toBeGreaterThan(5);
    expect(f.boundaries.evidence().observations?.[0].durationMs).toBeGreaterThanOrEqual(250);
    expect(
      f.boundaries.evidence().checkpoints?.[0].files.some((entry) => entry.path === 'note.txt'),
    ).toBe(false);
    expect((await f.execute(pending.prepared)).planOutcome?.status).toBe('completed');
    expect(await readFile(join(f.files.root, 'note.txt'), 'utf8')).toBe(
      'Approved after a responsive wait.\n',
    );
  } finally {
    await f.close();
  }
  const cancelled = await fixture('C03');
  try {
    const pending = await cancelled.prepare([
      {
        kind: 'write_text',
        target: ref(cancelled.scope.id, 'note.txt'),
        content: 'Approved after a responsive wait.\n',
      },
    ]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    await expect(
      cancelled.boundaries.beforePermissionReview(pending.request, 'initial', controller.signal),
    ).rejects.toThrow('Stopped');
    clearTimeout(timer);
    expect(cancelled.boundaries.evidence().observations).toHaveLength(0);
    expect(existsSync(join(cancelled.files.root, 'note.txt'))).toBe(false);
  } finally {
    await cancelled.close();
  }
});

test('C06 faults only after an actual durable copy, retains partial effects and labels replacement Trash offline', async () => {
  const f = await fixture('C06');
  try {
    const first = await f.prepare([
      {
        kind: 'copy_file',
        source: ref(f.scope.id, 'input.txt'),
        target: ref(f.scope.id, 'copied.txt'),
      },
      { kind: 'trash_file', target: ref(f.scope.id, 'trash-me.txt') },
      {
        kind: 'write_text',
        target: ref(f.scope.id, 'remaining.txt'),
        content: 'Completed remaining work',
      },
    ]);
    expect((await f.execute(first.prepared)).planOutcome?.status).toBe('partial');
    expect(f.nativeCalls()).toBe(0);
    expect(await readFile(join(f.files.root, 'copied.txt'), 'utf8')).toBe('Source stays intact');
    expect(existsSync(join(f.files.root, 'remaining.txt'))).toBe(false);
    expect(f.boundaries.evidence().nativeTrashReceipts).toHaveLength(0);
    await f.boundaries.prepareFollowUp(
      'native-failure-after-first-effect',
      'after-partial',
      new AbortController().signal,
    );
    f.phase('after-partial');
    const second = await f.prepare([
      { kind: 'trash_file', target: ref(f.scope.id, 'trash-me.txt') },
      {
        kind: 'write_text',
        target: ref(f.scope.id, 'remaining.txt'),
        content: 'Completed remaining work',
      },
    ]);
    expect((await f.execute(second.prepared)).planOutcome?.status).toBe('completed');
    expect(f.nativeCalls()).toBe(1);
    expect(f.boundaries.evidence().nativeTrashReceipts).toEqual([
      {
        adapter: 'offline-injected',
        path: join(f.files.root, 'trash-me.txt'),
        beforeSha256: hash('Native failure fixture'),
        outcome: 'completed',
      },
    ]);
    expect(f.boundaries.evidence().observations?.[0].boundaryId).toBe(
      'native-failure-after-first-effect',
    );
  } finally {
    await f.close();
  }
});

test('C09 actual SQLite BEFORE INSERT failure leaves no running row/effect, then drops the trigger for a fresh plan', async () => {
  const f = await fixture('C09');
  try {
    const first = await f.prepare([
      {
        kind: 'write_text',
        target: ref(f.scope.id, 'storage-result.txt'),
        content: 'Recovered under fresh approval',
      },
    ]);
    const result = await f.execute(first.prepared);
    expect(result.planOutcome?.status).toBe('failed');
    expect(result.content).toContain('journal_failure');
    expect(f.store.actionPlans(f.get().id)[0].journal.map((entry) => entry.status)).toEqual([
      'prepared',
      'failed',
    ]);
    expect(existsSync(join(f.files.root, 'storage-result.txt'))).toBe(false);
    await f.boundaries.prepareFollowUp(
      'sqlite-before-running',
      'after-storage-failure',
      new AbortController().signal,
    );
    f.phase('after-storage-failure');
    const second = await f.prepare([
      {
        kind: 'write_text',
        target: ref(f.scope.id, 'storage-result.txt'),
        content: 'Recovered under fresh approval',
      },
    ]);
    expect((await f.execute(second.prepared)).planOutcome?.status).toBe('completed');
    expect(await readFile(join(f.files.root, 'storage-result.txt'), 'utf8')).toBe(
      'Recovered under fresh approval',
    );
    expect(second.request.preview.plan?.id).not.toBe(first.request.preview.plan?.id);
    expect(f.boundaries.evidence().checkpoints?.[0].label).toBe('after-storage-failure');
  } finally {
    await f.close();
  }
});

test('C01 and C10 barriers derive classification/denial facts from the actual journal and files', async () => {
  const classification = await fixture('C01');
  try {
    await expect(
      classification.boundaries.prepareFollowUp(
        'changed-classification',
        'changed-category',
        new AbortController().signal,
      ),
    ).rejects.toThrow('inconsistent');
    const first = await classification.prepare([
      { kind: 'create_directory', target: ref(classification.scope.id, 'Retrieval') },
      {
        kind: 'move_file',
        source: ref(classification.scope.id, 'paper.pdf'),
        target: ref(classification.scope.id, 'Retrieval/paper.pdf'),
      },
    ]);
    expect((await classification.execute(first.prepared)).planOutcome?.status).toBe('completed');
    await classification.boundaries.prepareFollowUp(
      'changed-classification',
      'changed-category',
      new AbortController().signal,
    );
    expect(classification.boundaries.evidence().checkpoints?.[0].label).toBe(
      'before-reclassification',
    );
    expect(classification.boundaries.evidence().observations?.[0].planId).toBe(
      first.request.preview.plan?.id,
    );
  } finally {
    await classification.close();
  }
  const denial = await fixture('C10');
  try {
    const first = await denial.prepare([
      {
        kind: 'move_file',
        source: ref(denial.scope.id, 'input.txt'),
        target: ref(denial.scope.id, 'denied.txt'),
      },
    ]);
    expect((await denial.execute(first.prepared, 'deny')).planOutcome?.status).toBe('denied');
    await denial.boundaries.prepareFollowUp(
      'deny-first-plan',
      'new-authorized-task',
      new AbortController().signal,
    );
    expect(denial.boundaries.evidence().checkpoints?.[0].label).toBe('after-denial');
    expect(existsSync(join(denial.files.root, 'denied.txt'))).toBe(false);
    denial.phase('new-authorized-task');
    const second = await denial.prepare([
      {
        kind: 'move_file',
        source: ref(denial.scope.id, 'input.txt'),
        target: ref(denial.scope.id, 'allowed.txt'),
      },
    ]);
    expect((await denial.execute(second.prepared)).planOutcome?.status).toBe('completed');
    expect(await readFile(join(denial.files.root, 'allowed.txt'), 'utf8')).toBe(
      'New explicit authorization bytes',
    );
  } finally {
    await denial.close();
  }
});

test('profile must be an existing canonical dedicated file below branded temp, and replaced DB cannot install a fault', async () => {
  const f = await fixture('C09');
  try {
    await expect(
      createLiveActionBoundaries({ ...f.options, databasePath: join(f.files.root, 'user.sqlite') }),
    ).rejects.toThrow('inconsistent');
    await symlink(f.databasePath, join(f.profile, 'link.sqlite'));
    await expect(
      createLiveActionBoundaries({ ...f.options, databasePath: join(f.profile, 'link.sqlite') }),
    ).rejects.toThrow('inconsistent');
    await rename(f.databasePath, join(f.profile, 'old.sqlite'));
    await writeFile(f.databasePath, 'Replaced profile bytes');
    await expect(
      f.prepare([
        {
          kind: 'write_text',
          target: ref(f.scope.id, 'storage-result.txt'),
          content: 'Recovered under fresh approval',
        },
      ]),
    ).rejects.toThrow();
    expect(existsSync(join(f.files.root, 'storage-result.txt'))).toBe(false);
    expect(f.boundaries.evidence().observations).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('C07 requires explicit actual-process support and calls it only at the observed second effect before its success commit', async () => {
  const files = await createLiveFixture('C07');
  const databasePath = join(dirname(files.root), 'profile.sqlite');
  const store = new ProsperoStore(databasePath);
  try {
    await expect(
      createLiveActionBoundaries({
        fixture: files,
        databasePath,
        store,
        conversationId: 'no-process-support',
        phaseId: () => 'initial',
        getConversation: () => {
          throw new Error('must not start');
        },
        stopTask() {},
      }),
    ).rejects.toThrow('inconsistent');
  } finally {
    store.close();
    await files.close();
  }
  let actualBoundaryCalls = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture('C07', {
    beforeCrashCommit(event): never {
      actualBoundaryCalls++;
      expect(readFileSync(event.target, 'utf8')).toBe('second.txt approved content');
      const record = f.store.actionPlans(f.get().id)[0];
      expect(record.journal.findLast((entry) => entry.actionId === 'action-1')?.status).toBe(
        'succeeded',
      );
      expect(record.journal.findLast((entry) => entry.actionId === event.actionId)?.status).toBe(
        'running',
      );
      throw new Error('Offline callback throw is not an actual process exit.');
    },
  });
  try {
    const first = await f.prepare(
      ['first', 'second', 'third'].map((name) => ({
        kind: 'write_text',
        target: ref(f.scope.id, `${name}.txt`),
        content: `${name}.txt approved content`,
      })),
    );
    expect((await f.execute(first.prepared)).planOutcome?.status).toBe('partial');
    expect(actualBoundaryCalls).toBe(1);
    expect(f.boundaries.evidence().observations).toHaveLength(0);
    expect(
      f.store
        .actionPlans(f.get().id)[0]
        .journal.filter((entry) => entry.actionId === 'action-2')
        .map((entry) => entry.status),
    ).toEqual(['prepared', 'running', 'failed']);
    expect(existsSync(join(f.files.root, 'third.txt'))).toBe(false);
    await expect(
      f.boundaries.prepareFollowUp(
        'process-exit-after-effect-before-journal',
        'after-crash',
        new AbortController().signal,
      ),
    ).rejects.toThrow('inconsistent');
  } finally {
    await f.close();
  }
});
