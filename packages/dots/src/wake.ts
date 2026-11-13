import { DotError } from './errors';
export interface DotWakeInput {
  readonly id: string;
  readonly dotId: string;
  readonly policyId: string;
  readonly createdAt: number;
  readonly dueAt: number;
}
export type DotWakeReason = 'user' | 'state' | 'policy' | 'configuration' | 'budget' | 'unknown';
export interface DotWake extends DotWakeInput {
  readonly version: 1;
  readonly status: 'scheduled' | 'claimed' | 'cancelled' | 'blocked';
  readonly revision: number;
  readonly updatedAt: number;
  readonly runId?: string;
  readonly reason?: DotWakeReason;
}
function invalid(): never {
  throw new DotError('invalid-input');
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== Object.keys(fields).length ||
    required.some((key) => !fields[key])
  )
    invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(fields)) {
    if (
      (!required.includes(key) && !optional.includes(key)) ||
      !Object.hasOwn(field, 'value') ||
      !field.enumerable
    )
      invalid();
    out[key] = field.value;
  }
  return out;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0')) invalid();
  return value;
}
function at(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
const names = ['id', 'dotId', 'policyId', 'createdAt', 'dueAt'] as const;
function input(value: unknown): DotWakeInput {
  const raw = object(value, names);
  const createdAt = at(raw.createdAt);
  const dueAt = at(raw.dueAt);
  if (dueAt <= createdAt || dueAt - createdAt > 7 * 86400000) invalid();
  return Object.freeze({
    id: id(raw.id),
    dotId: id(raw.dotId),
    policyId: id(raw.policyId),
    createdAt,
    dueAt,
  });
}
export function createDotWake(value: DotWakeInput): DotWake {
  const parsed = input(value);
  return Object.freeze({
    version: 1,
    ...parsed,
    status: 'scheduled',
    revision: 0,
    updatedAt: parsed.createdAt,
  });
}
export function rehydrateDotWake(value: unknown): DotWake {
  const raw = object(
    value,
    ['version', ...names, 'status', 'revision', 'updatedAt'],
    ['runId', 'reason'],
  );
  const parsed = input(Object.fromEntries(names.map((name) => [name, raw[name]])));
  const updatedAt = at(raw.updatedAt);
  const revision = at(raw.revision);
  if (raw.version !== 1 || updatedAt < parsed.createdAt) invalid();
  if (raw.status === 'scheduled') {
    if (
      revision !== 0 ||
      updatedAt !== parsed.createdAt ||
      raw.runId !== undefined ||
      raw.reason !== undefined
    )
      invalid();
    return Object.freeze({ version: 1, ...parsed, status: raw.status, revision, updatedAt });
  }
  if (revision !== 1) invalid();
  if (raw.status === 'claimed') {
    if (updatedAt < parsed.dueAt || raw.reason !== undefined) invalid();
    return Object.freeze({
      version: 1,
      ...parsed,
      status: raw.status,
      revision,
      updatedAt,
      runId: id(raw.runId),
    });
  }
  if (
    (raw.status !== 'cancelled' && raw.status !== 'blocked') ||
    raw.runId !== undefined ||
    typeof raw.reason !== 'string' ||
    !['user', 'state', 'policy', 'configuration', 'budget', 'unknown'].includes(raw.reason)
  )
    invalid();
  return Object.freeze({
    version: 1,
    ...parsed,
    status: raw.status,
    revision,
    updatedAt,
    reason: raw.reason as DotWakeReason,
  });
}
