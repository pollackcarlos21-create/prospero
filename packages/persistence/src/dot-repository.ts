import type { DatabaseSync } from 'node:sqlite';
import {
  DotError,
  archiveDot,
  cancelDot,
  completeDot,
  createDot,
  createDotRun,
  finishDotRun,
  pauseDot,
  rehydrateDot,
  rehydrateDotRun,
  resumeDot,
  startDotRun,
  type Dot,
  type DotRun,
  type DotRunChange,
  type DotRunOutcome,
} from '@prospero/dots';
import { DotRepositoryError } from './dot-errors';

export type DotLifecycleCommand = 'pause' | 'resume' | 'complete' | 'cancel' | 'archive';
export interface DotPage {
  readonly limit?: number;
  readonly offset?: number;
}

/** Commands load authoritative snapshots and apply the existing domain transitions. */
export interface DotRepository {
  create(input: Parameters<typeof createDot>[0]): Dot;
  get(id: string): Dot | undefined;
  list(options?: DotPage & { readonly includeArchived?: boolean }): readonly Dot[];
  transition(id: string, expectedRevision: number, command: DotLifecycleCommand, at: number): Dot;
  createRun(
    dotId: string,
    expectedRevision: number,
    input: { id: string; createdAt: number },
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
  ): DotRunChange => {
    checkId(dotId);
    checkId(runId);
    checkRevision(revision);
    return operation(true, () => {
      const dot = requiredDot(dotId, revision);
      const run = requiredRun(runId);
      if (run.dotId !== dot.id) throw new DotError('invalid-reference');
      checkOwnership(dot, run);
      const next = change(dot, run);
      updateDot(next.dot, revision);
      updateRun(next.run, run);
      return next;
    });
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
        return next;
      });
    },
    createRun(dotId: string, revision: number, input: { id: string; createdAt: number }) {
      checkId(dotId);
      checkRevision(revision);
      return operation(true, () => {
        const next = createDotRun(requiredDot(dotId, revision), input);
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
        return next;
      });
    },
    startRun(dotId: string, runId: string, revision: number, at: number) {
      return mutateRun(dotId, runId, revision, (dot, run) => startDotRun(dot, run, at));
    },
    finishRun(dotId: string, runId: string, revision: number, outcome: DotRunOutcome, at: number) {
      return mutateRun(dotId, runId, revision, (dot, run) => finishDotRun(dot, run, outcome, at));
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
  });
}
