import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActionPlanRecord, Conversation } from '../../apps/desktop/src/bridge';
import type { ActionJournalPort, ActionPlan, PermissionRequest } from '../../packages/core/src';
import type { ProsperoStore } from '../../packages/persistence/src';
import { livePermissionFingerprint } from './live-approval';
import { getLiveCase, type LiveBoundaryId } from './live-cases';
import {
  captureLiveFixtureCheckpoint,
  LIVE_CONTROLLED_EDIT_TEXT,
  type LiveCaseFixture,
  type LiveControlledObservation,
  type LiveFixtureCheckpoint,
  type LiveNativeTrashReceipt,
  type LiveOutcomeInput,
} from './live-fixtures';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const terminalStates = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const errorText = 'Live controlled action boundary is unavailable or inconsistent.';
const triggerError = 'Live controlled journal running INSERT failure.';
function invalid(): never {
  throw new Error(errorText);
}
function within(root: string, path: string) {
  const value = relative(root, path);
  return (
    isAbsolute(path) &&
    value !== '' &&
    value !== '..' &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value) &&
    !value.startsWith('.preserve')
  );
}
function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export interface LiveActionBoundaryOptions {
  readonly fixture: LiveCaseFixture;
  readonly store: ProsperoStore | (() => ProsperoStore);
  readonly conversationId: string;
  /** An existing, dedicated profile below this branded fixture's parent temp directory. */
  readonly databasePath: string;
  readonly phaseId: () => string;
  readonly getConversation: () => Conversation;
  /** Must synchronously initiate DesktopService.stopTask before returning its promise. */
  readonly stopTask: () => void | Promise<void>;
  readonly nativeTrash?: {
    readonly adapter: LiveNativeTrashReceipt['adapter'];
    trash(path: string): Promise<void>;
  };
  /** Only an actual child-process exit can implement this never-returning boundary.
   * Parent observation of exit status and SQLite reopening remains a separate requirement.
   */
  readonly beforeCrashCommit?: (
    event: Readonly<{
      planId: string;
      actionId: string;
      target: string;
      phaseId: string;
    }>,
  ) => never;
}
export interface LiveActionBoundaries {
  wrapJournal(delegate: ActionJournalPort): ActionJournalPort;
  observeConversation(): Promise<void>;
  beforePermissionReview(
    request: PermissionRequest,
    phaseId: string,
    signal: AbortSignal,
  ): Promise<void>;
  prepareFollowUp(boundary: LiveBoundaryId, phaseId: string, signal: AbortSignal): Promise<void>;
  trash(path: string): Promise<void>;
  evidence(): Omit<LiveOutcomeInput, 'conversation' | 'approvals'>;
  dispose(): Promise<void>;
}

/** Acceptance-only main-owned hooks. They never turn model text into observations or grants.
 * Controlled faults are the ones already disclosed by the fixed catalog. Actual filesystem,
 * journal and native evidence remains required; these callbacks are not human authorization.
 */
export async function createLiveActionBoundaries(
  input: LiveActionBoundaryOptions,
): Promise<LiveActionBoundaries> {
  const options = { ...input, nativeTrash: input.nativeTrash && { ...input.nativeTrash } };
  const fixture = options.fixture;
  await captureLiveFixtureCheckpoint(fixture, 'during-approval'); // Validates the opaque owner.
  const definition = getLiveCase(fixture.caseId);
  if (fixture.caseId === 'C07' && !options.beforeCrashCommit) invalid();
  const parent = dirname(fixture.root);
  const profileRelative = relative(parent, options.databasePath);
  if (
    !options.conversationId ||
    !isAbsolute(options.databasePath) ||
    !profileRelative ||
    profileRelative === '..' ||
    profileRelative.startsWith(`..${sep}`) ||
    isAbsolute(profileRelative) ||
    within(fixture.root, options.databasePath) ||
    options.databasePath === fixture.root ||
    (await realpath(options.databasePath)) !== options.databasePath
  )
    invalid();
  const profileDirectories: { path: string; dev: number; ino: number }[] = [];
  for (let path = dirname(options.databasePath); ; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    profileDirectories.push({ path, dev: info.dev, ino: info.ino });
    if (path === parent) break;
  }
  const info = await lstat(options.databasePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) invalid();
  const databaseIdentity = { dev: info.dev, ino: info.ino };
  let closed = false;
  let faultPlan: string | undefined;
  let faultAction: string | undefined;
  let trigger: string | undefined;
  let db: DatabaseSync | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopFailed = false;
  const prepared = new Map<string, string>();
  const triggered = new Set<LiveBoundaryId>();
  const completed = new Set<LiveBoundaryId>();
  const observations: LiveControlledObservation[] = [];
  const checkpoints: LiveFixtureCheckpoint[] = [];
  const nativeTrashReceipts: LiveNativeTrashReceipt[] = [];
  const store = () => (typeof options.store === 'function' ? options.store() : options.store);
  const phase = () => {
    const id = options.phaseId();
    if (!['initial', ...definition.followUps.map((entry) => entry.id)].includes(id)) invalid();
    return id;
  };
  const assertOpen = () => {
    if (closed) invalid();
  };
  const plans = () => store().actionPlans(options.conversationId);
  const own = (planId: string): ActionPlanRecord => {
    assertOpen();
    const records = plans().filter((record) => record.plan.id === planId);
    if (
      records.length !== 1 ||
      !prepared.has(planId) ||
      prepared.get(planId) !== JSON.stringify(records[0].plan)
    )
      invalid();
    return records[0];
  };
  const validatePlan = (plan: ActionPlan) => {
    if (
      !plan.actions.length ||
      !plan.actions.every((action) =>
        [action.target, action.source].every((path) => !path || within(fixture.root, path)),
      )
    )
      invalid();
  };
  const latest = (record: ActionPlanRecord, actionId: string) =>
    record.journal.findLast((entry) => entry.actionId === actionId)?.status;
  const actualConversation = () => {
    assertOpen();
    const current = options.getConversation();
    const saved = store().getConversation<Conversation>(options.conversationId);
    if (!saved || current.id !== options.conversationId || saved.id !== current.id) invalid();
    return { current, saved };
  };
  const pending = (request: PermissionRequest) => {
    const { current, saved } = actualConversation();
    // DesktopService deliberately keeps the active resolver/snapshot in main memory.
    // Its audit timeline, rather than pendingPermission, is the persisted counterpart.
    const savedRequest = saved.timeline.findLast(
      (entry) => entry.type === 'permission' && entry.request?.requestId === request.requestId,
    );
    if (
      !current.pendingPermission ||
      current.state !== 'waiting-permission' ||
      !savedRequest?.request ||
      savedRequest.decision !== undefined ||
      livePermissionFingerprint(current.pendingPermission) !== livePermissionFingerprint(request) ||
      livePermissionFingerprint(savedRequest.request) !== livePermissionFingerprint(request) ||
      !request.preview.plan ||
      own(request.preview.plan.id).status !== 'prepared' ||
      JSON.stringify(own(request.preview.plan.id).plan) !== JSON.stringify(request.preview.plan)
    )
      invalid();
    return request.preview.plan;
  };
  const settled = () => {
    const { current, saved } = actualConversation();
    if (
      !terminalStates.has(current.state) ||
      current.pendingPermission ||
      saved.pendingPermission ||
      current.state !== saved.state
    )
      invalid();
    return current;
  };
  const observation = (boundaryId: LiveBoundaryId, planId?: string, actionId?: string) => {
    if (completed.has(boundaryId)) invalid();
    observations.push(
      Object.freeze({ boundaryId, phaseId: phase(), at: Date.now(), planId, actionId }),
    );
    completed.add(boundaryId);
  };
  const capture = async (label: string) => {
    const checkpoint = await captureLiveFixtureCheckpoint(fixture, label);
    checkpoints.push(checkpoint);
    return checkpoint;
  };
  const file = (checkpoint: LiveFixtureCheckpoint, path: string) =>
    checkpoint.files.find((entry) => entry.path === path);
  const bytes = (checkpoint: LiveFixtureCheckpoint, path: string, content: string) =>
    file(checkpoint, path)?.sha256 === hash(content);
  const assertDatabase = () => {
    for (const expected of profileDirectories) {
      const current = lstatSync(expected.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      )
        invalid();
    }
    const current = lstatSync(options.databasePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== databaseIdentity.dev ||
      current.ino !== databaseIdentity.ino
    )
      invalid();
  };
  const installFailure = (plan: ActionPlan) => {
    assertDatabase();
    db ??= new DatabaseSync(options.databasePath);
    const row = db
      .prepare('SELECT payload,conversation_id FROM action_plans WHERE id=?')
      .get(plan.id) as { payload: string; conversation_id: string } | undefined;
    if (
      !row ||
      row.payload !== JSON.stringify(plan) ||
      row.conversation_id !== options.conversationId
    )
      invalid();
    trigger = `live_running_${randomUUID().replaceAll('-', '')}`;
    db.exec(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON action_journal WHEN NEW.status='running' AND NEW.plan_id=${sqlText(plan.id)} BEGIN SELECT RAISE(ABORT,${sqlText(triggerError)}); END;`,
    );
    faultPlan = plan.id;
  };
  const readPinnedSync = (target: string, expectedHash: string | undefined) => {
    if (!within(fixture.root, target) || !expectedHash) invalid();
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) invalid();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 4 * 1024 * 1024)
        invalid();
      const value = readFileSync(fd);
      if (hash(value) !== expectedHash) invalid();
    } finally {
      closeSync(fd);
    }
  };

  return {
    wrapJournal(delegate) {
      assertOpen();
      return {
        prepare(plan) {
          assertOpen();
          validatePlan(plan);
          delegate.prepare(plan);
          prepared.set(plan.id, JSON.stringify(plan));
          const record = own(plan.id);
          if (
            record.status !== 'prepared' ||
            record.journal.some((entry) => entry.status !== 'prepared')
          )
            invalid();
          if (
            fixture.caseId === 'C09' &&
            phase() === 'initial' &&
            !faultPlan &&
            plan.actions.length === 1 &&
            plan.actions[0].kind === 'write_text' &&
            plan.actions[0].target === join(fixture.root, 'storage-result.txt') &&
            plan.actions[0].afterHash === hash('Recovered under fresh approval')
          )
            installFailure(plan);
        },
        decision(planId, decision) {
          own(planId);
          delegate.decision(planId, decision);
          const record = own(planId);
          if (record.status !== (decision === 'deny' ? 'denied' : 'approved')) invalid();
        },
        transition(planId, actionId, status, detail) {
          const prior = own(planId);
          const action = prior.plan.actions.find((entry) => entry.id === actionId);
          if (!action) invalid();
          if (
            fixture.caseId === 'C07' &&
            phase() === 'initial' &&
            status === 'succeeded' &&
            prior.plan.actions[1]?.id === actionId &&
            action.kind === 'write_text' &&
            action.target === join(fixture.root, 'second.txt') &&
            latest(prior, actionId) === 'running' &&
            latest(prior, prior.plan.actions[0].id) === 'succeeded'
          ) {
            readPinnedSync(action.target, hash('second.txt approved content'));
            readPinnedSync(join(fixture.root, 'first.txt'), hash('first.txt approved content'));
            if (!options.beforeCrashCommit) invalid();
            options.beforeCrashCommit(
              Object.freeze({ planId, actionId, target: action.target, phaseId: phase() }),
            );
            invalid(); // A returning callback is not proof of a child exit.
          }
          try {
            delegate.transition(planId, actionId, status, detail);
          } catch (error) {
            if (
              fixture.caseId === 'C09' &&
              planId === faultPlan &&
              status === 'running' &&
              error instanceof Error &&
              error.message.includes(triggerError) &&
              latest(own(planId), actionId) === 'prepared'
            ) {
              faultAction = actionId;
              triggered.add('sqlite-before-running');
            }
            throw error;
          }
          const committed = own(planId);
          if (latest(committed, actionId) !== status) invalid();
          if (
            fixture.caseId === 'C05' &&
            phase() === 'initial' &&
            status === 'succeeded' &&
            action.kind === 'write_text' &&
            action.target === join(fixture.root, 'first.txt') &&
            action.afterHash === hash('first.txt approved content') &&
            prior.plan.actions[0].id === actionId &&
            prior.plan.actions.length === 3 &&
            !triggered.has('request-stop-after-effect')
          ) {
            // This callback starts the actual abort synchronously, between journal transitions.
            triggered.add('request-stop-after-effect');
            faultPlan = planId;
            faultAction = actionId;
            try {
              stopPromise = Promise.resolve(options.stopTask());
            } catch (error) {
              stopFailed = true;
              throw error;
            }
            void stopPromise.catch(() => {
              stopFailed = true;
            });
          }
        },
        finish(planId, status) {
          own(planId);
          delegate.finish(planId, status);
          if (own(planId).status !== status) invalid();
        },
        entries(planId) {
          const record = own(planId);
          const result = delegate.entries(planId);
          if (JSON.stringify(result) !== JSON.stringify(record.journal)) invalid();
          return result;
        },
      };
    },
    async observeConversation() {
      actualConversation(); // Publication wakes this read; model-provided observations are absent.
    },
    async beforePermissionReview(request, phaseId, signal) {
      assertOpen();
      signal.throwIfAborted();
      if (phaseId !== phase()) invalid();
      if (!request.preview.plan) return;
      const plan = pending(request);
      if (
        fixture.caseId === 'F10' &&
        phaseId === 'initial' &&
        !triggered.has('stale-before-approve')
      ) {
        const action = plan.actions.find(
          (entry) =>
            entry.kind === 'copy_file' &&
            entry.source === join(fixture.root, 'input.txt') &&
            entry.target === join(fixture.root, 'result.txt'),
        );
        if (!action || plan.actions.length !== 1 || !action.beforeHash) invalid();
        await captureLiveFixtureCheckpoint(fixture, 'during-approval');
        const path = join(fixture.root, 'input.txt');
        const before = await lstat(path);
        const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          await captureLiveFixtureCheckpoint(fixture, 'during-approval');
          pending(request);
          signal.throwIfAborted();
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            hash(await handle.readFile()) !== action.beforeHash
          )
            invalid();
          const content = Buffer.from(LIVE_CONTROLLED_EDIT_TEXT);
          await handle.write(content, 0, content.length, 0);
          await handle.truncate(content.length);
          await handle.sync();
          triggered.add('stale-before-approve');
          faultPlan = plan.id;
          faultAction = action.id;
        } finally {
          await handle.close();
        }
      }
      if (fixture.caseId === 'C03' && phaseId === 'initial' && !completed.has('approval-wait')) {
        if (
          plan.actions.length !== 1 ||
          plan.actions[0].kind !== 'write_text' ||
          plan.actions[0].target !== join(fixture.root, 'note.txt') ||
          plan.actions[0].afterHash !== hash('Approved after a responsive wait.\n')
        )
          invalid();
        const started = performance.now();
        for (;;) {
          pending(request);
          signal.throwIfAborted();
          const snapshot = await captureLiveFixtureCheckpoint(fixture, 'during-approval');
          if (file(snapshot, 'note.txt')) invalid();
          if (performance.now() - started >= 250) {
            checkpoints.push(snapshot);
            observations.push(
              Object.freeze({
                boundaryId: 'approval-wait',
                phaseId,
                at: Date.now(),
                planId: plan.id,
                durationMs: Math.floor(performance.now() - started),
              }),
            );
            completed.add('approval-wait');
            break;
          }
          await wait(Math.min(50, Math.max(1, 251 - (performance.now() - started))), signal);
        }
      }
    },
    async prepareFollowUp(boundary, phaseId, signal) {
      assertOpen();
      signal.throwIfAborted();
      if (
        !definition.followUps.some((entry) => entry.id === phaseId && entry.after === boundary) ||
        phase() !== 'initial' ||
        completed.has(boundary)
      )
        invalid();
      if (stopPromise) await stopPromise;
      signal.throwIfAborted();
      const current = settled();
      if (boundary === 'changed-classification') {
        const record = plans().find(
          (entry) =>
            prepared.has(entry.plan.id) &&
            entry.status === 'completed' &&
            entry.plan.actions.some(
              (action) =>
                action.kind === 'move_file' &&
                action.source === join(fixture.root, 'paper.pdf') &&
                action.target === join(fixture.root, 'Retrieval/paper.pdf') &&
                latest(entry, action.id) === 'succeeded',
            ),
        );
        if (!record) invalid();
        const checkpoint = await capture('before-reclassification');
        if (!file(checkpoint, 'Retrieval/paper.pdf') || file(checkpoint, 'Evaluation/paper.pdf'))
          invalid();
        observation(boundary, record.plan.id);
        return;
      }
      if (boundary === 'deny-first-plan') {
        const record = plans().find(
          (entry) =>
            prepared.has(entry.plan.id) &&
            entry.status === 'denied' &&
            entry.plan.actions.length === 1 &&
            entry.plan.actions[0].kind === 'move_file' &&
            entry.plan.actions[0].source === join(fixture.root, 'input.txt') &&
            entry.plan.actions[0].target === join(fixture.root, 'denied.txt') &&
            latest(entry, entry.plan.actions[0].id) === 'denied',
        );
        if (!record) invalid();
        const checkpoint = await capture('after-denial');
        if (
          file(checkpoint, 'denied.txt') ||
          file(checkpoint, 'input.txt')?.sha256 !== record.plan.actions[0].beforeHash
        )
          invalid();
        observation(boundary, record.plan.id, record.plan.actions[0].id);
        return;
      }
      if (!triggered.has(boundary) || !faultPlan) invalid();
      const record = own(faultPlan);
      if (boundary === 'stale-before-approve') {
        if (record.status !== 'stale') invalid();
        const checkpoint = await capture('after-stale');
        if (
          !bytes(checkpoint, 'input.txt', LIVE_CONTROLLED_EDIT_TEXT) ||
          file(checkpoint, 'result.txt')
        )
          invalid();
      } else if (boundary === 'request-stop-after-effect') {
        if (stopFailed || current.state !== 'cancelled' || record.status !== 'partial') invalid();
        const checkpoint = await capture('after-stop');
        if (
          !bytes(checkpoint, 'first.txt', 'first.txt approved content') ||
          file(checkpoint, 'second.txt') ||
          file(checkpoint, 'third.txt')
        )
          invalid();
      } else if (boundary === 'native-failure-after-first-effect') {
        if (record.status !== 'partial') invalid();
        const checkpoint = await capture('after-partial');
        if (
          !bytes(checkpoint, 'input.txt', 'Source stays intact') ||
          !bytes(checkpoint, 'copied.txt', 'Source stays intact') ||
          !bytes(checkpoint, 'trash-me.txt', 'Native failure fixture') ||
          file(checkpoint, 'remaining.txt')
        )
          invalid();
      } else if (boundary === 'sqlite-before-running') {
        if (record.status !== 'failed' || !trigger || !db) invalid();
        const checkpoint = await capture('after-storage-failure');
        if (file(checkpoint, 'storage-result.txt')) invalid();
        assertDatabase();
        db.exec(`DROP TRIGGER ${trigger}`);
        trigger = undefined;
      } else invalid();
      signal.throwIfAborted();
      observation(boundary, record.plan.id, faultAction);
    },
    async trash(path) {
      assertOpen();
      if (!options.nativeTrash || !within(fixture.root, path)) invalid();
      const records = plans().filter((record) =>
        record.plan.actions.some(
          (action) =>
            action.kind === 'trash_file' &&
            action.target === path &&
            latest(record, action.id) === 'running',
        ),
      );
      if (records.length !== 1) invalid();
      const record = own(records[0].plan.id);
      const action = record.plan.actions.find(
        (entry) => entry.kind === 'trash_file' && entry.target === path,
      );
      if (!action?.beforeHash) invalid();
      const checkpoint = await captureLiveFixtureCheckpoint(fixture, 'during-approval');
      if (file(checkpoint, relative(fixture.root, path))?.sha256 !== action.beforeHash) invalid();
      if (
        fixture.caseId === 'C06' &&
        phase() === 'initial' &&
        !triggered.has('native-failure-after-first-effect')
      ) {
        if (
          path !== join(fixture.root, 'trash-me.txt') ||
          record.plan.actions.length !== 3 ||
          record.plan.actions[0].kind !== 'copy_file' ||
          record.plan.actions[0].target !== join(fixture.root, 'copied.txt') ||
          latest(record, record.plan.actions[0].id) !== 'succeeded' ||
          !bytes(checkpoint, 'copied.txt', 'Source stays intact')
        )
          invalid();
        triggered.add('native-failure-after-first-effect');
        faultPlan = record.plan.id;
        faultAction = action.id;
        throw new Error(
          'Controlled native failure before the OS adapter; not a remote or OS fault.',
        );
      }
      try {
        await options.nativeTrash.trash(path);
        const after = await captureLiveFixtureCheckpoint(fixture, 'during-approval');
        if (file(after, relative(fixture.root, path))) invalid();
        nativeTrashReceipts.push(
          Object.freeze({
            adapter: options.nativeTrash.adapter,
            path,
            beforeSha256: action.beforeHash,
            outcome: 'completed',
          }),
        );
      } catch (error) {
        nativeTrashReceipts.push(
          Object.freeze({
            adapter: options.nativeTrash.adapter,
            path,
            beforeSha256: action.beforeHash,
            outcome: 'unknown',
          }),
        );
        throw error;
      }
    },
    evidence() {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        checkpoints: Object.freeze([...checkpoints]),
        nativeTrashReceipts: Object.freeze([...nativeTrashReceipts]),
      });
    },
    async dispose() {
      if (closed) return;
      closed = true;
      try {
        if (trigger && db) {
          assertDatabase();
          db.exec(`DROP TRIGGER ${trigger}`);
        }
      } finally {
        db?.close();
        db = undefined;
      }
    },
  };
}
