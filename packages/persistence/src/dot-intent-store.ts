import type { DatabaseSync } from 'node:sqlite';
import {
  rehydrateDotIntentReview,
  type DotIntentReview,
  type Dot,
  type DotRun,
} from '@prospero/dots';
import { createHash } from 'node:crypto';
import { DotRepositoryError } from './dot-errors';
import {
  createDotIntent,
  rehydrateDotIntent,
  intentBinding,
  invalidIntent,
  type DotIntent,
  type DotIntentInput,
  type DotIntentEvent,
  type DotIntentStatus,
  type DotIntentReceipt,
} from './dot-intent';
type Row = Record<string, unknown>;
/** Internal SQL owner. Every method runs inside the enclosing Dot repository transaction. */
export class DotIntentStore {
  constructor(
    private db: DatabaseSync,
    private pair: (dotId: string, runId: string) => { dot: Dot; run: DotRun },
  ) {}
  private decode(row: Row): DotIntent {
    let intent: DotIntent;
    try {
      if (
        typeof row.binding !== 'string' ||
        Buffer.byteLength(row.binding, 'utf8') > 1200 * 1024 ||
        (row.receipt !== null &&
          (typeof row.receipt !== 'string' || Buffer.byteLength(row.receipt, 'utf8') > 32 * 1024))
      )
        invalidIntent();
      const prepared = createDotIntent(JSON.parse(row.binding));
      intent = rehydrateDotIntent({
        ...prepared,
        digest: row.digest,
        status: row.status,
        revision: row.revision,
        updatedAt: row.updated_at,
        ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
        ...(row.receipt === null ? {} : { receipt: JSON.parse(row.receipt as string) }),
      });
    } catch {
      invalidIntent();
    }
    if (
      row.id !== intent.id ||
      row.dot_id !== intent.dotId ||
      row.run_id !== intent.runId ||
      row.dot_revision !== intent.dotRevision ||
      row.created_at !== intent.createdAt ||
      row.expires_at !== intent.expiresAt
    )
      invalidIntent();
    const { dot, run } = this.pair(intent.dotId, intent.runId);
    if (
      run.dotId !== dot.id ||
      intent.dotRevision > run.dotRevision ||
      run.startedAt === undefined ||
      intent.continuation.suspendedAt < run.startedAt ||
      intent.createdAt < run.startedAt ||
      (run.status !== 'running' && intent.updatedAt > run.updatedAt)
    )
      invalidIntent();
    if (
      ['pending', 'approved', 'dispatching'].includes(intent.status) &&
      (run.status !== 'running' ||
        dot.inFlightRunId !== run.id ||
        dot.revision !== intent.dotRevision)
    )
      invalidIntent();
    this.eventsFor(intent);
    return intent;
  }
  private eventsFor(intent: DotIntent): readonly DotIntentEvent[] {
    const rows = this.db
      .prepare(
        'SELECT sequence,status,at FROM dot_intent_events WHERE intent_id=? ORDER BY sequence LIMIT 10',
      )
      .all(intent.id);
    if (rows.length !== intent.revision + 1 || rows.length > 8) invalidIntent();
    let previousAt = intent.createdAt;
    const events = rows.map((row, index) => {
      if (
        row.sequence !== index + 1 ||
        typeof row.at !== 'number' ||
        !Number.isSafeInteger(row.at) ||
        row.at < previousAt ||
        typeof row.status !== 'string'
      )
        invalidIntent();
      previousAt = row.at;
      return Object.freeze({
        sequence: index + 1,
        status: row.status as DotIntentStatus,
        at: row.at,
      });
    });
    if (
      events[0]?.status !== 'pending' ||
      events[0]?.at !== intent.createdAt ||
      events.at(-1)?.status !== intent.status ||
      events.at(-1)?.at !== intent.updatedAt
    )
      invalidIntent();
    const allowed: Record<DotIntentStatus, readonly DotIntentStatus[]> = {
      pending: ['approved', 'denied', 'expired', 'stale', 'cancelled'],
      approved: ['dispatching', 'expired', 'stale', 'cancelled'],
      dispatching: ['succeeded', 'unknown'],
      succeeded: [],
      unknown: [],
      denied: [],
      expired: [],
      stale: [],
      cancelled: [],
    };
    for (let index = 1; index < events.length; index++) {
      if (!allowed[events[index - 1].status]?.includes(events[index].status)) invalidIntent();
    }
    return Object.freeze(events);
  }
  get(id: string): DotIntent | undefined {
    const row = this.db.prepare('SELECT * FROM dot_intents WHERE id=?').get(id);
    return row ? this.decode(row) : undefined;
  }
  required(id: string): DotIntent {
    const intent = this.get(id);
    if (!intent) throw new DotRepositoryError('not-found');
    return intent;
  }
  events(id: string): readonly DotIntentEvent[] {
    return this.eventsFor(this.required(id));
  }
  current(runId: string): DotIntent | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM dot_intents WHERE run_id=? AND status IN ('pending','approved','dispatching','unknown')",
      )
      .all(runId);
    if (rows.length > 1) invalidIntent();
    return rows[0] ? this.decode(rows[0]) : undefined;
  }
  history(dotId: string, limit: number, offset: number): readonly DotIntent[] {
    return Object.freeze(
      this.db
        .prepare('SELECT * FROM dot_intents WHERE dot_id=? ORDER BY created_at,id LIMIT ? OFFSET ?')
        .all(dotId, limit, offset)
        .map((row) => this.decode(row)),
    );
  }
  forRun(runId: string): readonly DotIntent[] {
    const rows = this.db
      .prepare('SELECT * FROM dot_intents WHERE run_id=? ORDER BY created_at,id LIMIT 201')
      .all(runId);
    if (rows.length > 200) invalidIntent();
    return Object.freeze(rows.map((row) => this.decode(row)));
  }
  review(id: string): DotIntentReview | undefined {
    const row = this.db.prepare('SELECT * FROM dot_intent_reviews WHERE intent_id=?').get(id);
    if (!row) return;
    let review: DotIntentReview;
    try {
      if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 32 * 1024)
        invalidIntent();
      review = rehydrateDotIntentReview(JSON.parse(row.payload));
      if (createHash('sha256').update(JSON.stringify(review)).digest('hex') !== row.digest)
        invalidIntent();
    } catch {
      invalidIntent();
    }
    const intent = this.required(id);
    const { dot, run } = this.pair(intent.dotId, intent.runId);
    if (
      row.intent_id !== review.intentId ||
      row.dot_id !== review.dotId ||
      row.run_id !== review.runId ||
      row.reviewed_at !== review.reviewedAt ||
      intent.status !== 'unknown' ||
      review.intentId !== intent.id ||
      review.dotId !== intent.dotId ||
      review.runId !== intent.runId ||
      review.intentRevision !== intent.revision ||
      review.intentDigest !== intent.digest ||
      review.dotRevision < run.dotRevision ||
      review.dotRevision >= dot.revision ||
      review.reviewedAt > dot.updatedAt ||
      review.reviewedAt < intent.updatedAt ||
      review.reviewedAt < run.updatedAt ||
      ['pending', 'running'].includes(run.status)
    )
      invalidIntent();
    return review;
  }
  acknowledge(
    id: string,
    revision: number,
    digest: string,
    dotRevision: number,
    note: string,
    at: number,
  ): DotIntentReview {
    const intent = this.match(id, revision, digest);
    const { dot, run } = this.pair(intent.dotId, intent.runId);
    if (dot.revision !== dotRevision + 1 || this.review(id))
      throw new DotRepositoryError('conflict');
    if (
      intent.status !== 'unknown' ||
      dot.inFlightRunId ||
      ['pending', 'running'].includes(run.status) ||
      at < dot.updatedAt
    )
      throw new DotRepositoryError('intent-blocked');
    const review = rehydrateDotIntentReview({
      version: 1,
      acknowledgement: 'accept-uncertainty',
      intentId: id,
      dotId: dot.id,
      runId: run.id,
      intentRevision: revision,
      intentDigest: digest,
      dotRevision,
      reviewedAt: at,
      note,
    });
    if (at < intent.updatedAt || at < run.updatedAt) throw new DotRepositoryError('invalid-intent');
    const payload = JSON.stringify(review);
    this.db
      .prepare(
        'INSERT INTO dot_intent_reviews(intent_id,dot_id,run_id,reviewed_at,digest,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(id, dot.id, run.id, at, createHash('sha256').update(payload).digest('hex'), payload);
    const stored = this.review(id);
    if (!stored) invalidIntent();
    return stored;
  }
  assertNoOpen(dotId: string, at?: number, unknownOnly = false) {
    let cursor = '';
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT id FROM dot_intents WHERE dot_id=? AND id>? AND status IN ('pending','approved','dispatching','unknown') ORDER BY id LIMIT 200",
        )
        .all(dotId, cursor);
      if (!rows.length) return;
      for (const row of rows) {
        const intent = this.required(String(row.id));
        cursor = intent.id;
        if (intent.status === 'unknown') {
          const review = this.review(intent.id);
          if (review && (at === undefined || at >= review.reviewedAt)) continue;
        } else if (unknownOnly) continue;
        throw new DotRepositoryError('intent-blocked');
      }
    }
  }
  create(input: DotIntentInput): DotIntent {
    const intent = createDotIntent(input);
    const { dot, run } = this.pair(intent.dotId, intent.runId);
    if (dot.revision !== intent.dotRevision) throw new DotRepositoryError('conflict');
    if (
      run.status !== 'running' ||
      dot.inFlightRunId !== run.id ||
      intent.createdAt < run.updatedAt ||
      intent.continuation.suspendedAt < run.updatedAt
    )
      throw new DotRepositoryError('invalid-intent');
    this.assertNoOpen(dot.id);
    if (this.get(intent.id)) throw new DotRepositoryError('duplicate-id');
    if (this.current(intent.runId)) throw new DotRepositoryError('intent-blocked');
    this.db
      .prepare(
        'INSERT INTO dot_intents(id,dot_id,run_id,dot_revision,digest,binding,status,revision,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        intent.id,
        intent.dotId,
        intent.runId,
        intent.dotRevision,
        intent.digest,
        JSON.stringify(intentBinding(intent)),
        intent.status,
        intent.revision,
        intent.createdAt,
        intent.expiresAt,
        intent.updatedAt,
      );
    this.append(intent);
    return intent;
  }
  private append(intent: DotIntent) {
    this.db
      .prepare('INSERT INTO dot_intent_events(intent_id,sequence,status,at) VALUES(?,?,?,?)')
      .run(intent.id, intent.revision + 1, intent.status, intent.updatedAt);
  }
  private update(
    previous: DotIntent,
    status: DotIntentStatus,
    at: number,
    receipt?: DotIntentReceipt,
  ): DotIntent {
    if (!Number.isSafeInteger(at) || at < previous.updatedAt)
      throw new DotRepositoryError('invalid-intent');
    const next = rehydrateDotIntent({
      ...previous,
      status,
      revision: previous.revision + 1,
      updatedAt: at,
      ...(status === 'dispatching' ? { dispatchedAt: at } : {}),
      ...(receipt ? { receipt } : {}),
    });
    const result = this.db
      .prepare(
        'UPDATE dot_intents SET status=?,revision=?,updated_at=?,dispatched_at=?,receipt=? WHERE id=? AND status=? AND revision=? AND digest=?',
      )
      .run(
        next.status,
        next.revision,
        next.updatedAt,
        next.dispatchedAt ?? null,
        next.receipt ? JSON.stringify(next.receipt) : null,
        next.id,
        previous.status,
        previous.revision,
        previous.digest,
      );
    if (result.changes !== 1) throw new DotRepositoryError('conflict');
    this.append(next);
    return next;
  }
  private match(id: string, revision: number, digest: string): DotIntent {
    const intent = this.required(id);
    if (intent.revision !== revision || intent.digest !== digest)
      throw new DotRepositoryError('conflict');
    return intent;
  }
  decide(
    id: string,
    revision: number,
    digest: string,
    decision: 'approve' | 'deny',
    at: number,
  ): DotIntent {
    const intent = this.match(id, revision, digest);
    if (
      intent.status !== 'pending' ||
      at >= intent.expiresAt ||
      (decision !== 'approve' && decision !== 'deny')
    )
      throw new DotRepositoryError('intent-blocked');
    return this.update(intent, decision === 'approve' ? 'approved' : 'denied', at);
  }
  invalidate(
    id: string,
    revision: number,
    digest: string,
    reason: 'expired' | 'stale',
    at: number,
  ): DotIntent {
    const intent = this.match(id, revision, digest);
    if (
      !['pending', 'approved'].includes(intent.status) ||
      (reason !== 'expired' && reason !== 'stale') ||
      (reason === 'expired' && at < intent.expiresAt)
    )
      throw new DotRepositoryError('intent-blocked');
    return this.update(intent, reason, at);
  }
  dispatch(id: string, revision: number, digest: string, at: number): DotIntent {
    const intent = this.match(id, revision, digest);
    if (intent.status !== 'approved' || at >= intent.expiresAt)
      throw new DotRepositoryError('intent-blocked');
    return this.update(intent, 'dispatching', at);
  }
  settle(
    id: string,
    revision: number,
    digest: string,
    outcome: { status: 'succeeded'; receipt: DotIntentReceipt } | { status: 'unknown' },
    at: number,
  ): DotIntent {
    const intent = this.match(id, revision, digest);
    if (
      intent.status !== 'dispatching' ||
      (outcome.status !== 'succeeded' && outcome.status !== 'unknown')
    )
      throw new DotRepositoryError('intent-blocked');
    return this.update(
      intent,
      outcome.status,
      at,
      outcome.status === 'succeeded' ? outcome.receipt : undefined,
    );
  }
  cancel(runId: string, at: number): void {
    const intent = this.current(runId);
    if (!intent || !['pending', 'approved'].includes(intent.status))
      throw new DotRepositoryError('intent-blocked');
    this.update(intent, 'cancelled', at);
  }
  /** Validate preserved requests; expire invalid time bounds and classify dispatch gaps, never dispatch. */
  recover(at: number, assertOwner: () => void, limit: number): void {
    let cursor = '';
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT * FROM dot_intents WHERE id>? AND status IN ('pending','approved','dispatching') ORDER BY id LIMIT ?",
        )
        .all(cursor, limit);
      if (!rows.length) return;
      for (const row of rows) {
        const intent = this.decode(row);
        assertOwner();
        cursor = intent.id;
        if (intent.status === 'dispatching')
          this.update(intent, 'unknown', Math.max(at, intent.updatedAt));
        else if (at < intent.updatedAt) this.update(intent, 'stale', intent.updatedAt);
        else if (at >= intent.expiresAt) this.update(intent, 'expired', at);
      }
    }
  }
}
