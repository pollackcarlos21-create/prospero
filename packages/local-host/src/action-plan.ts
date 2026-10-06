import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ActionJournalPort,
  ActionPlan,
  ActionPlanOutcome,
  Effect,
  FileReference,
  NativeActionAdapter,
  PlannedAction,
  PreparedTool,
  StructuredAction,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@prospero/core';
import {
  boundedRead,
  FilesystemBoundary,
  hash,
  inspectChain,
  lastEntry,
  sameFile,
  sameIdentity,
  verifyChain,
  type PathEntry,
} from './filesystem';
import { throwIfAborted } from './limits';
import { previewDiff } from './preview';
import { TOOL_LIMITS } from '@prospero/tools';

export const ACTION_FILE_BYTES = 32 * 1024 * 1024;
type FailureCode =
  | 'stale'
  | 'unsafe_path'
  | 'unsupported_file'
  | 'file_limit'
  | 'plan_limit'
  | 'native_unavailable'
  | 'journal_failure'
  | 'action_failed';
export class ActionFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(`Action plan could not proceed (${code}).`);
  }
}
interface Snapshot {
  path: string;
  chain: PathEntry[];
  kind: 'file' | 'directory' | 'absent';
  stat?: Stats;
  bytes?: Buffer;
  hash?: string;
  producer?: string;
}
function snapshotMetadata(value: Snapshot): Omit<Snapshot, 'bytes'> {
  return {
    path: value.path,
    chain: value.chain,
    kind: value.kind,
    stat: value.stat,
    hash: value.hash,
    producer: value.producer,
  };
}
/** Runtime postconditions pin identity and hashes without retaining another copy of file bytes. */
export class PlanPostconditions extends Map<string, Omit<Snapshot, 'bytes'>> {
  override set(target: string, value: Snapshot): this {
    return super.set(target, snapshotMetadata(value));
  }
}
interface PrivateAction {
  id: string;
  action: StructuredAction;
  source?: Snapshot;
  target: Snapshot;
  after?: Buffer;
}
export interface MutationLedger {
  denied: boolean;
}
const effectsFor = (kind: StructuredAction['kind']): Effect[] => {
  if (kind === 'copy_file') return ['file.read', 'file.write'];
  if (kind === 'move_file' || kind === 'rename_file')
    return ['file.read', 'file.write', 'file.remove'];
  if (kind === 'trash_file') return ['file.remove'];
  if (kind === 'reveal_in_finder') return ['native.reveal'];
  if (kind === 'copy_path') return ['native.clipboard'];
  return ['file.write'];
};

async function snapshot(
  target: string,
  signal: AbortSignal,
  reserve?: (bytes: number) => void,
): Promise<Snapshot> {
  throwIfAborted(signal);
  let chain: PathEntry[];
  try {
    chain = await inspectChain(target, true);
  } catch {
    throw new ActionFailure('unsafe_path');
  }
  const leaf = lastEntry(chain);
  if (leaf.path !== target) return { path: target, chain, kind: 'absent' };
  if (leaf.stat.isDirectory()) return { path: target, chain, kind: 'directory', stat: leaf.stat };
  if (!leaf.stat.isFile()) throw new ActionFailure('unsupported_file');
  if (leaf.stat.size > ACTION_FILE_BYTES) throw new ActionFailure('file_limit');
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFile(leaf.stat, stat)) throw new ActionFailure('stale');
    await verifyChain(chain);
    reserve?.(stat.size);
    const bytes = await boundedRead(handle, stat.size + 1);
    throwIfAborted(signal);
    if (bytes.length > ACTION_FILE_BYTES) throw new ActionFailure('file_limit');
    if (bytes.length !== stat.size || !sameFile(stat, await handle.stat()))
      throw new ActionFailure('stale');
    return { path: target, chain, kind: 'file', stat, bytes, hash: hash(bytes) };
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof ActionFailure ? error : new ActionFailure('unsafe_path');
  } finally {
    await handle?.close();
  }
}

async function verify(
  expected: Snapshot,
  produced: Map<string, Snapshot>,
  signal: AbortSignal,
): Promise<Snapshot> {
  const pinned = expected.producer ? produced.get(expected.path) : expected;
  if (!pinned) throw new ActionFailure('stale');
  throwIfAborted(signal);
  try {
    await verifyChain(pinned.chain);
    const current = await snapshot(pinned.path, signal);
    if (current.kind !== pinned.kind) throw new ActionFailure('stale');
    if (pinned.stat && (!current.stat || !sameFile(pinned.stat, current.stat))) {
      // Parent directory timestamps legitimately change as this plan creates children.
      if (!(pinned.kind === 'directory' && current.stat && sameIdentity(pinned.stat, current.stat)))
        throw new ActionFailure('stale');
    }
    if (pinned.kind === 'file' && current.hash !== pinned.hash) throw new ActionFailure('stale');
    return snapshotMetadata(current);
  } catch {
    throwIfAborted(signal);
    throw new ActionFailure('stale');
  }
}

async function removePinned(source: Snapshot, signal: AbortSignal): Promise<void> {
  const current = await verify(source, new Map(), signal);
  if (!current.stat || current.stat.nlink > 1) throw new ActionFailure('unsupported_file');
  throwIfAborted(signal);
  await unlink(source.path);
}

async function createFile(
  target: Snapshot,
  bytes: Buffer,
  signal: AbortSignal,
  onEffect: () => void,
): Promise<void> {
  throwIfAborted(signal);
  await verifyChain(target.chain);
  let handle: FileHandle | undefined;
  let opened: Stats | undefined;
  let wrote = false;
  try {
    handle = await open(
      target.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    onEffect(); // O_CREAT already produced an effect even before content is written.
    opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw new ActionFailure('unsafe_path');
    await verifyChain(target.chain);
    throwIfAborted(signal);
    await handle.writeFile(bytes);
    await handle.sync();
    wrote = true;
  } catch (error) {
    throwIfAborted(signal);
    throw (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? new ActionFailure('stale')
      : error instanceof ActionFailure
        ? error
        : new ActionFailure('action_failed');
  } finally {
    try {
      await handle?.close();
    } finally {
      if (!wrote && opened) {
        try {
          if (sameIdentity(opened, await lstat(target.path))) await unlink(target.path);
        } catch {
          /* Preserve unrelated replacement files; an incomplete effect is reported as partial. */
        }
      }
    }
  }
}

async function replaceText(
  target: Snapshot,
  bytes: Buffer,
  signal: AbortSignal,
  onEffect: () => void,
): Promise<void> {
  if (target.kind === 'absent') return createFile(target, bytes, signal, onEffect);
  let handle: FileHandle | undefined;
  try {
    handle = await open(target.path, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!target.stat || !sameFile(target.stat, stat) || stat.nlink > 1)
      throw new ActionFailure('stale');
    const before = await boundedRead(handle, TOOL_LIMITS.fileBytes + 1);
    if (hash(before) !== target.hash) throw new ActionFailure('stale');
    await verifyChain(target.chain);
    throwIfAborted(signal);
    onEffect();
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function freezePlan(plan: ActionPlan): ActionPlan {
  for (const action of plan.actions) {
    Object.freeze(action.effects);
    Object.freeze(action);
  }
  Object.freeze(plan.actions);
  Object.freeze(plan.scopeIds);
  return Object.freeze(plan);
}

export async function prepareActionPlan(options: {
  call: ToolCall;
  definition: ToolDefinition;
  title: string;
  actions: StructuredAction[];
  filesystem: FilesystemBoundary;
  journal?: ActionJournalPort;
  native?: NativeActionAdapter;
  ledger: MutationLedger;
  signal: AbortSignal;
}): Promise<PreparedTool> {
  const { filesystem, journal, native, ledger, signal } = options;
  if (!journal) throw new ActionFailure('journal_failure');
  if (ledger.denied)
    throw new Error('A mutation was denied in this run. Start a new task to request new approval.');
  const virtual = new Map<string, Snapshot>();
  const privateActions: PrivateAction[] = [];
  const publicActions: PlannedAction[] = [];
  const scopeIds = new Set<string>();
  let retainedBytes = 0;
  let transferBytes = 0;
  const reserve = (bytes: number) => {
    if (retainedBytes + bytes > TOOL_LIMITS.actionPlanBytes) throw new ActionFailure('plan_limit');
    retainedBytes += bytes;
  };
  const transfer = (bytes: number) => {
    if (transferBytes + bytes > TOOL_LIMITS.actionPlanBytes) throw new ActionFailure('plan_limit');
    transferBytes += bytes;
  };
  const load = async (target: string): Promise<Snapshot> => {
    const known = virtual.get(target);
    if (known) return known;
    let found: Snapshot;
    try {
      found = await snapshot(target, signal, reserve);
    } catch (error) {
      if (!(error instanceof ActionFailure) || error.code !== 'unsafe_path') throw error;
      const parent = virtual.get(path.dirname(target));
      if (parent?.kind !== 'directory' || !parent.producer) throw error;
      found = { path: target, chain: parent.chain, kind: 'absent', producer: parent.producer };
    }
    virtual.set(target, found);
    return found;
  };
  const resolve = async (reference: FileReference, write: boolean): Promise<string> => {
    if (path.isAbsolute(reference.path)) throw new ActionFailure('unsafe_path');
    scopeIds.add(reference.scopeId);
    return filesystem.resolve(reference.path, signal, false, reference.scopeId, write);
  };
  for (const [index, action] of options.actions.entries()) {
    throwIfAborted(signal);
    const id = `action-${index + 1}`;
    const targetPath = await resolve(
      action.target,
      !['reveal_in_finder', 'copy_path'].includes(action.kind),
    );
    const target = await load(targetPath);
    const item: PrivateAction = { id, action, target };
    const visible: PlannedAction = {
      id,
      kind: action.kind,
      target: targetPath,
      effects: effectsFor(action.kind),
    };
    if (
      ['copy_file', 'move_file', 'rename_file', 'create_directory', 'write_text'].includes(
        action.kind,
      )
    ) {
      const parent = await load(path.dirname(targetPath));
      if (parent.kind !== 'directory') throw new ActionFailure('unsafe_path');
      if (
        action.target.path === '.' ||
        targetPath === (await filesystem.scope(action.target.scopeId, signal)).path
      )
        throw new ActionFailure('unsafe_path');
    }
    if (
      action.kind === 'copy_file' ||
      action.kind === 'move_file' ||
      action.kind === 'rename_file'
    ) {
      const sourcePath = await resolve(action.source, action.kind !== 'copy_file');
      const source = await load(sourcePath);
      if (source.kind !== 'file' || !source.bytes) throw new ActionFailure('unsupported_file');
      if (action.kind !== 'copy_file' && source.stat && source.stat.nlink > 1)
        throw new ActionFailure('unsupported_file');
      if (sourcePath === targetPath || target.kind !== 'absent')
        throw new ActionFailure('unsafe_path');
      transfer(source.bytes.length);
      item.source = source;
      item.after = source.bytes;
      visible.source = sourcePath;
      visible.bytes = source.bytes.length;
      visible.beforeHash = source.hash;
      visible.afterHash = source.hash;
      virtual.set(targetPath, {
        path: targetPath,
        chain: target.chain,
        kind: 'file',
        bytes: source.bytes,
        hash: source.hash,
        producer: id,
      });
      if (action.kind !== 'copy_file')
        virtual.set(sourcePath, {
          path: sourcePath,
          chain: source.chain.slice(0, -1),
          kind: 'absent',
          producer: id,
        });
    } else if (action.kind === 'create_directory') {
      if (target.kind !== 'absent') throw new ActionFailure('unsafe_path');
      virtual.set(targetPath, {
        path: targetPath,
        chain: target.chain,
        kind: 'directory',
        producer: id,
      });
    } else if (action.kind === 'write_text') {
      if (
        target.kind === 'directory' ||
        (target.stat && target.stat.nlink > 1) ||
        target.bytes?.includes(0)
      )
        throw new ActionFailure('unsupported_file');
      if ((target.bytes?.length ?? 0) > TOOL_LIMITS.fileBytes)
        throw new ActionFailure('file_limit');
      let before = '';
      if (target.bytes) {
        try {
          before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(target.bytes);
        } catch {
          throw new ActionFailure('unsupported_file');
        }
      }
      const length = Buffer.byteLength(action.content);
      if (length > TOOL_LIMITS.fileBytes) throw new ActionFailure('file_limit');
      reserve(length);
      transfer(length);
      const bytes = Buffer.from(action.content);
      const diff = await previewDiff(
        targetPath,
        before,
        action.content,
        target.kind === 'file',
        signal,
      );
      if (Buffer.byteLength(diff) > TOOL_LIMITS.outputBytes) throw new ActionFailure('file_limit');
      item.after = bytes;
      visible.bytes = bytes.length;
      visible.beforeHash = target.hash ?? hash(Buffer.alloc(0));
      visible.afterHash = hash(bytes);
      visible.diff = diff;
      virtual.set(targetPath, {
        path: targetPath,
        chain: target.chain,
        kind: 'file',
        bytes,
        hash: visible.afterHash,
        producer: id,
      });
    } else {
      if (!native) throw new ActionFailure('native_unavailable');
      if (target.kind === 'absent') throw new ActionFailure('unsupported_file');
      if (action.kind === 'trash_file') {
        if (target.kind !== 'file' || (target.stat && target.stat.nlink > 1))
          throw new ActionFailure('unsupported_file');
        visible.bytes = target.bytes?.length;
        visible.beforeHash = target.hash;
        virtual.set(targetPath, {
          path: targetPath,
          chain: target.chain.slice(0, -1),
          kind: 'absent',
          producer: id,
        });
      }
    }
    privateActions.push(item);
    publicActions.push(visible);
  }
  const manifest = { title: options.title, scopeIds: [...scopeIds].sort(), actions: publicActions };
  const plan = freezePlan({
    ...manifest,
    id: randomUUID(),
    createdAt: Date.now(),
    digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  });
  try {
    journal.prepare(plan);
  } catch {
    throw new ActionFailure('journal_failure');
  }
  let approved = false;
  let terminal = false;
  let terminalStatus: ActionPlanOutcome['status'] | undefined;
  const entries = () => {
    try {
      return journal.entries(plan.id);
    } catch {
      return [];
    }
  };
  const outcome = (
    status: ActionPlanOutcome['status'],
    content: string,
    isError = status !== 'completed',
  ): ToolResult => ({
    content,
    isError,
    planOutcome: { planId: plan.id, digest: plan.digest, status, journal: entries() },
  });
  const transition = (
    id: string,
    status: Parameters<ActionJournalPort['transition']>[2],
    detail?: string,
  ) => {
    try {
      journal.transition(plan.id, id, status, detail);
    } catch {
      throw new ActionFailure('journal_failure');
    }
  };
  const finish = (status: ActionPlanOutcome['status']) => {
    terminal = true;
    terminalStatus = status;
    if (status !== 'completed') ledger.denied = true;
    try {
      journal.finish(plan.id, status);
    } catch {
      throw new ActionFailure('journal_failure');
    }
  };
  return {
    call: options.call,
    definition: options.definition,
    requiresPermission: true,
    allowSession: false,
    permissionKey: `plan:${plan.id}:${plan.digest}`,
    preview: {
      kind: 'plan',
      title: options.title,
      plan,
      effects: [...new Set(publicActions.flatMap((action) => action.effects))],
    },
    onDecision(decision) {
      if (terminal || approved) return;
      if (decision !== 'allow-once' || ledger.denied) {
        ledger.denied = true;
        try {
          journal.decision(plan.id, 'deny');
        } catch {
          throw new ActionFailure('journal_failure');
        }
        finish('denied');
        return;
      }
      try {
        journal.decision(plan.id, 'allow-once');
      } catch {
        throw new ActionFailure('journal_failure');
      }
      approved = true;
    },
    onSkipped(reason) {
      if (terminal) return;
      for (const [index, item] of privateActions.entries())
        transition(
          item.id,
          reason === 'cancelled' ? 'cancelled' : index === 0 ? 'failed' : 'skipped',
          'Execution stopped before this action began.',
        );
      finish(reason === 'cancelled' ? 'cancelled' : 'failed');
    },
    async execute(executionSignal) {
      if (terminal)
        return outcome(terminalStatus ?? 'failed', 'This Action Plan has already ended.', true);
      if (!approved || ledger.denied) {
        try {
          journal.decision(plan.id, 'deny');
        } catch {
          throw new ActionFailure('journal_failure');
        }
        finish('denied');
        return outcome('denied', 'Action Plan was not approved. No actions executed.');
      }
      const produced = new PlanPostconditions();
      let completed = 0;
      let currentIndex = 0;
      let currentAffected = false;
      let currentCommitted = false;
      try {
        for (const [index, item] of privateActions.entries()) {
          currentIndex = index;
          currentAffected = false;
          currentCommitted = false;
          throwIfAborted(executionSignal);
          try {
            await filesystem.scope(
              item.action.target.scopeId,
              executionSignal,
              !['reveal_in_finder', 'copy_path'].includes(item.action.kind),
            );
            if ('source' in item.action)
              await filesystem.scope(
                item.action.source.scopeId,
                executionSignal,
                item.action.kind !== 'copy_file',
              );
          } catch {
            throwIfAborted(executionSignal);
            throw new ActionFailure('stale');
          }
          let target: Snapshot;
          if (
            item.target.kind === 'absent' &&
            item.target.producer &&
            !produced.has(item.target.path)
          ) {
            const parent = produced.get(path.dirname(item.target.path));
            if (parent?.kind !== 'directory') throw new ActionFailure('stale');
            await verify(parent, produced, executionSignal);
            target = await snapshot(item.target.path, executionSignal);
            if (target.kind !== 'absent') throw new ActionFailure('stale');
          } else target = await verify(item.target, produced, executionSignal);
          let source = item.source
            ? await verify(item.source, produced, executionSignal)
            : undefined;
          transition(item.id, 'running');
          throwIfAborted(executionSignal);
          // A durable commit may yield to another process. Recheck approved path/content after it.
          target = await verify(target, new Map(), executionSignal);
          if (source) source = await verify(source, new Map(), executionSignal);
          if (item.action.kind === 'create_directory') {
            await verifyChain(target.chain);
            await mkdir(target.path, { mode: 0o700 });
            currentAffected = true;
          } else if (
            item.action.kind === 'copy_file' ||
            item.action.kind === 'move_file' ||
            item.action.kind === 'rename_file'
          ) {
            if (!source || !item.after) throw new ActionFailure('stale');
            await createFile(target, item.after, executionSignal, () => {
              currentAffected = true;
            });
            // Copy is durable before removing the approved source. A later failure remains partial.
            if (item.action.kind !== 'copy_file') await removePinned(source, executionSignal);
          } else if (item.action.kind === 'write_text') {
            await replaceText(target, item.after ?? Buffer.alloc(0), executionSignal, () => {
              currentAffected = true;
            });
          } else if (item.action.kind === 'trash_file') {
            if (!native) throw new ActionFailure('native_unavailable');
            currentAffected = true;
            await native.trash(target.path);
          } else if (item.action.kind === 'reveal_in_finder') {
            if (!native) throw new ActionFailure('native_unavailable');
            currentAffected = true;
            await native.reveal(target.path);
          } else {
            if (!native) throw new ActionFailure('native_unavailable');
            currentAffected = true;
            await native.copyPath(target.path);
          }
          if (
            [
              'copy_file',
              'move_file',
              'rename_file',
              'create_directory',
              'write_text',
              'trash_file',
            ].includes(item.action.kind)
          ) {
            const after = await snapshot(target.path, new AbortController().signal);
            const expectedKind =
              item.action.kind === 'trash_file'
                ? 'absent'
                : item.action.kind === 'create_directory'
                  ? 'directory'
                  : 'file';
            if (
              after.kind !== expectedKind ||
              (expectedKind === 'file' && after.hash !== hash(item.after ?? Buffer.alloc(0)))
            )
              throw new ActionFailure('stale');
            produced.set(target.path, after);
            if (source && item.action.kind !== 'copy_file') {
              const removed = await snapshot(source.path, new AbortController().signal);
              if (removed.kind !== 'absent') throw new ActionFailure('stale');
              produced.set(source.path, removed);
            }
          }
          // Success is journaled only after the completed effect's approved postcondition is observed.
          transition(item.id, 'succeeded');
          currentCommitted = true;
          completed++;
        }
        finish('completed');
        return outcome('completed', `Completed ${completed} approved actions.`, false);
      } catch (error) {
        const cancelled = executionSignal.aborted;
        const stale = error instanceof ActionFailure && error.code === 'stale';
        const failureDetail = cancelled
          ? 'cancelled'
          : error instanceof ActionFailure
            ? error.code
            : 'action_failed';
        const detail =
          currentAffected && !currentCommitted ? `partial_effect:${failureDetail}` : failureDetail;
        const status =
          completed > 0 || currentAffected
            ? 'partial'
            : cancelled
              ? 'cancelled'
              : stale
                ? 'stale'
                : 'failed';
        try {
          if (!currentCommitted)
            transition(
              privateActions[currentIndex].id,
              cancelled ? 'cancelled' : stale ? 'stale' : 'failed',
              detail,
            );
          for (const item of privateActions.slice(currentIndex + 1))
            transition(item.id, 'skipped', 'Earlier action did not complete.');
          finish(status);
        } catch {
          terminal = true;
          terminalStatus = status;
          ledger.denied = true;
        }
        return outcome(
          status,
          `Action Plan stopped (${detail}); ${completed} actions completed. Completed effects remain; remaining actions were skipped.`,
        );
      }
    },
  };
}
