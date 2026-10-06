import type {
  ActionJournalEntry,
  ActionJournalPort,
  ActionPlan,
  ActionStatus,
  PlanStatus,
} from '@prospero/core';
import type { DatabaseSync } from 'node:sqlite';

interface PlanRow {
  id: string;
  conversation_id: string;
  execution_id: string;
  payload: string;
  status: PlanStatus;
}

export interface StoredActionPlan {
  plan: ActionPlan;
  status: PlanStatus;
  journal: ActionJournalEntry[];
  executionId: string;
}

const terminal = new Set<ActionStatus>([
  'succeeded',
  'failed',
  'stale',
  'denied',
  'cancelled',
  'skipped',
  'interrupted',
]);
const effects = new Set([
  'file.read',
  'file.write',
  'file.remove',
  'process.execute',
  'network.search',
  'network.fetch',
  'native.reveal',
  'native.clipboard',
]);
const actionKinds = new Set([
  'copy_file',
  'move_file',
  'rename_file',
  'create_directory',
  'write_text',
  'trash_file',
  'reveal_in_finder',
  'copy_path',
]);

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function text(value: unknown, limit = 4096): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
  );
}

function validatePlan(plan: ActionPlan): string {
  if (
    !plan ||
    !text(plan.id, 300) ||
    !text(plan.digest, 300) ||
    !text(plan.title, 1000) ||
    !Number.isSafeInteger(plan.createdAt) ||
    plan.createdAt < 0 ||
    !Array.isArray(plan.scopeIds) ||
    !plan.scopeIds.length ||
    plan.scopeIds.length > 100 ||
    !plan.scopeIds.every((scope) => text(scope, 300)) ||
    new Set(plan.scopeIds).size !== plan.scopeIds.length ||
    !Array.isArray(plan.actions) ||
    !plan.actions.length ||
    plan.actions.length > 100
  )
    throw new Error('Action Plan is invalid.');
  const ids = new Set<string>();
  for (const action of plan.actions) {
    if (
      !action ||
      !text(action.id, 300) ||
      ids.has(action.id) ||
      !actionKinds.has(action.kind) ||
      !text(action.target) ||
      (action.source !== undefined && !text(action.source)) ||
      !Array.isArray(action.effects) ||
      !action.effects.length ||
      !action.effects.every(
        (effect: unknown) => typeof effect === 'string' && effects.has(effect),
      ) ||
      new Set(action.effects).size !== action.effects.length ||
      (action.bytes !== undefined && (!Number.isSafeInteger(action.bytes) || action.bytes < 0)) ||
      (action.beforeHash !== undefined && !text(action.beforeHash, 300)) ||
      (action.afterHash !== undefined && !text(action.afterHash, 300)) ||
      (action.diff !== undefined &&
        (typeof action.diff !== 'string' || action.diff.length > 2_000_000))
    )
      throw new Error('Action Plan contains an invalid action.');
    ids.add(action.id);
  }
  const payload = JSON.stringify(plan);
  if (Buffer.byteLength(payload) > 8_000_000)
    throw new Error('Action Plan exceeds the storage limit.');
  return payload;
}

function readPlan(db: DatabaseSync, id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM action_plans WHERE id=?').get(id) as unknown as
    | PlanRow
    | undefined;
}

function journalEntries(db: DatabaseSync, planId: string): ActionJournalEntry[] {
  return db
    .prepare('SELECT * FROM action_journal WHERE plan_id=? ORDER BY sequence')
    .all(planId)
    .map((row) => ({
      planId: row.plan_id as string,
      actionId: row.action_id as string,
      sequence: row.sequence as number,
      status: row.status as ActionStatus,
      at: row.at as number,
      ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    }));
}

function append(
  db: DatabaseSync,
  planId: string,
  actionId: string,
  status: ActionStatus,
  detail?: string,
): void {
  if (
    detail !== undefined &&
    (typeof detail !== 'string' || detail.length > 2000 || detail.includes('\0'))
  )
    throw new Error('Action journal detail is invalid.');
  db.prepare(
    'INSERT INTO action_journal(plan_id,action_id,sequence,status,at,detail) SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,? FROM action_journal WHERE plan_id=?',
  ).run(planId, actionId, status, Date.now(), detail ?? null, planId);
}

function latestStatuses(db: DatabaseSync, plan: ActionPlan): Map<string, ActionStatus> {
  const entries = journalEntries(db, plan.id);
  const latest = new Map<string, ActionStatus>();
  for (const entry of entries) latest.set(entry.actionId, entry.status);
  if (plan.actions.some((action) => !latest.has(action.id)))
    throw new Error('Action journal is incomplete.');
  return latest;
}

/** Durable state transitions are synchronous: a failed commit cannot authorize an effect. */
export function createActionJournal(
  db: DatabaseSync,
  conversationId: string,
  executionId: string,
): ActionJournalPort {
  if (!text(conversationId, 300) || !text(executionId, 300))
    throw new Error('Action journal ownership is invalid.');
  const ownPlan = (id: string) => {
    const row = readPlan(db, id);
    if (!row || row.conversation_id !== conversationId || row.execution_id !== executionId)
      throw new Error('Action Plan does not belong to this execution.');
    return row;
  };
  return {
    prepare(plan) {
      const payload = validatePlan(plan);
      transaction(db, () => {
        const existing = readPlan(db, plan.id);
        if (existing) {
          if (
            existing.conversation_id !== conversationId ||
            existing.execution_id !== executionId ||
            existing.payload !== payload
          )
            throw new Error('Action Plan is immutable.');
          if (existing.status !== 'prepared')
            throw new Error('Action Plan has already been decided.');
          return;
        }
        db.prepare(
          'INSERT INTO action_plans(id,conversation_id,execution_id,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        ).run(
          plan.id,
          conversationId,
          executionId,
          payload,
          'prepared',
          plan.createdAt,
          Date.now(),
        );
        for (const action of plan.actions) append(db, plan.id, action.id, 'prepared');
      });
    },
    decision(planId, decision) {
      transaction(db, () => {
        const row = ownPlan(planId);
        if (row.status !== 'prepared' && !(decision === 'deny' && row.status === 'approved'))
          throw new Error('Action Plan is no longer awaiting approval.');
        const plan = JSON.parse(row.payload) as ActionPlan;
        if ([...latestStatuses(db, plan).values()].some((status) => status !== 'prepared'))
          throw new Error('Action Plan is no longer awaiting approval.');
        if (decision !== 'allow-once' && decision !== 'deny')
          throw new Error('Action Plan decision is invalid.');
        if (decision === 'deny')
          for (const action of plan.actions) append(db, plan.id, action.id, 'denied');
        db.prepare('UPDATE action_plans SET status=?,updated_at=? WHERE id=?').run(
          decision === 'deny' ? 'denied' : 'approved',
          Date.now(),
          plan.id,
        );
      });
    },
    transition(planId, actionId, status, detail) {
      transaction(db, () => {
        const row = ownPlan(planId);
        if (row.status !== 'prepared' && row.status !== 'approved')
          throw new Error('Action Plan is terminal.');
        const plan = JSON.parse(row.payload) as ActionPlan;
        const index = plan.actions.findIndex((action) => action.id === actionId);
        if (index < 0) throw new Error('Action does not belong to this plan.');
        const latest = latestStatuses(db, plan);
        const prior = latest.get(actionId);
        if (prior === undefined || terminal.has(prior)) throw new Error('Action is terminal.');
        const legal =
          prior === 'prepared'
            ? ['running', 'failed', 'stale', 'cancelled', 'skipped', 'interrupted'].includes(status)
            : ['succeeded', 'failed', 'stale', 'cancelled', 'interrupted'].includes(status);
        if (!legal) throw new Error('Action journal transition is invalid.');
        if (
          status === 'running' &&
          (row.status !== 'approved' ||
            plan.actions.slice(0, index).some((action) => latest.get(action.id) !== 'succeeded') ||
            [...latest.values()].some((value) => value === 'running'))
        )
          throw new Error('Action cannot execute without approval and completed dependencies.');
        append(db, plan.id, actionId, status, detail);
        db.prepare('UPDATE action_plans SET updated_at=? WHERE id=?').run(Date.now(), plan.id);
      });
    },
    finish(planId, status) {
      transaction(db, () => {
        const row = ownPlan(planId);
        const states = [...latestStatuses(db, JSON.parse(row.payload) as ActionPlan).values()];
        const allTerminal = states.every((state) => terminal.has(state));
        const succeeded = states.some((state) => state === 'succeeded');
        const partialEffect = journalEntries(db, planId).some((entry) =>
          /^partial_effect(?::|$)/.test(entry.detail ?? ''),
        );
        const legal =
          allTerminal &&
          (status === 'completed'
            ? states.every((state) => state === 'succeeded')
            : status === 'partial'
              ? (succeeded || partialEffect) && states.some((state) => state !== 'succeeded')
              : status === 'denied'
                ? states.every((state) => state === 'denied')
                : ['failed', 'stale', 'cancelled', 'interrupted'].includes(status) &&
                  !succeeded &&
                  !partialEffect &&
                  states.some((state) => state === status));
        if (!legal) throw new Error('Action Plan outcome does not match its durable journal.');
        if (row.status !== 'prepared' && row.status !== 'approved') {
          if (row.status === status) return;
          throw new Error('Action Plan is terminal.');
        }
        db.prepare('UPDATE action_plans SET status=?,updated_at=? WHERE id=?').run(
          status,
          Date.now(),
          planId,
        );
      });
    },
    entries(planId) {
      ownPlan(planId);
      return journalEntries(db, planId);
    },
  };
}

export function readActionPlans(db: DatabaseSync, conversationId: string): StoredActionPlan[] {
  return db
    .prepare('SELECT * FROM action_plans WHERE conversation_id=? ORDER BY created_at,rowid')
    .all(conversationId)
    .map((row) => ({
      plan: JSON.parse(row.payload as string) as ActionPlan,
      status: row.status as PlanStatus,
      journal: journalEntries(db, row.id as string),
      executionId: row.execution_id as string,
    }));
}

/** Restart preserves known effects and marks unknown/incomplete effects; it never retains grants. */
export function recoverActionPlans(db: DatabaseSync): number {
  return transaction(db, () => {
    const pending = db
      .prepare("SELECT * FROM action_plans WHERE status IN ('prepared','approved')")
      .all();
    for (const row of pending) {
      const plan = JSON.parse(row.payload as string) as ActionPlan;
      const latest = latestStatuses(db, plan);
      for (const action of plan.actions) {
        const status = latest.get(action.id);
        if (status === 'prepared' || status === 'running')
          append(
            db,
            plan.id,
            action.id,
            'interrupted',
            status === 'running'
              ? 'Application restarted. The effect may have occurred; inspect the affected file before retrying.'
              : 'Application restarted before this action ran. Approval was not retained.',
          );
      }
      db.prepare('UPDATE action_plans SET status=?,updated_at=? WHERE id=?').run(
        'interrupted',
        Date.now(),
        plan.id,
      );
    }
    return pending.length;
  });
}
