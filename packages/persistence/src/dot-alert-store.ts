import type { DatabaseSync } from 'node:sqlite';
import type { Dot } from '@prospero/dots';
import { DotRepositoryError } from './dot-errors';
import type { DotIntentStore } from './dot-intent-store';
import type { DotIntent } from './dot-intent';
export interface DotSupervisionEntry {
  readonly dotId: string;
  readonly runId: string;
  readonly intentId: string;
  readonly intentRevision: number;
  readonly intentDigest: string;
  readonly kind: 'approval' | 'uncertain';
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface DotAlertClaim {
  readonly dotId: string;
  readonly intentId: string;
  readonly kind: DotSupervisionEntry['kind'];
  readonly intentRevision: number;
  readonly intentDigest: string;
  readonly claimedAt: number;
}
function invalid(): never {
  throw new DotRepositoryError('invalid-stored-state');
}
/** Alert attempts are observational facts, never delivery receipts or permission grants. */
export class DotAlertStore {
  constructor(
    private db: DatabaseSync,
    private intents: DotIntentStore,
    private dot: (id: string) => Dot,
  ) {}
  private entry(intent: DotIntent): DotSupervisionEntry | undefined {
    if (this.dot(intent.dotId).lifecycle !== 'active') return;
    let kind: DotSupervisionEntry['kind'];
    if (intent.status === 'unknown') {
      if (this.intents.review(intent.id)) return;
      kind = 'uncertain';
    } else if (intent.status === 'pending' || intent.status === 'approved') kind = 'approval';
    else return;
    return Object.freeze({
      dotId: intent.dotId,
      runId: intent.runId,
      intentId: intent.id,
      intentRevision: intent.revision,
      intentDigest: intent.digest,
      kind,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    });
  }
  page(after: string, limit: number) {
    const rows = this.db
      .prepare(
        "SELECT i.id FROM dot_intents i JOIN dots d ON d.id=i.dot_id WHERE i.id>? AND i.status IN ('pending','approved','unknown') AND d.lifecycle='active' ORDER BY i.id LIMIT ?",
      )
      .all(after, limit);
    const items = rows.flatMap((row) => {
      const entry = this.entry(this.intents.required(String(row.id)));
      return entry ? [entry] : [];
    });
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: rows.length === limit ? String(rows.at(-1)?.id) : undefined,
    });
  }
  get(id: string, kind: DotSupervisionEntry['kind']): DotAlertClaim | undefined {
    const row = this.db
      .prepare('SELECT * FROM dot_alert_claims WHERE intent_id=? AND kind=?')
      .get(id, kind);
    if (!row) return;
    const intent = this.intents.required(id);
    const event = this.intents
      .events(id)
      .find((event) => event.sequence === Number(row.intent_revision) + 1);
    if (
      row.dot_id !== intent.dotId ||
      row.intent_digest !== intent.digest ||
      typeof row.claimed_at !== 'number' ||
      !Number.isSafeInteger(row.claimed_at) ||
      !event ||
      row.claimed_at < event.at ||
      (kind === 'approval'
        ? !['pending', 'approved'].includes(event.status)
        : event.status !== 'unknown')
    )
      invalid();
    return Object.freeze({
      dotId: intent.dotId,
      intentId: id,
      kind,
      intentRevision: Number(row.intent_revision),
      intentDigest: intent.digest,
      claimedAt: row.claimed_at,
    });
  }
  claim(entries: readonly DotSupervisionEntry[], at: number): readonly DotSupervisionEntry[] {
    const claimed: DotSupervisionEntry[] = [];
    for (const expected of entries) {
      if (expected.kind !== 'approval' && expected.kind !== 'uncertain')
        throw new DotRepositoryError('invalid-intent');
      if (this.get(expected.intentId, expected.kind)) continue;
      const current = this.entry(this.intents.required(expected.intentId));
      if (
        !current ||
        current.dotId !== expected.dotId ||
        current.runId !== expected.runId ||
        current.kind !== expected.kind ||
        current.intentRevision !== expected.intentRevision ||
        current.intentDigest !== expected.intentDigest ||
        at < current.updatedAt
      )
        continue;
      this.db
        .prepare(
          'INSERT INTO dot_alert_claims(intent_id,dot_id,kind,intent_revision,intent_digest,claimed_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          current.intentId,
          current.dotId,
          current.kind,
          current.intentRevision,
          current.intentDigest,
          at,
        );
      if (!this.get(current.intentId, current.kind)) invalid();
      claimed.push(current);
    }
    return Object.freeze(claimed);
  }
}
