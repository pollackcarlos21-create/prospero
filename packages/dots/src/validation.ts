import { DotError } from './errors';
import { DotLifecycleStatuses, DotRunStatuses, type Dot, type DotRun } from './types';

const lifecycles = new Set<string>(Object.values(DotLifecycleStatuses));
const runStatuses = new Set<string>(Object.values(DotRunStatuses));

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function identity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length <= limit &&
    value.trim().length > 0 &&
    !value.includes('\0')
  );
}

export function assertDot(value: unknown): asserts value is Dot {
  if (value === undefined || value === null) throw new DotError('invalid-reference');
  if (
    !record(value) ||
    !identity(value.id) ||
    !boundedText(value.name, 120) ||
    value.name !== value.name.trim() ||
    !record(value.goal) ||
    !boundedText(value.goal.text, 16_384) ||
    value.goal.text !== value.goal.text.trim() ||
    typeof value.lifecycle !== 'string' ||
    !lifecycles.has(value.lifecycle) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !timestamp(value.revision) ||
    (value.inFlightRunId !== undefined &&
      (!identity(value.inFlightRunId) || value.lifecycle !== 'active'))
  )
    throw new DotError('invalid-input');
}

export function assertRun(value: unknown): asserts value is DotRun {
  if (value === undefined || value === null) throw new DotError('invalid-reference');
  if (
    !record(value) ||
    !identity(value.id) ||
    !identity(value.dotId) ||
    !timestamp(value.dotRevision) ||
    typeof value.status !== 'string' ||
    !runStatuses.has(value.status) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  )
    throw new DotError('invalid-input');

  const started = value.startedAt;
  const finished = value.finishedAt;
  const validStart = timestamp(started) && started >= value.createdAt;
  switch (value.status) {
    case 'pending':
      if (started === undefined && finished === undefined && value.updatedAt === value.createdAt)
        return;
      break;
    case 'running':
      if (validStart && finished === undefined && value.updatedAt === started) return;
      break;
    default:
      if (
        timestamp(finished) &&
        value.updatedAt === finished &&
        finished >= value.createdAt &&
        (validStart
          ? finished >= started
          : started === undefined && ['cancelled', 'interrupted'].includes(value.status))
      )
        return;
  }
  throw new DotError('invalid-input');
}

export function assertTime(at: unknown, previous: number): asserts at is number {
  if (!timestamp(at) || at < previous) throw new DotError('invalid-input');
}
