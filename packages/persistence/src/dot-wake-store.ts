import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createDotWake,
  rehydrateDotWake,
  type DotWake,
  type DotWakeInput,
  type DotWakeReason,
  type Dot,
  type DotRun,
} from '@prospero/dots';
import { DotRepositoryError } from './dot-errors';
import type { DotPolicyStore } from './dot-policy-store';
import type { DotIntentProvider } from './dot-intent';

function corrupt(): never {
  throw new DotRepositoryError('invalid-stored-state');
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding = (wake: DotWake): DotWakeInput => ({
  id: wake.id,
  dotId: wake.dotId,
  policyId: wake.policyId,
  createdAt: wake.createdAt,
  dueAt: wake.dueAt,
});

/** Internal store. Every mutation runs inside its repository transaction. */
export class DotWakeStore {
  constructor(
    private db: DatabaseSync,
    private dot: (id: string) => Dot,
    private run: (id: string) => DotRun,
    private policies: DotPolicyStore,
  ) {}
  get(id: string): DotWake | undefined {
    const row = this.db.prepare('SELECT * FROM dot_wakes WHERE id=?').get(id);
    if (!row) return;
    let wake: DotWake;
    try {
      if (typeof row.binding !== 'string' || Buffer.byteLength(row.binding, 'utf8') > 2048)
        corrupt();
      const initial = createDotWake(JSON.parse(row.binding));
      if (hash(binding(initial)) !== row.digest) corrupt();
      wake = rehydrateDotWake({
        ...initial,
        status: row.status,
        revision: row.revision,
        updatedAt: row.updated_at,
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        ...(row.reason === null ? {} : { reason: row.reason }),
      });
    } catch {
      corrupt();
    }
    if (
      row.id !== wake.id ||
      row.dot_id !== wake.dotId ||
      row.policy_id !== wake.policyId ||
      row.created_at !== wake.createdAt ||
      row.due_at !== wake.dueAt
    )
      corrupt();
    const dot = this.dot(wake.dotId);
    const p = this.policies.required(wake.policyId).policy;
    if (
      wake.createdAt < dot.createdAt ||
      p.dotId !== dot.id ||
      wake.createdAt < p.createdAt ||
      wake.dueAt >= p.expiresAt
    )
      corrupt();
    if (wake.status === 'claimed') {
      if (!wake.runId) corrupt();
      const run = this.run(wake.runId);
      if (
        run.dotId !== dot.id ||
        run.createdAt !== wake.updatedAt ||
        this.db
          .prepare("SELECT policy_id FROM dot_policy_usage WHERE run_id=? AND kind='run'")
          .get(run.id)?.policy_id !== wake.policyId
      )
        corrupt();
    }
    const events = this.db
      .prepare('SELECT * FROM dot_wake_events WHERE wake_id=? ORDER BY sequence LIMIT 3')
      .all(id);
    if (
      events.length !== wake.revision + 1 ||
      events[0]?.sequence !== 1 ||
      events[0]?.status !== 'scheduled' ||
      events[0]?.at !== wake.createdAt ||
      events[0]?.run_id !== null ||
      events[0]?.reason !== null
    )
      corrupt();
    if (
      wake.revision === 1 &&
      (events[1]?.sequence !== 2 ||
        events[1]?.status !== wake.status ||
        events[1]?.at !== wake.updatedAt ||
        events[1]?.run_id !== (wake.runId ?? null) ||
        events[1]?.reason !== (wake.reason ?? null))
    )
      corrupt();
    return wake;
  }
  required(id: string): DotWake {
    const wake = this.get(id);
    if (!wake) throw new DotRepositoryError('not-found');
    return wake;
  }
  history(dotId: string, limit = 20): readonly DotWake[] {
    return Object.freeze(
      this.db
        .prepare(
          "SELECT id FROM dot_wakes WHERE dot_id=? ORDER BY (status='scheduled') DESC,created_at DESC,id DESC LIMIT ?",
        )
        .all(dotId, limit)
        .map((row) => this.required(String(row.id))),
    );
  }
  create(
    input: DotWakeInput,
    revision: number,
    provider: DotIntentProvider,
    configurationRevision: number,
  ): DotWake {
    const wake = createDotWake(input);
    const dot = this.dot(wake.dotId);
    if (dot.revision !== revision) throw new DotRepositoryError('conflict');
    const p = this.policies.required(wake.policyId).policy;
    if (
      p.dotId !== dot.id ||
      dot.lifecycle !== 'active' ||
      wake.createdAt < dot.updatedAt ||
      wake.dueAt >= p.expiresAt ||
      this.policies.nextRunBlock(p.id, provider, configurationRevision, wake.createdAt)
    )
      throw new DotRepositoryError('wake-blocked');
    if (this.db.prepare('SELECT id FROM dot_wakes WHERE id=?').get(wake.id))
      throw new DotRepositoryError('duplicate-id');
    if (
      this.db.prepare("SELECT id FROM dot_wakes WHERE dot_id=? AND status='scheduled'").get(dot.id)
    )
      throw new DotRepositoryError('conflict');
    this.db
      .prepare(
        'INSERT INTO dot_wakes(id,dot_id,policy_id,binding,digest,created_at,due_at,updated_at,status,revision) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        wake.id,
        wake.dotId,
        wake.policyId,
        JSON.stringify(binding(wake)),
        hash(binding(wake)),
        wake.createdAt,
        wake.dueAt,
        wake.updatedAt,
        wake.status,
        wake.revision,
      );
    this.db
      .prepare("INSERT INTO dot_wake_events(wake_id,sequence,status,at) VALUES(?,1,'scheduled',?)")
      .run(wake.id, wake.createdAt);
    return this.required(wake.id);
  }
  settle(
    wake: DotWake,
    status: 'claimed' | 'cancelled' | 'blocked',
    at: number,
    details: { runId: string } | { reason: DotWakeReason },
  ): DotWake {
    if (wake.status !== 'scheduled') throw new DotRepositoryError('conflict');
    const next = rehydrateDotWake({
      ...binding(wake),
      version: 1,
      status,
      revision: 1,
      updatedAt: at,
      ...details,
    });
    const result = this.db
      .prepare(
        "UPDATE dot_wakes SET status=?,revision=1,updated_at=?,run_id=?,reason=? WHERE id=? AND status='scheduled' AND revision=0",
      )
      .run(next.status, next.updatedAt, next.runId ?? null, next.reason ?? null, next.id);
    if (result.changes !== 1) throw new DotRepositoryError('conflict');
    this.db
      .prepare(
        'INSERT INTO dot_wake_events(wake_id,sequence,status,at,reason,run_id) VALUES(?,2,?,?,?,?)',
      )
      .run(next.id, next.status, next.updatedAt, next.reason ?? null, next.runId ?? null);
    return this.required(next.id);
  }
  cancelDot(dotId: string, at: number, reason: DotWakeReason = 'user') {
    const row = this.db
      .prepare("SELECT id FROM dot_wakes WHERE dot_id=? AND status='scheduled'")
      .get(dotId);
    if (row) {
      const wake = this.required(String(row.id));
      this.settle(wake, 'cancelled', Math.max(at, wake.updatedAt), { reason });
    }
  }
  invalidatePolicy(policyId: string, at: number) {
    const row = this.db
      .prepare("SELECT id FROM dot_wakes WHERE policy_id=? AND status='scheduled'")
      .get(policyId);
    if (row) {
      const wake = this.required(String(row.id));
      this.settle(wake, 'blocked', Math.max(at, wake.updatedAt), { reason: 'policy' });
    }
  }
  invalidateUnavailable(at: number) {
    const rows = this.db.prepare("SELECT id FROM dot_wakes WHERE status='scheduled'").all();
    for (const row of rows) {
      const wake = this.required(String(row.id));
      const dot = this.dot(wake.dotId);
      const p = this.policies.required(wake.policyId).policy;
      if (dot.lifecycle !== 'active')
        this.settle(wake, 'cancelled', Math.max(at, wake.updatedAt), { reason: 'state' });
      else if (p.status !== 'active' || at >= p.expiresAt)
        this.settle(wake, 'blocked', Math.max(at, wake.updatedAt), { reason: 'policy' });
    }
  }
  due(at: number, limit: number): readonly DotWake[] {
    return Object.freeze(
      this.db
        .prepare(
          "SELECT w.id FROM dot_wakes w JOIN dots d ON d.id=w.dot_id WHERE w.status='scheduled' AND w.due_at<=? AND d.updated_at<=? AND d.lifecycle='active' AND d.in_flight_run_id IS NULL ORDER BY w.due_at,w.id LIMIT ?",
        )
        .all(at, at, limit)
        .map((row) => this.required(String(row.id))),
    );
  }
  nextAt(): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(MAX(w.due_at,d.updated_at)) AS next FROM dot_wakes w JOIN dots d ON d.id=w.dot_id WHERE w.status='scheduled' AND d.lifecycle='active' AND d.in_flight_run_id IS NULL",
      )
      .get();
    if (row?.next === null || row?.next === undefined) return;
    if (typeof row.next !== 'number' || !Number.isSafeInteger(row.next) || row.next < 0) corrupt();
    return row.next;
  }
}
