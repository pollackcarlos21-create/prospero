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
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyPatch } from 'diff';
import { DesktopService } from '../../apps/desktop/src/main/service';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { ActionJournalEntry, ActionPlan, PermissionRequest } from '../../packages/core/src';
import { livePermissionFingerprint } from './live-approval';
import {
  assertLiveChildOutcome,
  matchesLiveChildPermissionSession,
  type LiveChildOutcome,
} from './live-child-supervisor';
import {
  matchesLiveParentPermissionDecision,
  type LiveParentPermissionSession,
} from './live-child-permission';
import {
  assertLiveCredentialProfile,
  type LiveCredentialProfile,
} from './live-credential-selection';
import {
  assertLiveFixtureChildOutcome,
  captureLiveFixtureCheckpoint,
  type LiveApprovalRecord,
  type LiveCaseFixture,
  type LiveControlledObservation,
  type LiveFixtureCheckpoint,
} from './live-fixtures';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const names = ['first.txt', 'second.txt', 'third.txt'] as const;
const statuses = ['prepared', 'prepared', 'prepared', 'running', 'succeeded', 'running'];
const indices = [0, 1, 2, 0, 0, 1];
const opaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function invalid(): never {
  // No reflected paths, SQLite errors, task text, credentials or child output.
  throw new Error('The actual crash boundary or recovery evidence is inconsistent.');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface PinnedFile {
  path: string;
  fd: number;
  stat: BigIntStats;
}
const same = (a: BigIntStats, b: BigIntStats) =>
  (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'] as const).every(
    (key) => a[key] === b[key],
  );
function pin(path: string, limit: bigint): PinnedFile {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > limit ||
    (stat.mode & 0o077n) !== 0n ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    realpathSync(path) !== path
  )
    invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(stat, fstatSync(fd, { bigint: true }))) invalid();
    return { path, fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function assertPinned(file: PinnedFile) {
  if (
    !same(file.stat, fstatSync(file.fd, { bigint: true })) ||
    !same(file.stat, lstatSync(file.path, { bigint: true }))
  )
    invalid();
}
function pinnedHash(file: PinnedFile): string {
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let offset = 0;
  for (;;) {
    const count = readSync(file.fd, buffer, 0, buffer.length, offset);
    if (!count) break;
    offset += count;
    if (BigInt(offset) > file.stat.size) invalid();
    digest.update(buffer.subarray(0, count));
  }
  if (BigInt(offset) !== file.stat.size) invalid();
  assertPinned(file);
  return digest.digest('hex');
}
function absent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    invalid();
  }
  invalid();
}
interface JournalSnapshot {
  plan: ActionPlan;
  status: string;
  executionId: string;
  journal: ActionJournalEntry[];
  conversation: Conversation;
}
/** Owned, quiescent profile only. Read the WAL normally: immutable=1 would hide committed
 * crash-window rows. Pin existing DB/WAL identities before and after the read. SQLite may
 * touch SHM read marks, so SHM is checked for safe type/ownership, not content immutability.
 * This is a trusted same-UID worker protocol, not protection against an adversarial OS user.
 */
function readJournal(profile: LiveCredentialProfile, conversationId: string): JournalSnapshot {
  const database = profile.databasePath;
  const pins: PinnedFile[] = [];
  let db: DatabaseSync | undefined;
  try {
    for (const [path, limit] of [
      [database, 256n * 1024n * 1024n],
      [`${database}-wal`, 32n * 1024n * 1024n],
      [`${database}-shm`, 4n * 1024n * 1024n],
    ] as const) {
      try {
        pins.push(pin(path, limit));
      } catch (error) {
        if (path === database || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    absent(`${database}-journal`);
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    for (const file of pins.filter((file) => !file.path.endsWith('-shm'))) assertPinned(file);
    const rows = db
      .prepare('SELECT id,execution_id,status,payload FROM action_plans WHERE conversation_id=?')
      .all(conversationId);
    if (rows.length !== 1 || typeof rows[0].payload !== 'string') invalid();
    const row = rows[0];
    if (Buffer.byteLength(row.payload as string) > 65536) invalid();
    const plan = JSON.parse(row.payload as string) as ActionPlan;
    if (row.id !== plan.id || !opaque(row.execution_id)) invalid();
    const raw = db.prepare('SELECT payload FROM conversations WHERE id=?').get(conversationId);
    if (typeof raw?.payload !== 'string' || Buffer.byteLength(raw.payload) > 2_000_000) invalid();
    const conversation = JSON.parse(raw.payload) as Conversation;
    if (conversation.id !== conversationId || !Array.isArray(conversation.timeline)) invalid();
    const entries = db
      .prepare('SELECT * FROM action_journal WHERE plan_id=? ORDER BY sequence')
      .all(plan.id);
    if (entries.length > 12) invalid();
    const journal = entries.map((entry) => ({
      planId: entry.plan_id as string,
      actionId: entry.action_id as string,
      sequence: entry.sequence as number,
      status: entry.status as ActionJournalEntry['status'],
      at: entry.at as number,
      ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
    }));
    for (const file of pins.filter((file) => !file.path.endsWith('-shm'))) assertPinned(file);
    return {
      plan,
      status: row.status as string,
      executionId: row.execution_id as string,
      journal,
      conversation,
    };
  } catch {
    return invalid();
  } finally {
    db?.close();
    for (const file of pins) closeSync(file.fd);
  }
}
function validatePlan(fixture: LiveCaseFixture, plan: ActionPlan) {
  if (
    !opaque(plan.id) ||
    !/^[a-f0-9]{64}$/.test(plan.digest) ||
    !Array.isArray(plan.scopeIds) ||
    plan.scopeIds.length !== 1 ||
    !opaque(plan.scopeIds[0]) ||
    !Array.isArray(plan.actions) ||
    plan.actions.length !== 3 ||
    new Set(plan.actions.map((action) => action.id)).size !== 3
  )
    invalid();
  for (let index = 0; index < names.length; index++) {
    const action = plan.actions[index];
    const content = `${names[index]} approved content`;
    if (
      !opaque(action.id) ||
      action.kind !== 'write_text' ||
      action.target !== join(fixture.root, names[index]) ||
      action.source !== undefined ||
      JSON.stringify(action.effects) !== JSON.stringify(['file.write']) ||
      action.beforeHash !== hash('') ||
      action.afterHash !== hash(content) ||
      action.bytes !== Buffer.byteLength(content) ||
      typeof action.diff !== 'string' ||
      applyPatch('', action.diff) !== content
    )
      invalid();
  }
  const manifest = { title: plan.title, scopeIds: plan.scopeIds, actions: plan.actions };
  if (hash(JSON.stringify(manifest)) !== plan.digest) invalid();
}
function validateRawJournal(snapshot: JournalSnapshot) {
  if (snapshot.status !== 'approved' || snapshot.journal.length !== statuses.length) invalid();
  snapshot.journal.forEach((entry, index) => {
    if (
      entry.planId !== snapshot.plan.id ||
      entry.actionId !== snapshot.plan.actions[indices[index]].id ||
      entry.sequence !== index + 1 ||
      entry.status !== statuses[index] ||
      !Number.isSafeInteger(entry.at) ||
      entry.at < 0 ||
      entry.detail !== undefined
    )
      invalid();
  });
}
function previousApproval(snapshot: JournalSnapshot): LiveApprovalRecord {
  const approved = snapshot.conversation.timeline.filter(
    (item) => item.request?.preview.plan?.id === snapshot.plan.id,
  );
  if (approved.length !== 1 || approved[0].decision !== 'allow-once') invalid();
  const request = approved[0].request as PermissionRequest;
  if (
    !opaque(request.requestId) ||
    request.call.name !== 'execute_plan' ||
    request.allowSession ||
    request.preview.kind !== 'plan' ||
    request.preview.research ||
    JSON.stringify(request.preview.plan) !== JSON.stringify(snapshot.plan)
  )
    invalid();
  livePermissionFingerprint(request);
  return freeze({ request, decision: 'allow-once' as const, phaseId: 'initial' });
}
function validateFiles(fixture: LiveCaseFixture, checkpoint: LiveFixtureCheckpoint) {
  const expected = new Map([
    ['.preserve/sentinel.bin', hash('Unselected fixture sentinel.\n')],
    ['first.txt', hash('first.txt approved content')],
    ['second.txt', hash('second.txt approved content')],
  ]);
  const files = checkpoint.files.filter((entry) => entry.kind === 'file');
  if (
    checkpoint.files.length !== expected.size + 1 ||
    checkpoint.files
      .filter((entry) => entry.kind === 'directory')
      .some((entry) => entry.path !== '.preserve') ||
    files.length !== expected.size ||
    checkpoint.files.some((entry) => entry.path === 'third.txt')
  )
    invalid();
  for (const entry of files) {
    if (entry.sha256 !== expected.get(entry.path)) invalid();
    const file = pin(join(fixture.root, entry.path), 4096n);
    try {
      if (pinnedHash(file) !== entry.sha256) invalid();
    } finally {
      closeSync(file.fd);
    }
  }
  absent(join(fixture.root, 'third.txt'));
}
export interface LiveCrashBoundary {
  readonly caseId: 'C07';
  readonly phaseId: 'initial';
  readonly conversationId: string;
  readonly planId: string;
  readonly rawJournalSha256: string;
  readonly checkpoint: LiveFixtureCheckpoint;
  readonly proofBoundary: 'actual-child-and-owned-files-and-journal-only';
}
interface Owner {
  fixture: LiveCaseFixture;
  profile: LiveCredentialProfile;
  outcome: LiveChildOutcome;
  snapshot: JournalSnapshot;
  approval: LiveApprovalRecord;
  consumed: boolean;
}
const owners = new WeakMap<LiveCrashBoundary, Owner>();
const captured = new WeakSet<LiveChildOutcome>();
/** Bind parent intent to the independently captured actual crash journal. Missing IPC ACK
 * remains missing; this proves durable agreement, not human identity or a restored grant.
 */
export function reconcileLiveCrashParentDecision(
  boundary: LiveCrashBoundary,
  session: LiveParentPermissionSession,
) {
  const owner = owners.get(boundary);
  if (
    !owner ||
    !matchesLiveChildPermissionSession(owner.outcome, session) ||
    !matchesLiveParentPermissionDecision(
      session,
      owner.approval.request,
      boundary.conversationId,
      'initial',
    )
  )
    invalid();
  return Object.freeze({
    planId: boundary.planId,
    permissionFingerprint: livePermissionFingerprint(owner.approval.request),
    delivery: session.evidence().records[0].acknowledged
      ? ('acknowledged' as const)
      : ('durably-reconciled' as const),
    proofBoundary: 'actual-crash-journal-and-parent-review-intent-only' as const,
  });
}
export interface LiveRecoveredCrash {
  readonly checkpoint: LiveFixtureCheckpoint;
  readonly observation: LiveControlledObservation;
  readonly previousApproval: LiveApprovalRecord;
  readonly rawJournalSha256: string;
}
/** Parent-only barrier BEFORE any service constructor can rewrite interrupted rows.
 * Durable allow-once is a journal fact, not proof of human review. No callback, exit code
 * field or copied JSON can replace the fixture-bound actual ChildProcess outcome.
 */
export async function captureLiveCrashBoundary(input: {
  fixture: LiveCaseFixture;
  profile: LiveCredentialProfile;
  outcome: LiveChildOutcome;
  conversationId: string;
  expectedEntrySha256: string;
  expectedExecSha256: string;
}): Promise<LiveCrashBoundary> {
  const options = { ...input };
  const { fixture, profile, outcome } = options;
  if (
    fixture.caseId !== 'C07' ||
    !opaque(options.conversationId) ||
    !/^[a-f0-9]{64}$/.test(options.expectedEntrySha256) ||
    !/^[a-f0-9]{64}$/.test(options.expectedExecSha256) ||
    dirname(profile.isolatedRoot) !== dirname(fixture.root) ||
    captured.has(outcome)
  )
    invalid();
  assertLiveChildOutcome(outcome, {
    entrySha256: options.expectedEntrySha256,
    execSha256: options.expectedExecSha256,
    exitCode: 23,
  });
  assertLiveFixtureChildOutcome(fixture, outcome);
  if (outcome.actualExitSignal !== null || outcome.reason !== 'exited') invalid();
  // Claim before the first await. Invalid captures cannot be replayed as a new phase.
  captured.add(outcome);
  await assertLiveCredentialProfile(profile);
  const checkpoint = await captureLiveFixtureCheckpoint(fixture, 'after-crash');
  validateFiles(fixture, checkpoint);
  const snapshot = readJournal(profile, options.conversationId);
  validatePlan(fixture, snapshot.plan);
  validateRawJournal(snapshot);
  const scopes = snapshot.conversation.scopes ?? [];
  if (
    !scopes.some(
      (scope) =>
        scope.id === snapshot.plan.scopeIds[0] &&
        scope.path === fixture.root &&
        scope.mode === 'write',
    )
  )
    invalid();
  const reports = outcome.messages.filter((message) => message.type === 'boundary');
  if (
    reports.length !== 1 ||
    reports[0].phaseId !== 'initial' ||
    reports[0].planId !== snapshot.plan.id ||
    reports[0].actionId !== snapshot.plan.actions[1].id ||
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.conversation.state)
  )
    invalid();
  const approval = previousApproval(snapshot);
  await assertLiveCredentialProfile(profile);
  assertLiveFixtureChildOutcome(fixture, outcome);
  const boundary: LiveCrashBoundary = Object.freeze({
    caseId: 'C07',
    phaseId: 'initial',
    conversationId: options.conversationId,
    planId: snapshot.plan.id,
    rawJournalSha256: hash(JSON.stringify(snapshot.journal)),
    checkpoint,
    proofBoundary: 'actual-child-and-owned-files-and-journal-only',
  });
  owners.set(boundary, { fixture, profile, outcome, snapshot, approval, consumed: false });
  return boundary;
}
/** Verify the actual main service's same-profile recovery, without dispatch or approval.
 * The returned observation may feed the C07 oracle. It does not authorize a follow-up or
 * native credentials, prove network/human consent, or make this a complete live launcher.
 */
export async function verifyLiveCrashRecovery(
  boundary: LiveCrashBoundary,
  service: DesktopService,
): Promise<LiveRecoveredCrash> {
  const owner = owners.get(boundary);
  if (!owner || owner.consumed || !(service instanceof DesktopService)) invalid();
  owner.consumed = true;
  await assertLiveCredentialProfile(owner.profile);
  assertLiveFixtureChildOutcome(owner.fixture, owner.outcome);
  const current = await captureLiveFixtureCheckpoint(owner.fixture, 'after-crash');
  validateFiles(owner.fixture, current);
  if (current.sha256 !== boundary.checkpoint.sha256) invalid();
  const snapshot = readJournal(owner.profile, boundary.conversationId);
  const before = owner.snapshot;
  if (
    snapshot.status !== 'interrupted' ||
    snapshot.executionId !== before.executionId ||
    JSON.stringify(snapshot.plan) !== JSON.stringify(before.plan) ||
    snapshot.journal.length !== before.journal.length + 2 ||
    JSON.stringify(snapshot.journal.slice(0, before.journal.length)) !==
      JSON.stringify(before.journal)
  )
    invalid();
  for (let index = 0; index < 2; index++) {
    const entry = snapshot.journal[before.journal.length + index];
    if (
      entry.actionId !== snapshot.plan.actions[index + 1].id ||
      entry.planId !== snapshot.plan.id ||
      entry.sequence !== before.journal.length + index + 1 ||
      entry.status !== 'interrupted' ||
      (index === 0
        ? !entry.detail?.includes('effect may have occurred')
        : !entry.detail?.includes('Approval was not retained'))
    )
      invalid();
  }
  const conversation = service.getConversation(boundary.conversationId);
  const record = conversation.actionPlans?.find((plan) => plan.plan.id === boundary.planId);
  if (
    conversation.state !== 'interrupted' ||
    snapshot.conversation.state !== 'interrupted' ||
    conversation.pendingPermission ||
    record?.status !== 'interrupted' ||
    JSON.stringify(record.journal) !== JSON.stringify(snapshot.journal) ||
    !conversation.messages.some((message) => message.content.includes('effect may have occurred'))
  )
    invalid();
  await assertLiveCredentialProfile(owner.profile);
  return freeze({
    checkpoint: boundary.checkpoint,
    previousApproval: owner.approval,
    rawJournalSha256: boundary.rawJournalSha256,
    observation: {
      boundaryId: 'process-exit-after-effect-before-journal' as const,
      phaseId: 'initial',
      at: Date.now(),
      planId: boundary.planId,
      actionId: before.plan.actions[1].id,
      processExitCode: 23,
    },
  });
}
