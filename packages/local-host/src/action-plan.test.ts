import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  open,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ActionJournalEntry,
  ActionJournalPort,
  ActionPlan,
  ActionStatus,
  FileScope,
  NativeActionAdapter,
  PlanStatus,
  StructuredAction,
  ToolHost,
} from '@prospero/core';
import { writeFileSync } from 'node:fs';
import { ACTION_FILE_BYTES, captureFileScope, createLocalToolHost, TOOL_LIMITS } from './index';
import { PlanPostconditions } from './action-plan';

class TestJournal implements ActionJournalPort {
  plan?: ActionPlan;
  status: PlanStatus = 'prepared';
  rows: ActionJournalEntry[] = [];
  beforeRunning?: (actionId: string) => void;
  failRunning = false;
  prepare(plan: ActionPlan) {
    this.plan = plan;
    for (const [sequence, action] of plan.actions.entries())
      this.rows.push({
        planId: plan.id,
        actionId: action.id,
        sequence,
        status: 'prepared',
        at: Date.now(),
      });
  }
  decision(planId: string, decision: 'allow-once' | 'deny') {
    if (decision === 'deny') {
      this.status = 'denied';
      for (const action of this.plan?.actions ?? []) this.transition(planId, action.id, 'denied');
    } else this.status = 'approved';
  }
  transition(planId: string, actionId: string, status: ActionStatus, detail?: string) {
    if (status === 'running') {
      if (this.failRunning) throw new Error('Private SQLite failure must not escape.');
      this.beforeRunning?.(actionId);
    }
    this.rows.push({
      planId,
      actionId,
      sequence: this.rows.length,
      status,
      at: Date.now(),
      detail,
    });
  }
  finish(_planId: string, status: PlanStatus) {
    this.status = status;
  }
  entries(_planId: string) {
    return structuredClone(this.rows);
  }
}
let fixture: string;
let first: string;
let second: string;
let scopes: FileScope[];
let journal: TestJournal;
let host: ToolHost;
const signal = () => new AbortController().signal;
const call = (name: string, args: object) => ({
  id: 'plan-call',
  name,
  arguments: JSON.stringify(args),
});
const ref = (index: number, target: string) => ({ scopeId: scopes[index].id, path: target });
const prepare = (actions: StructuredAction[], targetHost = host) =>
  targetHost.prepare(call('execute_plan', { title: 'Organize selected files', actions }), signal());
const approve = async (actions: StructuredAction[], targetHost = host) => {
  const prepared = await prepare(actions, targetHost);
  await prepared.onDecision?.('allow-once');
  return prepared;
};
beforeEach(async () => {
  fixture = await mkdtemp(path.join(await realpath(tmpdir()), 'prospero-plans-'));
  first = path.join(fixture, 'first');
  second = path.join(fixture, 'second');
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'note.txt'), 'original text\n');
  scopes = [await captureFileScope(first, 'write'), await captureFileScope(second, 'write')];
  journal = new TestJournal();
  host = createLocalToolHost({ scopes, journal });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test('scope capture pins root identity; read-only roots and exact file scopes never grant siblings or writes', async () => {
  const readRoot = await captureFileScope(first, 'read');
  const file = await captureFileScope(path.join(first, 'note.txt'), 'read');
  const selected = createLocalToolHost({ scopes: [readRoot, file], journal });
  expect(
    (
      await (
        await selected.prepare(call('read_file', { scopeId: file.id, path: '.' }), signal())
      ).execute(signal())
    ).content,
  ).toBe('original text\n');
  await expect(
    selected.prepare(call('read_file', { scopeId: file.id, path: 'sibling.txt' }), signal()),
  ).rejects.toThrow('outside');
  await expect(
    selected.prepare(
      call('write_file', { scopeId: readRoot.id, path: 'note.txt', content: 'bad' }),
      signal(),
    ),
  ).rejects.toThrow('read-only');
  await expect(captureFileScope(path.join(first, 'note.txt'), 'write')).rejects.toThrow(
    'exact-file',
  );
  await expect(
    prepare(
      [
        {
          kind: 'copy_file',
          source: { scopeId: readRoot.id, path: 'note.txt' },
          target: { scopeId: readRoot.id, path: 'copy.txt' },
        },
      ],
      selected,
    ),
  ).rejects.toThrow('read-only');
});

test('explicit multiple roots allow scoped reads, text writes, lists and searches without a workspace', async () => {
  const read = await host.prepare(
    call('read_file', { scopeId: scopes[0].id, path: 'note.txt' }),
    signal(),
  );
  expect((await read.execute(signal())).content).toContain('original');
  const search = await host.prepare(
    call('search_files', { scopeId: scopes[0].id, pattern: 'original' }),
    signal(),
  );
  expect((await search.execute(signal())).content).toContain('note.txt');
  const list = await host.prepare(call('list_directory', { scopeId: scopes[1].id }), signal());
  expect(JSON.parse((await list.execute(signal())).content)).toMatchObject({
    entries: [],
    nextCursor: null,
    hasMore: false,
  });
  const write = await host.prepare(
    call('write_file', { scopeId: scopes[1].id, path: 'new.txt', content: 'scoped' }),
    signal(),
  );
  await write.onDecision?.('allow-once');
  await write.execute(signal());
  expect(await readFile(path.join(second, 'new.txt'), 'utf8')).toBe('scoped');
  await expect(host.prepare(call('read_file', { path: 'note.txt' }), signal())).rejects.toThrow(
    'Attach',
  );
});

test('scope revoke and replacement invalidate both prepared reads and plans', async () => {
  const read = await host.prepare(
    call('read_file', { scopeId: scopes[0].id, path: 'note.txt' }),
    signal(),
  );
  const plan = await approve([
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'copy.txt') },
  ]);
  scopes.splice(0, 1);
  await expect(read.execute(signal())).rejects.toThrow('revoked');
  expect((await plan.execute(signal())).planOutcome?.status).toBe('stale');
  await expect(stat(path.join(second, 'copy.txt'))).rejects.toThrow();
});

test('scope identity remains authoritative across new host instances and inode replacement', async () => {
  const scope = scopes[0];
  await rename(first, path.join(fixture, 'saved-root'));
  await mkdir(first);
  await writeFile(path.join(first, 'note.txt'), 'foreign');
  const another = createLocalToolHost({ scopes: [scope], journal });
  await expect(
    another.prepare(call('read_file', { scopeId: scope.id, path: 'note.txt' }), signal()),
  ).rejects.toThrow('changed');
});

test('multi-action directory organization supports cross-root moves, then rename and copy of produced files', async () => {
  const prepared = await prepare([
    { kind: 'create_directory', target: ref(1, 'organized') },
    { kind: 'move_file', source: ref(0, 'note.txt'), target: ref(1, 'organized/note.txt') },
    {
      kind: 'rename_file',
      source: ref(1, 'organized/note.txt'),
      target: ref(1, 'organized/final.txt'),
    },
    { kind: 'copy_file', source: ref(1, 'organized/final.txt'), target: ref(0, 'backup.txt') },
  ]);
  expect(prepared.preview.plan?.actions).toHaveLength(4);
  expect(Object.isFrozen(prepared.preview.plan)).toBe(true);
  expect(Object.isFrozen(prepared.preview.plan?.actions)).toBe(true);
  expect(Object.isFrozen(prepared.preview.plan?.actions[0].effects)).toBe(true);
  expect(prepared.allowSession).toBe(false);
  await expect(stat(path.join(second, 'organized'))).rejects.toThrow();
  await prepared.onDecision?.('allow-once');
  const result = await prepared.execute(signal());
  expect(result.planOutcome?.status).toBe('completed');
  expect(await readFile(path.join(second, 'organized/final.txt'), 'utf8')).toBe('original text\n');
  expect(await readFile(path.join(first, 'backup.txt'), 'utf8')).toBe('original text\n');
  await expect(stat(path.join(first, 'note.txt'))).rejects.toThrow();
  await expect(stat(path.join(second, 'organized/note.txt'))).rejects.toThrow();
  expect(journal.rows.filter((row) => row.status === 'succeeded')).toHaveLength(4);
});

test('nested directory dependencies and write_text diffs preserve approved contents', async () => {
  const prepared = await approve([
    { kind: 'create_directory', target: ref(1, 'one') },
    { kind: 'create_directory', target: ref(1, 'one/two') },
    { kind: 'write_text', target: ref(1, 'one/two/readme.txt'), content: 'new content\n' },
    { kind: 'write_text', target: ref(1, 'one/two/readme.txt'), content: 'replacement\n' },
  ]);
  expect(prepared.preview.plan?.actions[3].diff).toContain('-new content');
  expect(prepared.preview.plan?.actions[3].diff).toContain('+replacement');
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('completed');
  expect(await readFile(path.join(second, 'one/two/readme.txt'), 'utf8')).toBe('replacement\n');
});

test('write_text previews intentional BOM removal and preserves a BOM when the approved content includes it', async () => {
  const original = Buffer.from('\uFEFForiginal text\n');
  await writeFile(path.join(first, 'preserve-bom.txt'), original);
  await writeFile(path.join(first, 'remove-bom.txt'), original);
  const prepared = await approve([
    { kind: 'write_text', target: ref(0, 'preserve-bom.txt'), content: '\uFEFFupdated text\n' },
    { kind: 'write_text', target: ref(0, 'remove-bom.txt'), content: 'original text\n' },
  ]);
  const actions = prepared.preview.plan?.actions;
  expect(actions?.[0].diff).toContain('-\uFEFForiginal text');
  expect(actions?.[0].diff).toContain('+\uFEFFupdated text');
  expect(actions?.[1].diff).toContain('-\uFEFForiginal text');
  expect(actions?.[1].diff).toContain('+original text');
  expect(actions?.[1].beforeHash).not.toBe(actions?.[1].afterHash);
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('completed');
  expect(await readFile(path.join(first, 'preserve-bom.txt'))).toEqual(
    Buffer.from('\uFEFFupdated text\n'),
  );
  expect(await readFile(path.join(first, 'remove-bom.txt'))).toEqual(
    Buffer.from('original text\n'),
  );
});

test('runtime postconditions retain identity, hash and producer but never file byte buffers', async () => {
  const file = path.join(first, 'note.txt');
  const observedStat = await stat(file);
  const chain = [
    { path: first, stat: await stat(first) },
    { path: file, stat: observedStat },
  ];
  const bytes = await readFile(file);
  const postconditions = new PlanPostconditions();
  for (const target of ['copy-1.txt', 'copy-2.txt', 'copy-3.txt', 'copy-4.txt'])
    postconditions.set(target, {
      path: target,
      chain,
      kind: 'file',
      stat: observedStat,
      bytes,
      hash: 'observed-content-hash',
      producer: 'action-1',
    });
  expect(postconditions.size).toBe(4);
  for (const [target, observed] of postconditions) {
    expect(Object.hasOwn(observed, 'bytes')).toBe(false);
    expect(observed.path).toBe(target);
    expect(observed.chain).toBe(chain);
    expect(observed.stat).toBe(observedStat);
    expect(observed.hash).toBe('observed-content-hash');
    expect(observed.producer).toBe('action-1');
  }
  expect(bytes).toEqual(Buffer.from('original text\n'));
});

test('binary file copy accepts the exact 32 MiB ceiling without interpreting bytes as text', async () => {
  const binary = Buffer.alloc(ACTION_FILE_BYTES, 0x82);
  binary[10] = 0;
  await writeFile(path.join(first, 'binary.dat'), binary);
  const prepared = await approve([
    { kind: 'copy_file', source: ref(0, 'binary.dat'), target: ref(1, 'binary.dat') },
  ]);
  expect(prepared.preview.plan?.actions[0].bytes).toBe(ACTION_FILE_BYTES);
  expect(prepared.preview.plan?.actions[0].beforeHash).toBe(
    prepared.preview.plan?.actions[0].afterHash,
  );
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('completed');
  expect(await readFile(path.join(second, 'binary.dat'))).toEqual(binary);
});

test('reusing one snapshot does not bypass the aggregate transfer ceiling', async () => {
  const file = await open(path.join(first, 'shared.pdf'), 'w');
  await file.truncate(ACTION_FILE_BYTES);
  await file.close();
  const actions: StructuredAction[] = Array.from(
    { length: TOOL_LIMITS.actionPlanBytes / ACTION_FILE_BYTES },
    (_, index) => ({
      kind: 'copy_file',
      source: ref(0, 'shared.pdf'),
      target: ref(1, `copy-${index}.pdf`),
    }),
  );
  const exact = await prepare(actions);
  expect(
    exact.preview.plan?.actions.reduce((total, action) => total + (action.bytes ?? 0), 0),
  ).toBe(TOOL_LIMITS.actionPlanBytes);
  const rejectedJournal = new TestJournal();
  const rejectedHost = createLocalToolHost({ scopes, journal: rejectedJournal });
  await expect(
    prepare(
      [
        ...actions,
        { kind: 'copy_file', source: ref(0, 'shared.pdf'), target: ref(1, 'one-more.pdf') },
      ],
      rejectedHost,
    ),
  ).rejects.toThrow('plan_limit');
  expect(rejectedJournal.plan).toBeUndefined();
  for (const action of [...actions, { target: ref(1, 'one-more.pdf') }])
    await expect(stat(path.join(second, action.target.path))).rejects.toThrow();
});

test('distinct retained snapshots exceed the memory budget before approval or effects', async () => {
  const count = TOOL_LIMITS.actionPlanBytes / ACTION_FILE_BYTES;
  const actions: StructuredAction[] = [];
  for (let index = 0; index <= count; index++) {
    const name = `source-${index}.pdf`;
    const file = await open(path.join(first, name), 'w');
    await file.truncate(index === count ? 1 : ACTION_FILE_BYTES);
    await file.close();
    actions.push({ kind: 'copy_file', source: ref(0, name), target: ref(1, name) });
  }
  await expect(prepare(actions)).rejects.toThrow('plan_limit');
  expect(journal.plan).toBeUndefined();
  expect(journal.rows).toHaveLength(0);
  for (const action of actions)
    await expect(stat(path.join(second, action.target.path))).rejects.toThrow();
});

test('oversized binary files, directory moves, overwrite targets, traversal and symlink paths are rejected before approval', async () => {
  await writeFile(path.join(first, 'huge.dat'), Buffer.alloc(ACTION_FILE_BYTES + 1));
  await writeFile(path.join(second, 'exists.txt'), 'keep');
  await symlink(first, path.join(second, 'alias'));
  for (const action of [
    { kind: 'copy_file', source: ref(0, 'huge.dat'), target: ref(1, 'copy.dat') },
    { kind: 'move_file', source: ref(0, '.'), target: ref(1, 'directory') },
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'exists.txt') },
    { kind: 'copy_file', source: ref(0, '../second/exists.txt'), target: ref(1, 'copy.txt') },
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'alias/copy.txt') },
  ] as StructuredAction[])
    await expect(prepare([action])).rejects.toThrow();
  expect(await readFile(path.join(second, 'exists.txt'), 'utf8')).toBe('keep');
});

test('missing durable journal and missing approval are fail closed; a plan cannot replay completed effects', async () => {
  const actions: StructuredAction[] = [
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'copy.txt') },
  ];
  await expect(prepare(actions, createLocalToolHost({ scopes }))).rejects.toThrow(
    'journal_failure',
  );
  const unapproved = await prepare(actions);
  expect((await unapproved.execute(signal())).planOutcome?.status).toBe('denied');
  await expect(stat(path.join(second, 'copy.txt'))).rejects.toThrow();
  const another = createLocalToolHost({ scopes, journal: new TestJournal() });
  const approved = await approve(actions, another);
  expect((await approved.execute(signal())).planOutcome?.status).toBe('completed');
  expect((await approved.execute(signal())).isError).toBe(true);
});

test('one deny blocks plan, legacy write, shell and native mutations even when prepared before the decision', async () => {
  const calls: string[] = [];
  const native: NativeActionAdapter = {
    reveal: (file) => {
      calls.push(file);
    },
    copyPath: (file) => {
      calls.push(file);
    },
    trash: async (file) => {
      calls.push(file);
    },
  };
  const selected = createLocalToolHost({ workspace: first, scopes, journal, native });
  const write = await selected.prepare(
    call('write_file', { path: 'write.txt', content: 'bad' }),
    signal(),
  );
  const shell = await selected.prepare(call('shell', { command: 'touch shell.txt' }), signal());
  const plan = await approve([{ kind: 'reveal_in_finder', target: ref(0, 'note.txt') }], selected);
  const denied = await selected.prepare(
    call('write_file', { path: 'denied.txt', content: 'bad' }),
    signal(),
  );
  await denied.onDecision?.('deny');
  await expect(write.execute(signal())).rejects.toThrow('denied');
  await expect(shell.execute(signal())).rejects.toThrow('denied');
  expect((await plan.execute(signal())).planOutcome?.status).toBe('denied');
  expect(calls).toHaveLength(0);
  expect(
    (
      await (
        await selected.prepare(call('read_file', { path: 'note.txt' }), signal())
      ).execute(signal())
    ).content,
  ).toContain('original');
  await expect(
    prepare([{ kind: 'write_text', target: ref(0, 'later.txt'), content: 'bad' }], selected),
  ).rejects.toThrow('denied');
});

test.each(['source', 'target', 'parent'])(
  'stale %s stops execution and retains external changes',
  async (changed) => {
    await mkdir(path.join(second, 'parent'));
    const prepared = await approve([
      { kind: 'move_file', source: ref(0, 'note.txt'), target: ref(1, 'parent/result.txt') },
    ]);
    if (changed === 'source') await writeFile(path.join(first, 'note.txt'), 'external edit');
    if (changed === 'target')
      await writeFile(path.join(second, 'parent/result.txt'), 'external target');
    if (changed === 'parent') {
      await rename(path.join(second, 'parent'), path.join(second, 'saved'));
      await mkdir(path.join(second, 'parent'));
    }
    const result = await prepared.execute(signal());
    expect(result.planOutcome?.status).toBe('stale');
    expect(journal.rows.at(-1)?.status).toBe('stale');
    expect(await readFile(path.join(first, 'note.txt'), 'utf8')).toBe(
      changed === 'source' ? 'external edit' : 'original text\n',
    );
  },
);

test('running must be durably recorded before the filesystem effect; journal failure leaves files untouched and redacts errors', async () => {
  journal.failRunning = true;
  const prepared = await approve([
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'copy.txt') },
  ]);
  const result = await prepared.execute(signal());
  expect(result.planOutcome?.status).toBe('failed');
  expect(result.content).toContain('journal_failure');
  expect(result.content).not.toContain('Private SQLite');
  await expect(stat(path.join(second, 'copy.txt'))).rejects.toThrow();
});

test('partial native failure preserves earlier successful effects and marks remaining actions skipped', async () => {
  const native: NativeActionAdapter = {
    reveal: () => {
      throw new Error('Private OS exception must stay private.');
    },
    copyPath: () => {},
    trash: async () => {},
  };
  const selected = createLocalToolHost({ scopes, journal, native });
  const prepared = await approve(
    [
      { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'copied.txt') },
      { kind: 'reveal_in_finder', target: ref(1, 'copied.txt') },
      { kind: 'write_text', target: ref(1, 'never.txt'), content: 'never' },
    ],
    selected,
  );
  const result = await prepared.execute(signal());
  expect(result.planOutcome?.status).toBe('partial');
  expect(result.content).not.toContain('Private OS');
  expect(await readFile(path.join(second, 'copied.txt'), 'utf8')).toContain('original');
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
  expect(journal.rows.filter((row) => row.status === 'succeeded')).toHaveLength(1);
  expect(journal.rows.at(-1)?.status).toBe('skipped');
});

test('Stop before execution and between actions records cancellation without rolling back completed actions', async () => {
  const controller = new AbortController();
  const native: NativeActionAdapter = {
    reveal: () => {
      controller.abort();
    },
    copyPath: () => {},
    trash: async () => {},
  };
  const selected = createLocalToolHost({ scopes, journal, native });
  const prepared = await approve(
    [
      { kind: 'reveal_in_finder', target: ref(0, 'note.txt') },
      { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'never.txt') },
    ],
    selected,
  );
  const result = await prepared.execute(controller.signal);
  expect(result.planOutcome?.status).toBe('partial');
  expect(journal.rows.filter((row) => row.status === 'succeeded')).toHaveLength(1);
  expect(journal.rows.at(-1)?.status).toBe('cancelled');
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
  const skipped = await prepare(
    [{ kind: 'write_text', target: ref(1, 'skipped.txt'), content: 'no' }],
    createLocalToolHost({ scopes, journal: new TestJournal() }),
  );
  await skipped.onSkipped?.('cancelled');
  expect((await skipped.execute(signal())).isError).toBe(true);
  await expect(stat(path.join(second, 'skipped.txt'))).rejects.toThrow();
});

test('native operations receive only validated canonical paths and refuse unavailable adapters', async () => {
  await expect(prepare([{ kind: 'reveal_in_finder', target: ref(0, 'note.txt') }])).rejects.toThrow(
    'native_unavailable',
  );
  const events: string[] = [];
  const native: NativeActionAdapter = {
    reveal: (file) => {
      events.push(`reveal:${file}`);
    },
    copyPath: (file) => {
      events.push(`copy:${file}`);
    },
    trash: async (file) => {
      events.push(`trash:${file}`);
      await rename(file, path.join(fixture, 'recoverable-trash.txt'));
    },
  };
  const selected = createLocalToolHost({ scopes, journal, native });
  const prepared = await approve(
    [
      { kind: 'reveal_in_finder', target: ref(0, 'note.txt') },
      { kind: 'copy_path', target: ref(0, 'note.txt') },
      { kind: 'trash_file', target: ref(0, 'note.txt') },
    ],
    selected,
  );
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('completed');
  expect(events).toEqual([
    `reveal:${first}/note.txt`,
    `copy:${first}/note.txt`,
    `trash:${first}/note.txt`,
  ]);
  expect(await readFile(path.join(fixture, 'recoverable-trash.txt'), 'utf8')).toContain('original');
});

test('durable running commit is followed by a fresh stale check before any effect', async () => {
  journal.beforeRunning = () => {
    writeFileSync(path.join(first, 'note.txt'), 'changed during journal commit');
  };
  const prepared = await approve([
    { kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'never.txt') },
  ]);
  const result = await prepared.execute(signal());
  expect(result.planOutcome?.status).toBe('stale');
  expect(journal.rows.map((row) => row.status)).toEqual(['prepared', 'running', 'stale']);
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
});

test('native operation failure with uncertain side effects records partial even without a completed prior action', async () => {
  const native: NativeActionAdapter = {
    reveal: () => {},
    copyPath: () => {},
    trash: async (file) => {
      await rename(file, path.join(fixture, 'trash-before-error.txt'));
      throw new Error('Native service reported failure after moving');
    },
  };
  const selected = createLocalToolHost({ scopes, journal, native });
  const prepared = await approve([{ kind: 'trash_file', target: ref(0, 'note.txt') }], selected);
  const result = await prepared.execute(signal());
  expect(result.planOutcome?.status).toBe('partial');
  expect(journal.rows.at(-1)?.detail).toBe('partial_effect:action_failed');
  expect(await readFile(path.join(fixture, 'trash-before-error.txt'), 'utf8')).toContain(
    'original',
  );
});

test('skipped preparation failure is terminalized with one failed action and later skipped entries', async () => {
  const prepared = await prepare([
    { kind: 'write_text', target: ref(0, 'first.txt'), content: 'no effect' },
    { kind: 'write_text', target: ref(0, 'second.txt'), content: 'no effect' },
  ]);
  await prepared.onSkipped?.('failed');
  expect(journal.status).toBe('failed');
  expect(journal.rows.slice(-2).map((row) => row.status)).toEqual(['failed', 'skipped']);
  await expect(stat(path.join(first, 'first.txt'))).rejects.toThrow();
});

test('legacy workspace and attachment paths inherit persisted explicit scope identity and revocation', async () => {
  const file = await captureFileScope(path.join(first, 'note.txt'), 'read');
  const active = [scopes[0], file];
  const selected = createLocalToolHost({
    workspace: first,
    attachments: [file.path],
    scopes: active,
    journal,
  });
  const workspaceRead = await selected.prepare(call('read_file', { path: 'note.txt' }), signal());
  const attachmentRead = await selected.prepare(call('read_file', { path: file.path }), signal());
  active.splice(0, active.length);
  await expect(workspaceRead.execute(signal())).rejects.toThrow('revoked');
  await expect(attachmentRead.execute(signal())).rejects.toThrow('revoked');
  const another = createLocalToolHost({ workspace: first, scopes: [scopes[0]], journal });
  await rename(first, path.join(fixture, 'original-workspace'));
  await mkdir(first);
  await writeFile(path.join(first, 'note.txt'), 'replacement');
  await expect(another.prepare(call('read_file', { path: 'note.txt' }), signal())).rejects.toThrow(
    'changed',
  );
});

test('stale or partial plan blocks automatic replanning, legacy writes and shell while preserving read access', async () => {
  const selected = createLocalToolHost({ workspace: first, scopes, journal });
  const prepared = await approve(
    [{ kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'result.txt') }],
    selected,
  );
  await writeFile(path.join(first, 'note.txt'), 'external change');
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('stale');
  for (const request of [
    call('execute_plan', {
      title: 'Automatic retry',
      actions: [{ kind: 'copy_file', source: ref(0, 'note.txt'), target: ref(1, 'retry.txt') }],
    }),
    call('write_file', { path: 'retry.txt', content: 'bypass' }),
    call('shell', { command: 'touch retry.txt' }),
  ])
    await expect(selected.prepare(request, signal())).rejects.toThrow('denied');
  const read = await selected.prepare(call('read_file', { path: 'note.txt' }), signal());
  expect((await read.execute(signal())).content).toBe('external change');
  expect((await prepared.execute(signal())).planOutcome?.status).toBe('stale');
});

test('write_text refuses invalid UTF-8 without NUL so its diff cannot approve lossy byte replacement', async () => {
  const invalid = Buffer.from([0x82, 0x83]);
  await writeFile(path.join(first, 'invalid.txt'), invalid);
  await expect(
    prepare([{ kind: 'write_text', target: ref(0, 'invalid.txt'), content: 'replacement' }]),
  ).rejects.toThrow('unsupported_file');
  expect(await readFile(path.join(first, 'invalid.txt'))).toEqual(invalid);
  const copy = await approve([
    { kind: 'copy_file', source: ref(0, 'invalid.txt'), target: ref(1, 'binary-copy.txt') },
  ]);
  expect((await copy.execute(signal())).planOutcome?.status).toBe('completed');
  expect(await readFile(path.join(second, 'binary-copy.txt'))).toEqual(invalid);
});
