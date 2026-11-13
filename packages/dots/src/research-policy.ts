import { DotError } from './errors';
export interface DotResearchPolicyInput {
  readonly id: string;
  readonly dotId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly provider: { readonly id: string; readonly baseUrl: string; readonly model: string };
  readonly configurationRevision: number;
  readonly queries: readonly { readonly query: string; readonly maxResults: number }[];
  readonly allowDiscoveredPages: boolean;
  readonly limits: {
    readonly maxRuns: number;
    readonly maxSearches: number;
    readonly maxFetches: number;
    readonly maxResponseBytes: number;
    readonly maxModelTurns: number;
    readonly maxModelRequestBytes: number;
  };
}
export interface DotResearchPolicy extends DotResearchPolicyInput {
  readonly version: 1;
  readonly revision: number;
  readonly status: 'active' | 'revoked';
  readonly updatedAt: number;
}
export interface DotPolicyUsage {
  readonly runs: number;
  readonly searches: number;
  readonly fetches: number;
  /** Conservative reservations: no automatic refunds after crash/cancel/unused turns. */
  readonly reservedResponseBytes: number;
  readonly reservedModelTurns: number;
  readonly reservedModelRequestBytes: number;
}
function invalid(): never {
  throw new DotError('invalid-input');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    Object.keys(descriptors).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) invalid();
    result[key] = field.value;
  }
  return result;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    [...value].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127)
  )
    invalid();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid();
  return value;
}
const fields = [
  'id',
  'dotId',
  'createdAt',
  'expiresAt',
  'provider',
  'configurationRevision',
  'queries',
  'allowDiscoveredPages',
  'limits',
] as const;
function input(value: unknown): DotResearchPolicyInput {
  const raw = record(value, fields);
  const provider = record(raw.provider, ['id', 'baseUrl', 'model']);
  const limits = record(raw.limits, [
    'maxRuns',
    'maxSearches',
    'maxFetches',
    'maxResponseBytes',
    'maxModelTurns',
    'maxModelRequestBytes',
  ]);
  if (
    !Array.isArray(raw.queries) ||
    Object.getPrototypeOf(raw.queries) !== Array.prototype ||
    raw.queries.length < 1 ||
    raw.queries.length > 10 ||
    Reflect.ownKeys(raw.queries).length !== raw.queries.length + 1
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw.queries);
  const queries = Object.freeze(
    Array.from({ length: raw.queries.length }, (_, index) => {
      const field = descriptors[String(index)];
      if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) invalid();
      const query = record(field.value, ['query', 'maxResults']);
      return Object.freeze({
        query: text(query.query, 600),
        maxResults: integer(query.maxResults, 5, 1),
      });
    }),
  );
  if (
    new Set(queries.map((entry) => entry.query)).size !== queries.length ||
    queries.some((entry) => entry.query.split(/\s+/).length > 75) ||
    typeof raw.allowDiscoveredPages !== 'boolean'
  )
    invalid();
  const createdAt = integer(raw.createdAt);
  const expiresAt = integer(raw.expiresAt);
  if (expiresAt <= createdAt || expiresAt - createdAt > 7 * 24 * 60 * 60 * 1000) invalid();
  const parsedLimits = Object.freeze({
    maxRuns: integer(limits.maxRuns, 100, 1),
    maxSearches: integer(limits.maxSearches, 400, 1),
    maxFetches: integer(limits.maxFetches, 400),
    maxResponseBytes: integer(limits.maxResponseBytes, 512 * 1024 * 1024, 1),
    maxModelTurns: integer(limits.maxModelTurns, 800, 1),
    maxModelRequestBytes: integer(limits.maxModelRequestBytes, 128 * 1024 * 1024, 1),
  });
  if (!raw.allowDiscoveredPages && parsedLimits.maxFetches !== 0) invalid();
  return Object.freeze({
    id: text(raw.id, 128),
    dotId: text(raw.dotId, 128),
    createdAt,
    expiresAt,
    provider: Object.freeze({
      id: text(provider.id, 128),
      baseUrl: text(provider.baseUrl, 8192),
      model: text(provider.model, 512),
    }),
    configurationRevision: integer(raw.configurationRevision),
    queries,
    allowDiscoveredPages: raw.allowDiscoveredPages,
    limits: parsedLimits,
  });
}
export function createDotResearchPolicy(value: DotResearchPolicyInput): DotResearchPolicy {
  const parsed = input(value);
  return Object.freeze({
    version: 1,
    ...parsed,
    revision: 0,
    status: 'active',
    updatedAt: parsed.createdAt,
  });
}
export function rehydrateDotResearchPolicy(value: unknown): DotResearchPolicy {
  const raw = record(value, ['version', ...fields, 'revision', 'status', 'updatedAt']);
  const parsed = input(Object.fromEntries(fields.map((key) => [key, raw[key]])));
  const revision = integer(raw.revision, 1);
  const updatedAt = integer(raw.updatedAt);
  if (raw.status !== 'active' && raw.status !== 'revoked') invalid();
  if (
    raw.version !== 1 ||
    updatedAt < parsed.createdAt ||
    (raw.status === 'active'
      ? revision !== 0 || updatedAt !== parsed.createdAt
      : raw.status !== 'revoked' || revision !== 1)
  )
    invalid();
  return Object.freeze({ version: 1, ...parsed, revision, status: raw.status, updatedAt });
}
