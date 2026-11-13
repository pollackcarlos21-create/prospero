import { DotError } from './errors';

/** A human acknowledgement of uncertainty, never a receipt, retry or permission grant. */
export interface DotIntentReview {
  readonly version: 1;
  readonly acknowledgement: 'accept-uncertainty';
  readonly intentId: string;
  readonly dotId: string;
  readonly runId: string;
  readonly intentRevision: number;
  readonly intentDigest: string;
  readonly dotRevision: number;
  readonly reviewedAt: number;
  readonly note: string;
}
export function rehydrateDotIntentReview(value: unknown): DotIntentReview {
  function invalid(): never {
    throw new DotError('invalid-input');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const names = [
    'version',
    'acknowledgement',
    'intentId',
    'dotId',
    'runId',
    'intentRevision',
    'intentDigest',
    'dotRevision',
    'reviewedAt',
    'note',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== names.length || names.some((name) => !descriptors[name]))
    invalid();
  const raw: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const field = descriptors[name];
    if (!Object.hasOwn(field, 'value') || !field.enumerable) invalid();
    raw[name] = field.value;
  }
  const id = (field: unknown): string => {
    if (typeof field !== 'string' || !field || field.length > 128 || field.includes('\0'))
      invalid();
    return field;
  };
  const integer = (field: unknown): number => {
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) invalid();
    return field;
  };
  if (
    raw.version !== 1 ||
    raw.acknowledgement !== 'accept-uncertainty' ||
    typeof raw.intentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.intentDigest) ||
    typeof raw.note !== 'string' ||
    !raw.note.trim() ||
    raw.note.includes('\0') ||
    new TextEncoder().encode(raw.note).length > 4096
  )
    invalid();
  return Object.freeze({
    version: 1,
    acknowledgement: 'accept-uncertainty',
    intentId: id(raw.intentId),
    dotId: id(raw.dotId),
    runId: id(raw.runId),
    intentRevision: integer(raw.intentRevision),
    intentDigest: raw.intentDigest,
    dotRevision: integer(raw.dotRevision),
    reviewedAt: integer(raw.reviewedAt),
    note: raw.note,
  });
}
