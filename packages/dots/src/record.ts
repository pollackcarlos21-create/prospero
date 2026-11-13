import { DotError } from './errors';
import { identity, timestamp } from './validation';

export type DotCheckpointSection = 'summary' | 'completed' | 'next';
export type DotRequestSection = 'query' | 'url' | 'receipt' | 'review' | 'sources';
interface RecordPage {
  readonly runId: string;
  readonly item?: number;
  /** Unicode code-point offset, not a UTF-16 code-unit or byte offset. */
  readonly offset?: number;
  readonly version?: string;
}
export type DotRecordQuery = RecordPage &
  (
    | { readonly kind: 'checkpoint'; readonly section: DotCheckpointSection }
    | { readonly kind: 'request'; readonly intentId: string; readonly section: DotRequestSection }
  );

export function rehydrateDotRecordQuery(value: unknown): DotRecordQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new DotError('invalid-input');
  const input: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !['kind', 'runId', 'intentId', 'section', 'item', 'offset', 'version'].includes(key) ||
      !field?.enumerable ||
      !Object.hasOwn(field, 'value')
    )
      throw new DotError('invalid-input');
    input[key] = field.value;
  }
  const item = input.item === undefined ? 0 : input.item;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (
    !identity(input.runId) ||
    !timestamp(item) ||
    item > 50 ||
    !timestamp(offset) ||
    offset > 65536 ||
    (input.version !== undefined &&
      (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version))) ||
    (offset > 0 && input.version === undefined)
  )
    throw new DotError('invalid-input');
  const page = { runId: input.runId, item, offset, version: input.version as string | undefined };
  if (
    input.kind === 'checkpoint' &&
    !Object.hasOwn(input, 'intentId') &&
    (input.section === 'summary' || input.section === 'completed' || input.section === 'next') &&
    (input.section !== 'summary' || item === 0)
  )
    return Object.freeze({ ...page, kind: 'checkpoint', section: input.section });
  if (
    input.kind === 'request' &&
    identity(input.intentId) &&
    (input.section === 'query' ||
      input.section === 'url' ||
      input.section === 'receipt' ||
      input.section === 'review' ||
      input.section === 'sources') &&
    (input.section === 'sources' ? offset === 0 : item === 0)
  )
    return Object.freeze({
      ...page,
      kind: 'request',
      intentId: input.intentId,
      section: input.section,
    });
  throw new DotError('invalid-input');
}
