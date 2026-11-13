import { DotError } from './errors';
import type { DotId, DotRun, DotRunId } from './types';
import { assertRun, identity, timestamp } from './validation';

export interface DotCheckpointInput {
  readonly summary: string;
  readonly completed: readonly string[];
  readonly next: readonly string[];
}
export interface DotCheckpoint extends DotCheckpointInput {
  readonly dotId: DotId;
  readonly runId: DotRunId;
  readonly revision: number;
  readonly updatedAt: number;
}

function fields(
  value: unknown,
  names: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DotError('invalid-input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new DotError('invalid-input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== names.length ||
    names.some((name) => {
      const field = descriptors[name];
      return !field?.enumerable || !Object.hasOwn(field, 'value');
    })
  )
    throw new DotError('invalid-input');
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  )
    throw new DotError('invalid-input');
  return value;
}
function notes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 20 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new DotError('invalid-input');
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new DotError('invalid-input');
    result.push(text(field.value, 1024));
  }
  return Object.freeze(result);
}

export function rehydrateDotCheckpointInput(value: unknown): DotCheckpointInput {
  fields(value, ['summary', 'completed', 'next']);
  const input = Object.freeze({
    summary: text(value.summary, 16384),
    completed: notes(value.completed),
    next: notes(value.next),
  });
  // Reserve room for host-owned identity/revision/time in the final 64 KiB record.
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 60 * 1024)
    throw new DotError('invalid-input');
  return input;
}

/** A bounded continuation record, never executable instructions or a restored permission. */
export function rehydrateDotCheckpoint(value: unknown): DotCheckpoint {
  fields(value, ['dotId', 'runId', 'revision', 'updatedAt', 'summary', 'completed', 'next']);
  if (
    !identity(value.dotId) ||
    !identity(value.runId) ||
    !timestamp(value.revision) ||
    value.revision < 1 ||
    !timestamp(value.updatedAt)
  )
    throw new DotError('invalid-input');
  const checkpoint = Object.freeze({
    dotId: value.dotId as DotId,
    runId: value.runId as DotRunId,
    revision: value.revision,
    updatedAt: value.updatedAt,
    summary: text(value.summary, 16384),
    completed: notes(value.completed),
    next: notes(value.next),
  });
  if (new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength > 64 * 1024)
    throw new DotError('invalid-input');
  return checkpoint;
}

export function createDotCheckpoint(
  run: DotRun,
  previous: DotCheckpoint | undefined,
  input: DotCheckpointInput,
): DotCheckpoint {
  assertRun(run);
  if (run.status !== 'succeeded') throw new DotError('invalid-transition');
  input = rehydrateDotCheckpointInput(input);
  if (previous) {
    previous = rehydrateDotCheckpoint(previous);
    if (previous.dotId !== run.dotId || previous.runId === run.id)
      throw new DotError('invalid-reference');
    if (previous.updatedAt > run.updatedAt) throw new DotError('invalid-input');
  }
  return rehydrateDotCheckpoint({
    dotId: run.dotId,
    runId: run.id,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: run.updatedAt,
    summary: input.summary,
    completed: input.completed,
    next: input.next,
  });
}
