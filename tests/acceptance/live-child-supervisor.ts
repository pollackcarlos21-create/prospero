import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  attachLiveParentPermissionSession,
  assertLiveParentPermissionSession,
  isLiveChildPermissionMessage,
  type LiveParentPermissionSession,
} from './live-child-permission';

export type LiveChildControlMessage =
  | Readonly<{ version: 1; type: 'ready' }>
  | Readonly<{ version: 1; type: 'exit-intent'; code: 23 }>
  | Readonly<{
      version: 1;
      type: 'boundary';
      caseId: 'C07';
      phaseId: string;
      boundaryId: 'process-exit-after-effect-before-journal';
      planId: string;
      actionId: string;
    }>;
export type LiveChildStopReason =
  | 'exited'
  | 'aborted'
  | 'timeout'
  | 'ipc-closed'
  | 'protocol'
  | 'output-limit'
  | 'observer-error'
  | 'spawn-error'
  | 'child-error'
  | 'identity-changed';
export interface LiveChildOutcome {
  readonly proofBoundary: 'owned-node-process-events-only';
  readonly pid: number | null;
  readonly entrySha256: string | null;
  readonly execSha256: string | null;
  readonly spawned: boolean;
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly actualExitCode: number | null;
  readonly actualExitSignal: NodeJS.Signals | null;
  readonly reason: LiveChildStopReason;
  readonly acceptedControlBytes: number;
  readonly outputBytesObservedAtLeast: number;
  readonly outputLimitExceeded: boolean;
  /** These are untrusted child reports; they cannot establish an exit or an action effect. */
  readonly messages: readonly LiveChildControlMessage[];
  readonly settled: true;
}
export interface LiveChildOptions {
  readonly entryPath: string;
  readonly expectedEntrySha256: string;
  readonly cwd: string;
  readonly execPath: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Synchronous bounded metadata observation only. No human approval is restored by IPC. */
  readonly onMessage?: (message: LiveChildControlMessage) => void;
  /** Opt-in main-owned fixed C07 protocol. Default metadata channel cannot approve. */
  readonly permissionSession?: LiveParentPermissionSession;
}
const MESSAGE_BYTES = 2048;
const TOTAL_CONTROL_BYTES = 32768;
const MESSAGE_COUNT = 64;
const OUTPUT_BYTES = 32768;
const TERMINATION_GRACE_MS = 100;
const DISCONNECT_GRACE_MS = 25;
const outcomes = new WeakSet<LiveChildOutcome>();
const outcomePermissionSessions = new WeakMap<LiveChildOutcome, LiveParentPermissionSession>();
interface Identity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}
const fileIdentity = (stat: BigIntStats): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});
const sameIdentity = (left: Identity, right: Identity) =>
  (Object.keys(left) as (keyof Identity)[]).every((key) => left[key] === right[key]);
function invalid(): never {
  // Never include selected paths, argv, environment or the child's reflected error text.
  throw new Error('The controlled worker process or its evidence is invalid.');
}
function pathChain(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) invalid();
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory())) invalid();
  }
  if (realpathSync(path) !== path) invalid();
}
function measuredFile(path: string, maximum: bigint): { identity: Identity; sha256: string } {
  pathChain(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > maximum) invalid();
  const selected = fileIdentity(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameIdentity(selected, fileIdentity(fstatSync(fd, { bigint: true })))) invalid();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (BigInt(total) > maximum) invalid();
      hash.update(buffer.subarray(0, count));
    }
    if (
      BigInt(total) !== selected.size ||
      !sameIdentity(selected, fileIdentity(fstatSync(fd, { bigint: true }))) ||
      !sameIdentity(selected, fileIdentity(lstatSync(path, { bigint: true })))
    )
      invalid();
    return { identity: selected, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}
function control(value: unknown): LiveChildControlMessage {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1)
    invalid();
  const type = (value as { type?: unknown }).type;
  if (type === 'ready' && exactKeys(value, ['version', 'type']))
    return Object.freeze({ version: 1, type: 'ready' });
  if (type === 'exit-intent' && exactKeys(value, ['version', 'type', 'code']) && value.code === 23)
    return Object.freeze({ version: 1, type: 'exit-intent', code: 23 });
  if (
    type === 'boundary' &&
    exactKeys(value, [
      'version',
      'type',
      'caseId',
      'phaseId',
      'boundaryId',
      'planId',
      'actionId',
    ]) &&
    value.caseId === 'C07' &&
    value.boundaryId === 'process-exit-after-effect-before-journal' &&
    opaqueId(value.phaseId) &&
    opaqueId(value.planId) &&
    opaqueId(value.actionId)
  )
    return Object.freeze({
      version: 1,
      type: 'boundary',
      caseId: 'C07',
      phaseId: value.phaseId,
      boundaryId: 'process-exit-after-effect-before-journal',
      planId: value.planId,
      actionId: value.actionId,
    });
  return invalid();
}
/** Only in-process outcomes produced after observed child settlement can cross the crash barrier. */
export function assertLiveChildOutcome(
  outcome: LiveChildOutcome,
  expected: { entrySha256?: string; execSha256?: string; pid?: number; exitCode?: number } = {},
): void {
  if (
    !outcomes.has(outcome) ||
    Object.keys(expected).some(
      (key) => !['entrySha256', 'execSha256', 'pid', 'exitCode'].includes(key),
    ) ||
    (expected.entrySha256 !== undefined && expected.entrySha256 !== outcome.entrySha256) ||
    (expected.execSha256 !== undefined && expected.execSha256 !== outcome.execSha256) ||
    (expected.pid !== undefined && expected.pid !== outcome.pid) ||
    (expected.exitCode !== undefined &&
      (!outcome.spawned ||
        !outcome.exitObserved ||
        !outcome.closeObserved ||
        outcome.reason !== 'exited' ||
        outcome.actualExitCode !== expected.exitCode))
  )
    invalid();
}

/** Inert custody comparison. A copied outcome or another successfully reviewed session
 * cannot attribute its decision intent to this actual owned worker's crash evidence.
 */
export function matchesLiveChildPermissionSession(
  outcome: LiveChildOutcome,
  session: LiveParentPermissionSession,
): boolean {
  return (
    outcomes.has(outcome) &&
    outcome.spawned &&
    outcome.exitObserved &&
    outcome.closeObserved &&
    outcomePermissionSessions.get(outcome) === session
  );
}

/** Forks one reviewed Node worker with an owned ChildProcess handle. It never reads user profiles,
 * invokes native credentials, copies parent environment or authorizes a real service request.
 * IPC limits apply after Node deserialization; they do not bound Node's internal frame allocation.
 * Only the actual exit/close events determine settlement; messages and successful kill() do not.
 */
export async function superviseLiveChild(input: LiveChildOptions): Promise<LiveChildOutcome> {
  const options = { ...input };
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(
      (key) =>
        ![
          'entryPath',
          'expectedEntrySha256',
          'cwd',
          'execPath',
          'deadlineMs',
          'signal',
          'onMessage',
          'permissionSession',
        ].includes(key),
    ) ||
    !['entryPath', 'cwd', 'execPath'].every(
      (key) => typeof input[key as keyof LiveChildOptions] === 'string',
    ) ||
    !/^[a-f0-9]{64}$/.test(input.expectedEntrySha256) ||
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs < 1 ||
    input.deadlineMs > 1800000 ||
    (input.onMessage !== undefined && typeof input.onMessage !== 'function')
  )
    invalid();
  const started = performance.now();
  let entry: ReturnType<typeof measuredFile> | undefined;
  let executable: ReturnType<typeof measuredFile> | undefined;
  let cwdIdentity: Identity | undefined;
  const messages: LiveChildControlMessage[] = [];
  let pid: number | null = null;
  let spawned = false;
  let exitObserved = false;
  let closeObserved = false;
  let actualExitCode: number | null = null;
  let actualExitSignal: NodeJS.Signals | null = null;
  let failure: LiveChildStopReason | undefined;
  let attachedPermissionSession: LiveParentPermissionSession | undefined;
  let acceptedControlBytes = 0;
  let outputBytesObservedAtLeast = 0;
  let outputLimitExceeded = false;
  const outcome = (reason: LiveChildStopReason) => {
    const value: LiveChildOutcome = Object.freeze({
      proofBoundary: 'owned-node-process-events-only',
      pid,
      entrySha256: entry?.sha256 ?? null,
      execSha256: executable?.sha256 ?? null,
      spawned,
      exitObserved,
      closeObserved,
      actualExitCode,
      actualExitSignal,
      reason,
      acceptedControlBytes,
      outputBytesObservedAtLeast,
      outputLimitExceeded,
      messages: Object.freeze([...messages]),
      settled: true,
    });
    outcomes.add(value);
    if (attachedPermissionSession) outcomePermissionSessions.set(value, attachedPermissionSession);
    return value;
  };
  if (options.signal?.aborted) return outcome('aborted');
  if (options.permissionSession) {
    try {
      assertLiveParentPermissionSession(options.permissionSession);
    } catch {
      return outcome('protocol');
    }
  }
  try {
    pathChain(options.cwd);
    const directory = lstatSync(options.cwd, { bigint: true });
    const childPath = relative(options.cwd, options.entryPath);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077n) !== 0n ||
      (process.getuid && directory.uid !== BigInt(process.getuid())) ||
      !childPath ||
      childPath === '..' ||
      childPath.startsWith(`..${sep}`) ||
      isAbsolute(childPath)
    )
      invalid();
    cwdIdentity = fileIdentity(directory);
    entry = measuredFile(options.entryPath, 4n * 1024n * 1024n);
    if (entry.sha256 !== options.expectedEntrySha256) return outcome('identity-changed');
    executable = measuredFile(options.execPath, 512n * 1024n * 1024n);
  } catch {
    return outcome('spawn-error');
  }
  const remaining = options.deadlineMs - (performance.now() - started);
  if (remaining <= 0) return outcome('timeout');
  if (options.signal?.aborted) return outcome('aborted');
  if (!entry || !executable || !cwdIdentity) return outcome('spawn-error');
  const preparedEntry = entry;
  const preparedExecutable = executable;
  const preparedCwd = cwdIdentity;
  return new Promise<LiveChildOutcome>((resolveOutcome) => {
    let child: ChildProcess;
    let finished = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminate: ReturnType<typeof setTimeout> | undefined;
    let disconnect: ReturnType<typeof setTimeout> | undefined;
    let permissions: ReturnType<typeof attachLiveParentPermissionSession> | undefined;
    const permissionControl = new AbortController();
    const stop = (reason: LiveChildStopReason) => {
      if (finished) return;
      failure ??= reason;
      permissionControl.abort();
      if (exitObserved) {
        // The owned process has exited. Close only our communication handles if their drain
        // outlives the deadline (for example an inherited output pipe held elsewhere).
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.connected) {
          try {
            child.disconnect();
          } catch {}
        }
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {}
      terminate ??= setTimeout(() => {
        if (finished || exitObserved) return;
        // A failed/unknown kill never settles this promise. Await the real process events.
        try {
          child.kill('SIGKILL');
        } catch {}
      }, TERMINATION_GRACE_MS);
    };
    const abort = () => stop('aborted');
    try {
      child = fork(options.entryPath, [], {
        execPath: options.execPath,
        execArgv: [],
        cwd: options.cwd,
        env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
        detached: false,
      });
    } catch {
      resolveOutcome(outcome('spawn-error'));
      return;
    }
    const observedOutput = (chunk: Buffer) => {
      if (finished) return;
      outputBytesObservedAtLeast = Math.min(
        OUTPUT_BYTES + 1,
        outputBytesObservedAtLeast + chunk.byteLength,
      );
      if (outputBytesObservedAtLeast > OUTPUT_BYTES) {
        outputLimitExceeded = true;
        stop('output-limit');
      }
    };
    child.stdout?.on('data', observedOutput);
    child.stderr?.on('data', observedOutput);
    if (options.permissionSession) {
      try {
        const signal = options.signal
          ? AbortSignal.any([options.signal, permissionControl.signal])
          : permissionControl.signal;
        permissions = attachLiveParentPermissionSession(
          options.permissionSession,
          (message) =>
            new Promise((resolve, reject) => {
              if (finished || failure || exitObserved || !child.connected) {
                reject(new Error('Worker ended'));
                return;
              }
              child.send(message, (error) => {
                if (error || finished || failure || exitObserved) reject(new Error('Worker ended'));
                else resolve();
              });
            }),
          () => stop('protocol'),
          signal,
        );
        attachedPermissionSession = options.permissionSession;
      } catch {
        stop('protocol');
      }
    }
    child.stdout?.on('error', () => stop('child-error'));
    child.stderr?.on('error', () => stop('child-error'));
    child.on('spawn', () => {
      spawned = true;
      pid =
        typeof child.pid === 'number' && Number.isSafeInteger(child.pid) && child.pid > 0
          ? child.pid
          : null;
      try {
        if (
          !sameIdentity(
            preparedEntry.identity,
            fileIdentity(lstatSync(options.entryPath, { bigint: true })),
          ) ||
          !sameIdentity(
            preparedExecutable.identity,
            fileIdentity(lstatSync(options.execPath, { bigint: true })),
          ) ||
          !sameIdentity(preparedCwd, fileIdentity(lstatSync(options.cwd, { bigint: true })))
        )
          stop('identity-changed');
      } catch {
        stop('identity-changed');
      }
    });
    child.on('message', (value: unknown) => {
      if (finished || failure || exitObserved) return;
      if (isLiveChildPermissionMessage(value)) {
        if (!permissions) return stop('protocol');
        permissions.receive(value);
        return;
      }
      try {
        const message = control(value);
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (
          bytes > MESSAGE_BYTES ||
          messages.length >= MESSAGE_COUNT ||
          acceptedControlBytes + bytes > TOTAL_CONTROL_BYTES
        )
          return stop('protocol');
        acceptedControlBytes += bytes;
        messages.push(message);
        try {
          const returned = options.onMessage?.(message);
          if (returned !== undefined) {
            void Promise.resolve(returned).catch(() => {});
            stop('observer-error');
          }
        } catch {
          stop('observer-error');
        }
      } catch {
        stop('protocol');
      }
    });
    child.on('disconnect', () => {
      if (finished || exitObserved || failure) return;
      // Natural process exit may close IPC first. Give the actual exit event a bounded turn.
      disconnect = setTimeout(() => {
        if (!finished && !exitObserved) stop('ipc-closed');
      }, DISCONNECT_GRACE_MS);
    });
    child.on('error', () => stop(spawned ? 'child-error' : 'spawn-error'));
    child.on('exit', (code, signal) => {
      exitObserved = true;
      actualExitCode = Number.isSafeInteger(code) ? code : null;
      actualExitSignal = signal;
      if (terminate) clearTimeout(terminate);
      if (disconnect) clearTimeout(disconnect);
    });
    child.on('close', () => {
      if (finished) return;
      finished = true;
      closeObserved = true;
      if (deadline) clearTimeout(deadline);
      if (terminate) clearTimeout(terminate);
      if (disconnect) clearTimeout(disconnect);
      options.signal?.removeEventListener('abort', abort);
      permissions?.finish();
      permissionControl.abort();
      resolveOutcome(outcome(failure ?? (exitObserved ? 'exited' : 'spawn-error')));
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => stop('timeout'), Math.max(1, remaining));
    if (options.signal?.aborted) abort();
  });
}
