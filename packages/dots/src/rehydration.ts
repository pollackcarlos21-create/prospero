import { DotError } from './errors';
import type { Dot, DotRun } from './types';
import { assertDot, assertRun, record } from './validation';

/** Stored snapshots contain only their declared, enumerable data fields. */
function assertFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!record(value)) throw new DotError('invalid-input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new DotError('invalid-input');
  const fields = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(fields, key)) ||
    Reflect.ownKeys(fields).some((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const field = fields[key];
      return !field.enumerable || !Object.hasOwn(field, 'value') || field.value === undefined;
    })
  )
    throw new DotError('invalid-input');
}

/** Validate and copy one stored entity, without replaying transitions or checking related rows. */
export function rehydrateDot(value: unknown): Dot {
  assertFields(
    value,
    ['id', 'name', 'goal', 'lifecycle', 'createdAt', 'updatedAt', 'revision'],
    ['inFlightRunId'],
  );
  assertFields(value.goal, ['text']);
  assertDot(value);
  return Object.freeze({
    id: value.id,
    name: value.name,
    goal: Object.freeze({ text: value.goal.text }),
    lifecycle: value.lifecycle,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    ...(value.inFlightRunId === undefined ? {} : { inFlightRunId: value.inFlightRunId }),
  });
}

/** Current-pair ownership and historical consistency remain the repository's responsibility. */
export function rehydrateDotRun(value: unknown): DotRun {
  const required = ['id', 'dotId', 'dotRevision', 'status', 'createdAt', 'updatedAt'];
  assertFields(value, required, ['startedAt', 'finishedAt']);
  switch (value.status) {
    case 'pending':
      assertFields(value, required);
      break;
    case 'running':
      assertFields(value, [...required, 'startedAt']);
      break;
    case 'succeeded':
    case 'failed':
      assertFields(value, [...required, 'startedAt', 'finishedAt']);
      break;
    case 'cancelled':
    case 'interrupted':
      assertFields(value, [...required, 'finishedAt'], ['startedAt']);
      break;
    default:
      throw new DotError('invalid-input');
  }
  assertRun(value);
  const base = {
    id: value.id,
    dotId: value.dotId,
    dotRevision: value.dotRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  switch (value.status) {
    case 'pending':
      return Object.freeze({ ...base, status: value.status });
    case 'running':
      return Object.freeze({ ...base, status: value.status, startedAt: value.startedAt });
    case 'succeeded':
    case 'failed':
      return Object.freeze({
        ...base,
        status: value.status,
        startedAt: value.startedAt,
        finishedAt: value.finishedAt,
      });
    case 'cancelled':
    case 'interrupted':
      return Object.freeze({
        ...base,
        status: value.status,
        ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
        finishedAt: value.finishedAt,
      });
  }
}
