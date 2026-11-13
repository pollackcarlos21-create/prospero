import type { DatabaseSync } from 'node:sqlite';
import {
  DotError,
  archiveDot,
  recordDotReview,
  cancelDot,
  completeDot,
  createDot,
  createDotRun,
  finishDotRun,
  pauseDot,
  rehydrateDot,
  rehydrateDotRun,
  rehydrateDotCheckpoint,
  createDotCheckpoint,
  resumeDot,
  startDotRun,
  type Dot,
  type DotRun,
  type DotRunChange,
  type DotRunOutcome,
  type DotCheckpoint,
  type DotCheckpointInput,
  type DotResearchPolicyInput,
  type DotWake,
  type DotWakeInput,
  type DotIntentReview,
  type DotContextQuery,
  rehydrateDotRecordQuery,
  type DotRecordQuery,
} from '@prospero/dots';
import { DotRepositoryError } from './dot-errors';
import { DotIntentStore } from './dot-intent-store';
import type { DotIntent, DotIntentInput, DotIntentEvent, DotIntentReceipt } from './dot-intent';
import { DotPolicyStore, type DotPolicySnapshot } from './dot-policy-store';
import { DotWakeStore } from './dot-wake-store';
import type { DotIntentProvider } from './dot-intent';
import { DotAlertStore, type DotSupervisionEntry, type DotAlertClaim } from './dot-alert-store';

export type DotLifecycleCommand = 'pause' | 'resume' | 'complete' | 'cancel' | 'archive';
export interface DotPage {
  readonly limit?: number;
  readonly offset?: number;
}
export interface DotRepositorySnapshot {
  readonly dot: Dot;
  readonly checkpoint?: DotCheckpoint;
  readonly runs: readonly DotRun[];
  readonly runCount: number;
  readonly intents: readonly DotIntent[];
  readonly intentReviews: readonly DotIntentReview[];
  readonly policy?: DotPolicySnapshot;
  readonly wakes: readonly DotWake[];
}

export interface DotRequestHistory {
  readonly entries: readonly { readonly intent: DotIntent; readonly review?: DotIntentReview }[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
export interface DotContextRecord {
  readonly dotId: string;
  readonly dotRevision: number;
  readonly run?: DotRun;
  readonly checkpoint?: DotCheckpoint;
  readonly requests: readonly { readonly intent: DotIntent; readonly review?: DotIntentReview }[];
  readonly requestOffset: number;
  readonly requestCount: number;
  readonly olderRunId?: string;
}
export interface DotSavedRecord {
  readonly dotRevision: number;
  readonly run: DotRun;
  readonly checkpoint?: DotCheckpoint;
  readonly intent?: DotIntent;
  readonly review?: DotIntentReview;
}
/** Commands load authoritative snapshots and apply the existing domain transitions. */
export interface DotRepository {
  create(input: Parameters<typeof createDot>[0]): Dot;
  get(id: string): Dot | undefined;
  snapshot(id: string): DotRepositorySnapshot;
  list(options?: DotPage & { readonly includeArchived?: boolean }): readonly Dot[];
  transition(id: string, expectedRevision: number, command: DotLifecycleCommand, at: number): Dot;
  createRun(
    dotId: string,
    expectedRevision: number,
    input: {
      id: string;
      createdAt: number;
      provider?: DotIntentProvider;
      configurationRevision?: number;
    },
  ): DotRunChange;
  startRun(dotId: string, runId: string, expectedRevision: number, at: number): DotRunChange;
  finishRun(
    dotId: string,
    runId: string,
    expectedRevision: number,
    outcome: DotRunOutcome,
    at: number,
  ): DotRunChange;
  getRun(id: string): DotRun | undefined;
  runs(dotId: string, options?: DotPage): readonly DotRun[];
  checkpoint(dotId: string): DotCheckpoint | undefined;
  context(dotId: string, query?: DotContextQuery): DotContextRecord;
  record(dotId: string, query: DotRecordQuery): DotSavedRecord;
  checkpoints(dotId: string, options?: DotPage): readonly DotCheckpoint[];
  finishRunWithCheckpoint(
    dotId: string,
    runId: string,
    expectedRevision: number,
    input: DotCheckpointInput,
    at: number,
  ): DotRunChange;
  createIntent(input: DotIntentInput): DotIntent;
  intent(id: string): DotIntent | undefined;
  currentIntent(runId: string): DotIntent | undefined;
  runIntents(runId: string): readonly DotIntent[];
  intents(dotId: string, options?: DotPage): readonly DotIntent[];
  intentReview(id: string): DotIntentReview | undefined;
  acknowledgeUnknown(
    dotId: string,
    dotRevision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    note: string,
    at: number,
  ): DotIntentReview;
  requestHistory(dotId: string, options?: DotPage): DotRequestHistory;
  intentEvents(id: string): readonly DotIntentEvent[];
  decideIntent(
    id: string,
    revision: number,
    digest: string,
    decision: 'approve' | 'deny',
    at: number,
  ): DotIntent;
  invalidateIntent(
    id: string,
    revision: number,
    digest: string,
    reason: 'expired' | 'stale',
    at: number,
  ): DotIntent;
  dispatchIntent(id: string, revision: number, digest: string, at: number): DotIntent;
  settleIntent(
    id: string,
    revision: number,
    digest: string,
    outcome: { status: 'succeeded'; receipt: DotIntentReceipt } | { status: 'unknown' },
    at: number,
  ): DotIntent;
  cancelSuspendedRun(dotId: string, runId: string, revision: number, at: number): DotRunChange;
  denySuspendedRun(
    dotId: string,
    revision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    at: number,
  ): DotRunChange;
  createPolicy(input: DotResearchPolicyInput, expectedRevision: number): DotPolicySnapshot;
  currentPolicy(dotId: string): DotPolicySnapshot | undefined;
  revokePolicy(dotId: string, policyId: string, revision: number, at: number): DotPolicySnapshot;
  runPolicy(runId: string): DotPolicySnapshot | undefined;
  assertPolicyRun(
    runId: string,
    provider: DotIntentProvider,
    configurationRevision: number,
    at: number,
  ): void;
  approveByPolicy(intentId: string, at: number): DotIntent | undefined;
  canApproveByPolicy(id: string, at: number): boolean;
  supervisionPage(
    after?: string,
    limit?: number,
  ): { readonly items: readonly DotSupervisionEntry[]; readonly nextCursor?: string };
  claimSupervisionAlerts(
    entries: readonly DotSupervisionEntry[],
    at: number,
  ): readonly DotSupervisionEntry[];
  alertClaim(id: string, kind: DotSupervisionEntry['kind']): DotAlertClaim | undefined;
  policyCandidates(at: number, limit?: number): readonly string[];
  scheduleWake(
    input: DotWakeInput,
    expectedRevision: number,
    provider: DotIntentProvider,
    configurationRevision: number,
  ): DotWake;
  wake(id: string): DotWake | undefined;
  cancelWake(dotId: string, id: string, expectedRevision: number, at: number): DotWake;
  cancelDotWakes(dotId: string, at: number): void;
  dueWakes(at: number, limit?: number): readonly DotWake[];
  nextWakeAt(): number | undefined;
  claimWake(
    id: string,
    expectedRevision: number,
    input: {
      runId: string;
      at: number;
      provider?: DotIntentProvider;
      configurationRevision?: number;
    },
  ): { readonly wake: DotWake; readonly pair?: DotRunChange };
  /** Explicit startup operation. Caller must prove exclusive ownership, never an ordinary read. */
  recoverInFlight(
    at: number,
    hasExclusiveOwnership: () => boolean,
    limit?: number,
  ): readonly DotRunChange[];
}

type Row = Record<string, unknown>;
const commands = {
  pause: pauseDot,
  resume: resumeDot,
  complete: completeDot,
  cancel: cancelDot,
  archive: archiveDot,
};

function checkId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id || id.length > 128 || id.includes('\0'))
    throw new DotError('invalid-input');
}

function checkRevision(revision: unknown): asserts revision is number {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    throw new DotError('invalid-input');
}

function page(options: DotPage): { limit: number; offset: number } {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new DotError('invalid-input');
  const limit = options.limit === undefined ? 50 : options.limit;
  const offset = options.offset === undefined ? 0 : options.offset;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new DotError('invalid-input');
  return { limit, offset };
}

function invalidStored(): never {
  throw new DotRepositoryError('invalid-stored-state');
}

function decodeDot(row: Row): Dot {
  let dot: Dot;
  try {
    if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 128 * 1024)
      return invalidStored();
    dot = rehydrateDot(JSON.parse(row.payload));
  } catch {
    return invalidStored();
  }
  if (
    row.id !== dot.id ||
    row.revision !== dot.revision ||
    row.lifecycle !== dot.lifecycle ||
    row.created_at !== dot.createdAt ||
    row.updated_at !== dot.updatedAt ||
    row.in_flight_run_id !== (dot.inFlightRunId ?? null)
  )
    invalidStored();
  return dot;
}

function decodeRun(row: Row): DotRun {
  let run: DotRun;
  try {
    if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 4 * 1024)
      return invalidStored();
    run = rehydrateDotRun(JSON.parse(row.payload));
  } catch {
    return invalidStored();
  }
  if (
    row.id !== run.id ||
    row.dot_id !== run.dotId ||
    row.dot_revision !== run.dotRevision ||
    row.status !== run.status ||
    row.created_at !== run.createdAt ||
    row.updated_at !== run.updatedAt ||
    run.dotRevision < 1
  )
    invalidStored();
  return run;
}

function checkOwnership(dot: Dot, run: DotRun): void {
  if (
    run.dotId !== dot.id ||
    run.createdAt < dot.createdAt ||
    run.updatedAt > dot.updatedAt ||
    run.dotRevision > dot.revision
  )
    invalidStored();
  if (run.status === 'pending' || run.status === 'running') {
    if (
      dot.inFlightRunId !== run.id ||
      dot.revision !== run.dotRevision ||
      dot.updatedAt !== run.updatedAt
    )
      invalidStored();
  } else if (dot.inFlightRunId === run.id) invalidStored();
}

/** Internal factory; the public facade is obtained from ProsperoStore.dots(). */
export function createDotRepository(db: DatabaseSync): DotRepository {
  const operation = <T>(write: boolean, body: () => T): T => {
    let began = false;
    try {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      began = true;
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* The connection may already be closed. */
        }
      }
      if (error instanceof DotError || error instanceof DotRepositoryError) throw error;
      throw new DotRepositoryError('storage-failure');
    }
  };
  const runRow = (id: string): DotRun | undefined => {
    const row = db.prepare('SELECT * FROM dot_runs WHERE id=?').get(id);
    return row ? decodeRun(row) : undefined;
  };
  const loadDot = (id: string): Dot | undefined => {
    const row = db.prepare('SELECT * FROM dots WHERE id=?').get(id);
    if (!row) return undefined;
    const dot = decodeDot(row);
    const current = db
      .prepare("SELECT * FROM dot_runs WHERE dot_id=? AND status IN ('pending','running')")
      .all(id);
    if (current.length !== (dot.inFlightRunId === undefined ? 0 : 1)) invalidStored();
    if (current.length) checkOwnership(dot, decodeRun(current[0]));
    return dot;
  };
  const requiredDot = (id: string, revision?: number): Dot => {
    const dot = loadDot(id);
    if (!dot) throw new DotRepositoryError('not-found');
    if (revision !== undefined && dot.revision !== revision)
      throw new DotRepositoryError('conflict');
    return dot;
  };
  const requiredRun = (id: string): DotRun => {
    const run = runRow(id);
    if (!run) throw new DotRepositoryError('not-found');
    return run;
  };
  const intents = new DotIntentStore(db, (dotId, runId) => {
    const dot = requiredDot(dotId);
    const run = requiredRun(runId);
    checkOwnership(dot, run);
    return { dot, run };
  });
  const policies = new DotPolicyStore(db, requiredDot, requiredRun, intents);
  const alerts = new DotAlertStore(db, intents, requiredDot);
  const wakes = new DotWakeStore(db, requiredDot, requiredRun, policies);
  const decodeCheckpoint = (dot: Dot, row: Row): DotCheckpoint => {
    let checkpoint: DotCheckpoint;
    try {
      if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 64 * 1024)
        return invalidStored();
      checkpoint = rehydrateDotCheckpoint(JSON.parse(row.payload));
    } catch {
      return invalidStored();
    }
    if (
      row.dot_id !== checkpoint.dotId ||
      row.run_id !== checkpoint.runId ||
      row.revision !== checkpoint.revision ||
      row.updated_at !== checkpoint.updatedAt
    )
      invalidStored();
    const run = runRow(checkpoint.runId);
    if (
      run?.status !== 'succeeded' ||
      checkpoint.dotId !== dot.id ||
      run.updatedAt !== checkpoint.updatedAt
    )
      invalidStored();
    checkOwnership(dot, run);
    return checkpoint;
  };
  const readCheckpoint = (dot: Dot): DotCheckpoint | undefined => {
    const row = db
      .prepare('SELECT * FROM dot_checkpoints WHERE dot_id=? ORDER BY revision DESC LIMIT 1')
      .get(dot.id);
    return row ? decodeCheckpoint(dot, row) : undefined;
  };
  const updateDot = (dot: Dot, expectedRevision: number): void => {
    const result = db
      .prepare(
        'UPDATE dots SET revision=?,lifecycle=?,updated_at=?,in_flight_run_id=?,payload=? WHERE id=? AND revision=?',
      )
      .run(
        dot.revision,
        dot.lifecycle,
        dot.updatedAt,
        dot.inFlightRunId ?? null,
        JSON.stringify(dot),
        dot.id,
        expectedRevision,
      );
    if (result.changes !== 1) throw new DotRepositoryError('conflict');
  };
  const updateRun = (run: DotRun, previous: DotRun): void => {
    const result = db
      .prepare(
        'UPDATE dot_runs SET dot_revision=?,status=?,updated_at=?,payload=? WHERE id=? AND dot_id=? AND dot_revision=? AND status=?',
      )
      .run(
        run.dotRevision,
        run.status,
        run.updatedAt,
        JSON.stringify(run),
        run.id,
        run.dotId,
        previous.dotRevision,
        previous.status,
      );
    if (result.changes !== 1) throw new DotRepositoryError('conflict');
  };
  const mutateRun = (
    dotId: string,
    runId: string,
    revision: number,
    change: (dot: Dot, run: DotRun) => DotRunChange,
    continuation?: { input: DotCheckpointInput },
  ): DotRunChange => {
    checkId(dotId);
    checkId(runId);
    checkRevision(revision);
    return operation(true, () => {
      const dot = requiredDot(dotId, revision);
      const run = requiredRun(runId);
      if (run.dotId !== dot.id) throw new DotError('invalid-reference');
      checkOwnership(dot, run);
      if (intents.current(runId)) throw new DotRepositoryError('intent-blocked');
      const next = change(dot, run);
      if (intents.forRun(runId).some((intent) => intent.updatedAt > next.run.updatedAt))
        throw new DotError('invalid-input');
      const checkpoint = continuation
        ? createDotCheckpoint(next.run, readCheckpoint(dot), continuation.input)
        : undefined;
      updateDot(next.dot, revision);
      updateRun(next.run, run);
      if (checkpoint)
        db.prepare(
          'INSERT INTO dot_checkpoints(dot_id,run_id,revision,updated_at,payload) VALUES(?,?,?,?,?)',
        ).run(
          checkpoint.dotId,
          checkpoint.runId,
          checkpoint.revision,
          checkpoint.updatedAt,
          JSON.stringify(checkpoint),
        );
      return next;
    });
  };
  const createRunInTransaction = (
    dotId: string,
    revision: number,
    input: {
      id: string;
      createdAt: number;
      provider?: DotIntentProvider;
      configurationRevision?: number;
    },
  ): DotRunChange => {
    intents.assertNoOpen(dotId, input.createdAt);
    const next = createDotRun(requiredDot(dotId, revision), {
      id: input.id,
      createdAt: input.createdAt,
    });
    if (db.prepare('SELECT id FROM dot_runs WHERE id=?').get(next.run.id))
      throw new DotRepositoryError('duplicate-id');
    updateDot(next.dot, revision);
    db.prepare(
      'INSERT INTO dot_runs(id,dot_id,dot_revision,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?)',
    ).run(
      next.run.id,
      next.run.dotId,
      next.run.dotRevision,
      next.run.status,
      next.run.createdAt,
      next.run.updatedAt,
      JSON.stringify(next.run),
    );
    policies.reserveRun(next.run, input.provider, input.configurationRevision);
    return next;
  };
  return Object.freeze({
    create(input: Parameters<typeof createDot>[0]) {
      const dot = createDot(input);
      return operation(true, () => {
        if (db.prepare('SELECT id FROM dots WHERE id=?').get(dot.id))
          throw new DotRepositoryError('duplicate-id');
        db.prepare(
          'INSERT INTO dots(id,revision,lifecycle,created_at,updated_at,in_flight_run_id,payload) VALUES(?,?,?,?,?,?,?)',
        ).run(
          dot.id,
          dot.revision,
          dot.lifecycle,
          dot.createdAt,
          dot.updatedAt,
          null,
          JSON.stringify(dot),
        );
        return dot;
      });
    },
    get(id: string) {
      checkId(id);
      return operation(false, () => loadDot(id));
    },
    snapshot(id: string) {
      checkId(id);
      return operation(false, () => {
        const dot = requiredDot(id);
        const runs = db
          .prepare(
            'SELECT * FROM dot_runs WHERE dot_id=? ORDER BY dot_revision DESC,created_at DESC,id DESC LIMIT 10',
          )
          .all(id)
          .map((row) => {
            const run = decodeRun(row);
            checkOwnership(dot, run);
            return run;
          });
        const count = db
          .prepare('SELECT COUNT(*) AS total FROM dot_runs WHERE dot_id=?')
          .get(id)?.total;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalidStored();
        const recentIntents = runs[0] ? intents.forRun(runs[0].id) : Object.freeze([]);
        return Object.freeze({
          dot,
          checkpoint: readCheckpoint(dot),
          runs: Object.freeze(runs),
          runCount: count,
          intents: recentIntents,
          intentReviews: Object.freeze(
            recentIntents.flatMap((intent) => {
              const review = intents.review(intent.id);
              return review ? [review] : [];
            }),
          ),
          policy: policies.current(id),
          wakes: wakes.history(id),
        });
      });
    },
    list(options: DotPage & { readonly includeArchived?: boolean } = {}) {
      const { limit, offset } = page(options);
      const includeArchived =
        options.includeArchived === undefined ? true : options.includeArchived;
      if (typeof includeArchived !== 'boolean') throw new DotError('invalid-input');
      return operation(false, () =>
        Object.freeze(
          db
            .prepare(
              "SELECT id FROM dots WHERE (? OR lifecycle<>'archived') ORDER BY created_at,id LIMIT ? OFFSET ?",
            )
            .all(includeArchived ? 1 : 0, limit, offset)
            .map((row) => requiredDot(row.id as string)),
        ),
      );
    },
    transition(id: string, revision: number, command: DotLifecycleCommand, at: number) {
      checkId(id);
      checkRevision(revision);
      if (!Object.hasOwn(commands, command)) throw new DotError('invalid-input');
      return operation(true, () => {
        const next = commands[command](requiredDot(id, revision), at);
        updateDot(next, revision);
        if (command !== 'resume') wakes.cancelDot(id, at, 'state');
        return next;
      });
    },
    createRun(
      dotId: string,
      revision: number,
      input: {
        id: string;
        createdAt: number;
        provider?: DotIntentProvider;
        configurationRevision?: number;
      },
    ) {
      checkId(dotId);
      checkRevision(revision);
      return operation(true, () => {
        return createRunInTransaction(dotId, revision, input);
      });
    },
    startRun(dotId: string, runId: string, revision: number, at: number) {
      return mutateRun(dotId, runId, revision, (dot, run) => startDotRun(dot, run, at));
    },
    finishRun(dotId: string, runId: string, revision: number, outcome: DotRunOutcome, at: number) {
      return mutateRun(dotId, runId, revision, (dot, run) => finishDotRun(dot, run, outcome, at));
    },
    checkpoint(dotId: string) {
      checkId(dotId);
      return operation(false, () => readCheckpoint(requiredDot(dotId)));
    },
    context(dotId: string, query: DotContextQuery = {}) {
      checkId(dotId);
      if (!query || typeof query !== 'object' || Array.isArray(query))
        throw new DotError('invalid-input');
      if (
        Object.getPrototypeOf(query) !== Object.prototype &&
        Object.getPrototypeOf(query) !== null
      )
        throw new DotError('invalid-input');
      for (const key of Reflect.ownKeys(query)) {
        const field = Object.getOwnPropertyDescriptor(query, key);
        if (
          !['runId', 'beforeRunId', 'requestOffset'].includes(String(key)) ||
          typeof key !== 'string' ||
          !field?.enumerable ||
          !Object.hasOwn(field, 'value')
        )
          throw new DotError('invalid-input');
      }
      if (query.runId !== undefined) checkId(query.runId);
      if (query.beforeRunId !== undefined) checkId(query.beforeRunId);
      if (query.runId !== undefined && query.beforeRunId !== undefined)
        throw new DotError('invalid-input');
      const requestOffset = query.requestOffset === undefined ? 0 : query.requestOffset;
      if (!Number.isSafeInteger(requestOffset) || requestOffset < 0 || requestOffset > 200)
        throw new DotError('invalid-input');
      return operation(false, () => {
        const dot = requiredDot(dotId);
        const terminal = (id: string) => {
          const run = requiredRun(id);
          if (run.dotId !== dotId) throw new DotError('invalid-reference');
          checkOwnership(dot, run);
          if (run.status === 'pending' || run.status === 'running')
            throw new DotError('invalid-transition');
          return run;
        };
        const before = query.beforeRunId === undefined ? undefined : terminal(query.beforeRunId);
        const row =
          query.runId === undefined
            ? db
                .prepare(
                  "SELECT * FROM dot_runs WHERE dot_id=? AND status NOT IN ('pending','running') AND dot_revision<? ORDER BY dot_revision DESC,id DESC LIMIT 1",
                )
                .get(dotId, before?.dotRevision ?? Number.MAX_SAFE_INTEGER)
            : undefined;
        const run =
          query.runId !== undefined ? terminal(query.runId) : row ? decodeRun(row) : undefined;
        if (!run)
          return Object.freeze({
            dotId,
            dotRevision: dot.revision,
            requests: Object.freeze([]),
            requestOffset,
            requestCount: 0,
          });
        checkOwnership(dot, run);
        const checkpointRow = db
          .prepare('SELECT * FROM dot_checkpoints WHERE run_id=?')
          .get(run.id);
        const checkpoint = checkpointRow ? decodeCheckpoint(dot, checkpointRow) : undefined;
        const count = db
          .prepare('SELECT COUNT(*) AS n FROM dot_intents WHERE run_id=?')
          .get(run.id)?.n;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 200)
          invalidStored();
        const rows = db
          .prepare(
            'SELECT id FROM dot_intents WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 2 OFFSET ?',
          )
          .all(run.id, requestOffset);
        const requests = rows.map((row) => {
          const intent = intents.required(String(row.id));
          return Object.freeze({ intent, review: intents.review(intent.id) });
        });
        const older = db
          .prepare(
            "SELECT id FROM dot_runs WHERE dot_id=? AND status NOT IN ('pending','running') AND dot_revision<? ORDER BY dot_revision DESC,id DESC LIMIT 1",
          )
          .get(dotId, run.dotRevision);
        return Object.freeze({
          dotId,
          dotRevision: dot.revision,
          run,
          checkpoint,
          requests: Object.freeze(requests),
          requestOffset,
          requestCount: count,
          olderRunId: older ? terminal(String(older.id)).id : undefined,
        });
      });
    },
    record(dotId: string, query: DotRecordQuery) {
      checkId(dotId);
      query = rehydrateDotRecordQuery(query);
      return operation(false, () => {
        const dot = requiredDot(dotId);
        const run = requiredRun(query.runId);
        if (run.dotId !== dotId) throw new DotError('invalid-reference');
        checkOwnership(dot, run);
        if (run.status === 'pending' || run.status === 'running')
          throw new DotError('invalid-transition');
        if (query.kind === 'checkpoint') {
          const row = db.prepare('SELECT * FROM dot_checkpoints WHERE run_id=?').get(run.id);
          if (!row) throw new DotRepositoryError('not-found');
          return Object.freeze({
            dotRevision: dot.revision,
            run,
            checkpoint: decodeCheckpoint(dot, row),
          });
        }
        const intent = intents.required(query.intentId);
        if (intent.dotId !== dotId || intent.runId !== run.id)
          throw new DotError('invalid-reference');
        return Object.freeze({
          dotRevision: dot.revision,
          run,
          intent,
          review: intents.review(intent.id),
        });
      });
    },
    checkpoints(dotId: string, options: DotPage = {}) {
      checkId(dotId);
      const { limit, offset } = page(options);
      return operation(false, () => {
        const dot = requiredDot(dotId);
        return Object.freeze(
          db
            .prepare(
              'SELECT * FROM dot_checkpoints WHERE dot_id=? ORDER BY revision LIMIT ? OFFSET ?',
            )
            .all(dotId, limit, offset)
            .map((row) => decodeCheckpoint(dot, row)),
        );
      });
    },
    finishRunWithCheckpoint(
      dotId: string,
      runId: string,
      revision: number,
      input: DotCheckpointInput,
      at: number,
    ) {
      return mutateRun(
        dotId,
        runId,
        revision,
        (dot, run) => finishDotRun(dot, run, 'succeeded', at),
        { input },
      );
    },
    createIntent(input: DotIntentInput) {
      return operation(true, () => {
        policies.checkIntent(input);
        return intents.create(input);
      });
    },
    intent(id: string) {
      checkId(id);
      return operation(false, () => intents.get(id));
    },
    currentIntent(runId: string) {
      checkId(runId);
      return operation(false, () => {
        requiredRun(runId);
        return intents.current(runId);
      });
    },
    runIntents(runId: string) {
      checkId(runId);
      return operation(false, () => {
        requiredRun(runId);
        return intents.forRun(runId);
      });
    },
    intents(dotId: string, options: DotPage = {}) {
      checkId(dotId);
      const { limit, offset } = page(options);
      return operation(false, () => {
        requiredDot(dotId);
        return intents.history(dotId, limit, offset);
      });
    },
    intentReview(id: string) {
      checkId(id);
      return operation(false, () => {
        intents.required(id);
        return intents.review(id);
      });
    },
    acknowledgeUnknown(
      dotId: string,
      dotRevision: number,
      id: string,
      revision: number,
      digest: string,
      note: string,
      at: number,
    ) {
      checkId(dotId);
      checkId(id);
      checkRevision(dotRevision);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        const dot = requiredDot(dotId, dotRevision);
        const intent = intents.required(id);
        if (intent.dotId !== dotId) throw new DotError('invalid-reference');
        if (intent.status !== 'unknown' || dot.inFlightRunId)
          throw new DotRepositoryError('intent-blocked');
        updateDot(recordDotReview(dot, at), dotRevision);
        const review = intents.acknowledge(id, revision, digest, dotRevision, note, at);
        const policyId = policies.revokeRun(intent.runId, at);
        if (policyId) wakes.invalidatePolicy(policyId, at);
        wakes.cancelDot(dotId, at, 'unknown');
        return review;
      });
    },
    requestHistory(dotId: string, options: DotPage = {}) {
      checkId(dotId);
      const validated = page(options);
      const limit = options.limit === undefined ? 20 : validated.limit;
      const offset = validated.offset;
      if (limit > 20) throw new DotError('invalid-input');
      return operation(false, () => {
        requiredDot(dotId);
        const total = db
          .prepare('SELECT COUNT(*) AS total FROM dot_intents WHERE dot_id=?')
          .get(dotId)?.total;
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) invalidStored();
        const rows = db
          .prepare(
            'SELECT id FROM dot_intents WHERE dot_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
          )
          .all(dotId, limit, offset);
        return Object.freeze({
          entries: Object.freeze(
            rows.map((row) => {
              const intent = intents.required(String(row.id));
              return Object.freeze({ intent, review: intents.review(intent.id) });
            }),
          ),
          total,
          offset,
          limit,
        });
      });
    },
    intentEvents(id: string) {
      checkId(id);
      return operation(false, () => intents.events(id));
    },
    decideIntent(
      id: string,
      revision: number,
      digest: string,
      decision: 'approve' | 'deny',
      at: number,
    ) {
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => intents.decide(id, revision, digest, decision, at));
    },
    invalidateIntent(
      id: string,
      revision: number,
      digest: string,
      reason: 'expired' | 'stale',
      at: number,
    ) {
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => intents.invalidate(id, revision, digest, reason, at));
    },
    dispatchIntent(id: string, revision: number, digest: string, at: number) {
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        const intent = intents.required(id);
        policies.charge(intent, at);
        return intents.dispatch(id, revision, digest, at);
      });
    },
    settleIntent(
      id: string,
      revision: number,
      digest: string,
      outcome: { status: 'succeeded'; receipt: DotIntentReceipt } | { status: 'unknown' },
      at: number,
    ) {
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        const intent = intents.settle(id, revision, digest, outcome, at);
        if (intent.status === 'unknown') {
          const policyId = policies.revokeRun(intent.runId, at);
          if (policyId) wakes.invalidatePolicy(policyId, at);
          const dot = requiredDot(intent.dotId);
          const run = requiredRun(intent.runId);
          const next = finishDotRun(dot, run, 'interrupted', at);
          updateDot(next.dot, dot.revision);
          updateRun(next.run, run);
        }
        return intent;
      });
    },
    cancelSuspendedRun(dotId: string, runId: string, revision: number, at: number) {
      checkId(dotId);
      checkId(runId);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        const dot = requiredDot(dotId, revision);
        const run = requiredRun(runId);
        if (run.dotId !== dot.id) throw new DotError('invalid-reference');
        checkOwnership(dot, run);
        intents.cancel(runId, at);
        const next = finishDotRun(dot, run, 'cancelled', at);
        updateDot(next.dot, revision);
        updateRun(next.run, run);
        return next;
      });
    },
    denySuspendedRun(
      dotId: string,
      revision: number,
      intentId: string,
      intentRevision: number,
      digest: string,
      at: number,
    ) {
      checkId(dotId);
      checkId(intentId);
      checkRevision(revision);
      checkRevision(intentRevision);
      checkRevision(at);
      return operation(true, () => {
        const dot = requiredDot(dotId, revision);
        const intent = intents.required(intentId);
        if (intent.dotId !== dotId || dot.inFlightRunId !== intent.runId)
          throw new DotError('invalid-reference');
        const run = requiredRun(intent.runId);
        intents.decide(intentId, intentRevision, digest, 'deny', at);
        const policyId = policies.revokeRun(run.id, at);
        if (policyId) wakes.invalidatePolicy(policyId, at);
        const next = finishDotRun(dot, run, 'cancelled', at);
        updateDot(next.dot, revision);
        updateRun(next.run, run);
        return next;
      });
    },
    createPolicy(input: DotResearchPolicyInput, revision: number) {
      checkRevision(revision);
      return operation(true, () => {
        intents.assertNoOpen(input.dotId, input.createdAt);
        return policies.create(input, revision);
      });
    },
    currentPolicy(dotId: string) {
      checkId(dotId);
      return operation(false, () => {
        requiredDot(dotId);
        return policies.current(dotId);
      });
    },
    revokePolicy(dotId: string, id: string, revision: number, at: number) {
      checkId(dotId);
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        if (policies.required(id).policy.dotId !== dotId) throw new DotError('invalid-reference');
        const revoked = policies.revoke(id, revision, at);
        wakes.invalidatePolicy(id, at);
        return revoked;
      });
    },
    runPolicy(runId: string) {
      checkId(runId);
      return operation(false, () => {
        requiredRun(runId);
        return policies.forRun(runId);
      });
    },
    assertPolicyRun(
      runId: string,
      provider: DotIntentProvider,
      configurationRevision: number,
      at: number,
    ) {
      checkId(runId);
      checkRevision(configurationRevision);
      checkRevision(at);
      return operation(false, () => {
        requiredRun(runId);
        policies.assertRun(runId, provider, configurationRevision, at);
      });
    },
    approveByPolicy(id: string, at: number) {
      checkId(id);
      checkRevision(at);
      return operation(true, () => policies.approve(id, at));
    },
    canApproveByPolicy(id: string, at: number) {
      checkId(id);
      checkRevision(at);
      return operation(false, () => policies.canApprove(id, at));
    },
    supervisionPage(after = '', limit = 50) {
      if (after) checkId(after);
      page({ limit });
      return operation(false, () => alerts.page(after, limit));
    },
    claimSupervisionAlerts(entries: readonly DotSupervisionEntry[], at: number) {
      checkRevision(at);
      if (!Array.isArray(entries) || entries.length > 20) throw new DotError('invalid-input');
      return operation(true, () => alerts.claim(entries, at));
    },
    alertClaim(id: string, kind: DotSupervisionEntry['kind']) {
      checkId(id);
      if (kind !== 'approval' && kind !== 'uncertain') throw new DotError('invalid-input');
      return operation(false, () => alerts.get(id, kind));
    },
    policyCandidates(at: number, limit = 50) {
      checkRevision(at);
      page({ limit });
      return operation(false, () => policies.candidates(at, limit));
    },
    scheduleWake(
      input: DotWakeInput,
      revision: number,
      provider: DotIntentProvider,
      configurationRevision: number,
    ) {
      checkRevision(revision);
      checkRevision(configurationRevision);
      return operation(true, () => {
        intents.assertNoOpen(input.dotId, input.createdAt, true);
        return wakes.create(input, revision, provider, configurationRevision);
      });
    },
    wake(id: string) {
      checkId(id);
      return operation(false, () => wakes.get(id));
    },
    cancelWake(dotId: string, id: string, revision: number, at: number) {
      checkId(dotId);
      checkId(id);
      checkRevision(revision);
      checkRevision(at);
      return operation(true, () => {
        const wake = wakes.required(id);
        if (wake.dotId !== dotId) throw new DotError('invalid-reference');
        if (wake.revision !== revision) throw new DotRepositoryError('conflict');
        return wakes.settle(wake, 'cancelled', Math.max(at, wake.updatedAt), { reason: 'user' });
      });
    },
    cancelDotWakes(dotId: string, at: number) {
      checkId(dotId);
      checkRevision(at);
      return operation(true, () => {
        requiredDot(dotId);
        wakes.cancelDot(dotId, at);
      });
    },
    dueWakes(at: number, limit = 50) {
      checkRevision(at);
      page({ limit });
      return operation(false, () => wakes.due(at, limit));
    },
    nextWakeAt() {
      return operation(false, () => wakes.nextAt());
    },
    claimWake(
      id: string,
      revision: number,
      input: {
        runId: string;
        at: number;
        provider?: DotIntentProvider;
        configurationRevision?: number;
      },
    ) {
      checkId(id);
      checkId(input.runId);
      checkRevision(revision);
      checkRevision(input.at);
      if (input.configurationRevision !== undefined) checkRevision(input.configurationRevision);
      return operation(true, () => {
        const wake = wakes.required(id);
        if (wake.revision !== revision || wake.status !== 'scheduled')
          throw new DotRepositoryError('conflict');
        const dot = requiredDot(wake.dotId);
        const at = input.at;
        if (at < wake.dueAt || at < dot.updatedAt || dot.inFlightRunId)
          return Object.freeze({ wake });
        const block =
          dot.lifecycle !== 'active'
            ? 'state'
            : policies.nextRunBlock(wake.policyId, input.provider, input.configurationRevision, at);
        if (block)
          return Object.freeze({ wake: wakes.settle(wake, 'blocked', at, { reason: block }) });
        try {
          intents.assertNoOpen(dot.id, at);
        } catch (error) {
          if (!(error instanceof DotRepositoryError && error.code === 'intent-blocked'))
            throw error;
          return Object.freeze({ wake: wakes.settle(wake, 'blocked', at, { reason: 'unknown' }) });
        }
        const pair = createRunInTransaction(dot.id, dot.revision, {
          id: input.runId,
          createdAt: at,
          provider: input.provider,
          configurationRevision: input.configurationRevision,
        });
        if (policies.forRun(pair.run.id)?.policy.id !== wake.policyId)
          throw new DotRepositoryError('policy-blocked');
        return Object.freeze({
          wake: wakes.settle(wake, 'claimed', at, { runId: pair.run.id }),
          pair,
        });
      });
    },
    getRun(id: string) {
      checkId(id);
      return operation(false, () => {
        const run = runRow(id);
        if (run) {
          const dot = loadDot(run.dotId);
          if (!dot) invalidStored();
          checkOwnership(dot, run);
        }
        return run;
      });
    },
    runs(dotId: string, options: DotPage = {}) {
      checkId(dotId);
      const { limit, offset } = page(options);
      return operation(false, () => {
        const dot = requiredDot(dotId);
        return Object.freeze(
          db
            .prepare(
              'SELECT * FROM dot_runs WHERE dot_id=? ORDER BY created_at,id LIMIT ? OFFSET ?',
            )
            .all(dotId, limit, offset)
            .map((row) => {
              const run = decodeRun(row);
              checkOwnership(dot, run);
              return run;
            }),
        );
      });
    },
    recoverInFlight(at: number, hasExclusiveOwnership: () => boolean, limit = 200) {
      checkRevision(at);
      page({ limit });
      if (typeof hasExclusiveOwnership !== 'function') throw new DotError('invalid-input');
      const assertOwner = () => {
        if (hasExclusiveOwnership() !== true) throw new DotRepositoryError('ownership-required');
      };
      return operation(true, () => {
        assertOwner();
        intents.recover(at, assertOwner, limit);
        policies.recover(at);
        wakes.invalidateUnavailable(at);
        const rows = db
          .prepare(
            "SELECT * FROM dot_runs WHERE status IN ('pending','running') AND NOT EXISTS (SELECT 1 FROM dot_intents WHERE run_id=dot_runs.id AND status IN ('pending','approved')) ORDER BY dot_id LIMIT ?",
          )
          .all(limit);
        const changes = rows.map((row) => {
          const run = decodeRun(row);
          const dot = requiredDot(run.dotId);
          checkOwnership(dot, run);
          // A backwards wall-clock jump cannot make an otherwise valid pair unrecoverable.
          const next = finishDotRun(
            dot,
            run,
            'interrupted',
            Math.max(
              at,
              dot.updatedAt,
              ...intents.forRun(run.id).map((intent) => intent.updatedAt),
            ),
          );
          assertOwner();
          updateDot(next.dot, dot.revision);
          updateRun(next.run, run);
          return next;
        });
        assertOwner();
        return Object.freeze(changes);
      });
    },
  });
}
