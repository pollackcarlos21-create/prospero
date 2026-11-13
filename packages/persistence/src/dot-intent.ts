import { createHash } from 'node:crypto';
import {
  rehydrateAgentContinuation,
  type AgentContinuation,
  type PermissionRequest,
  type SourceRecord,
} from '@prospero/core';
import { DotRepositoryError } from './dot-errors';

export const dotIntentStatuses = [
  'pending',
  'approved',
  'denied',
  'expired',
  'stale',
  'cancelled',
  'dispatching',
  'succeeded',
  'unknown',
] as const;
export type DotIntentStatus = (typeof dotIntentStatuses)[number];
export interface DotIntentProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
}
export interface DotIntentInput {
  readonly id: string;
  readonly dotId: string;
  readonly runId: string;
  readonly dotRevision: number;
  readonly provider: DotIntentProvider;
  readonly policyRevision: number;
  readonly request: PermissionRequest;
  readonly continuation: AgentContinuation;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface DotIntentReceipt {
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly sources?: readonly Readonly<SourceRecord>[];
  readonly responseBytes?: number;
}
export interface DotIntent extends DotIntentInput {
  readonly version: 1;
  readonly digest: string;
  readonly status: DotIntentStatus;
  readonly revision: number;
  readonly updatedAt: number;
  readonly dispatchedAt?: number;
  readonly receipt?: DotIntentReceipt;
}
export interface DotIntentEvent {
  readonly sequence: number;
  readonly status: DotIntentStatus;
  readonly at: number;
}
export function invalidIntent(): never {
  throw new DotRepositoryError('invalid-stored-state');
}
function inputError(): never {
  throw new DotRepositoryError('invalid-intent');
}
function object(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) inputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
    fields.some((key) => !Object.hasOwn(descriptors, key))
  )
    inputError();
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      (!fields.includes(key) && !optional.includes(key)) ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    )
      inputError();
    result[key] = descriptor.value;
  }
  return result;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    inputError();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) inputError();
  return value;
}
function strings(value: unknown, maximum: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    inputError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) inputError();
  return Object.freeze(
    Array.from({ length: value.length }, (_, index) => {
      const field = descriptors[String(index)];
      if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) inputError();
      return text(field.value, 256);
    }),
  );
}
function binding(value: unknown): DotIntentInput {
  const input = object(value, [
    'id',
    'dotId',
    'runId',
    'dotRevision',
    'provider',
    'policyRevision',
    'request',
    'continuation',
    'createdAt',
    'expiresAt',
  ]);
  const provider = object(input.provider, ['id', 'baseUrl', 'model']);
  const request = object(input.request, [
    'requestId',
    'call',
    'preview',
    'permissionKey',
    'allowSession',
  ]);
  if (request.allowSession !== false) inputError();
  const call = object(request.call, ['id', 'name', 'arguments']);
  const preview = object(request.preview, ['kind', 'title', 'effects'], ['query', 'url']);
  if (preview.kind !== 'web') inputError();
  const effects = strings(preview.effects, 2);
  if (
    !effects.length ||
    new Set(effects).size !== effects.length ||
    effects.some((effect) => effect !== 'network.search' && effect !== 'network.fetch')
  )
    inputError();
  let continuation: AgentContinuation;
  try {
    continuation = rehydrateAgentContinuation(input.continuation);
  } catch {
    inputError();
  }
  const pending =
    continuation.messages[continuation.pending.assistantIndex].toolCalls?.[
      continuation.pending.resultIndex - continuation.pending.assistantIndex - 1
    ];
  const parsedCall = Object.freeze({
    id: text(call.id, 256),
    name: text(call.name, 128),
    arguments: text(call.arguments, 64 * 1024),
  });
  const runId = text(input.runId, 128);
  const createdAt = integer(input.createdAt);
  const expiresAt = integer(input.expiresAt);
  const requestId = text(request.requestId, 512);
  if (integer(input.dotRevision) < 1) inputError();
  if (
    continuation.executionId !== runId ||
    !pending ||
    pending.id !== parsedCall.id ||
    pending.name !== parsedCall.name ||
    pending.arguments !== parsedCall.arguments ||
    requestId !== `${runId}-${continuation.modelTurns}-${continuation.toolCalls}` ||
    createdAt < continuation.suspendedAt ||
    expiresAt <= createdAt ||
    expiresAt > continuation.pending.expiresAt
  )
    inputError();
  const parsedPreview: PermissionRequest['preview'] = Object.freeze({
    kind: 'web',
    title: text(preview.title, 512),
    effects: effects as readonly ('network.search' | 'network.fetch')[],
    ...(preview.query === undefined ? {} : { query: text(preview.query, 2048) }),
    ...(preview.url === undefined ? {} : { url: text(preview.url, 8192) }),
  });
  if (!parsedPreview.query && !parsedPreview.url) inputError();
  const parsedProvider = Object.freeze({
    id: text(provider.id, 128),
    baseUrl: text(provider.baseUrl, 8192),
    model: text(provider.model, 512),
  });
  return Object.freeze({
    id: text(input.id, 128),
    dotId: text(input.dotId, 128),
    runId,
    dotRevision: integer(input.dotRevision),
    provider: parsedProvider,
    policyRevision: integer(input.policyRevision),
    request: Object.freeze({
      requestId,
      call: parsedCall,
      preview: parsedPreview,
      permissionKey: text(request.permissionKey, 8192),
      allowSession: false,
    }),
    continuation,
    createdAt,
    expiresAt,
  });
}
export function intentBinding(intent: DotIntentInput): DotIntentInput {
  return {
    id: intent.id,
    dotId: intent.dotId,
    runId: intent.runId,
    dotRevision: intent.dotRevision,
    provider: intent.provider,
    policyRevision: intent.policyRevision,
    request: intent.request,
    continuation: intent.continuation,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
  };
}
function digest(input: DotIntentInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }))
    .digest('hex');
}
export function createDotIntent(value: DotIntentInput): DotIntent {
  const input = binding(value);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 1200 * 1024) inputError();
  return Object.freeze({
    version: 1,
    ...input,
    digest: digest(input),
    status: 'pending',
    revision: 0,
    updatedAt: input.createdAt,
  });
}
export function rehydrateDotIntent(value: unknown): DotIntent {
  const raw = object(
    value,
    [
      'version',
      'id',
      'dotId',
      'runId',
      'dotRevision',
      'provider',
      'policyRevision',
      'request',
      'continuation',
      'createdAt',
      'expiresAt',
      'digest',
      'status',
      'revision',
      'updatedAt',
    ],
    ['dispatchedAt', 'receipt'],
  );
  const input = binding({
    id: raw.id,
    dotId: raw.dotId,
    runId: raw.runId,
    dotRevision: raw.dotRevision,
    provider: raw.provider,
    policyRevision: raw.policyRevision,
    request: raw.request,
    continuation: raw.continuation,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  });
  if (
    raw.version !== 1 ||
    raw.digest !== digest(input) ||
    typeof raw.status !== 'string' ||
    !dotIntentStatuses.includes(raw.status as DotIntentStatus)
  )
    inputError();
  const status = raw.status as DotIntentStatus;
  const revision = integer(raw.revision);
  const updatedAt = integer(raw.updatedAt);
  if ((status === 'approved' || status === 'denied') && updatedAt >= input.expiresAt) inputError();
  if (
    updatedAt < input.createdAt ||
    (status === 'pending' && (revision !== 0 || updatedAt !== input.createdAt)) ||
    (status !== 'pending' && revision === 0)
  )
    inputError();
  const dispatchedAt = raw.dispatchedAt === undefined ? undefined : integer(raw.dispatchedAt);
  const dispatched = status === 'dispatching' || status === 'succeeded' || status === 'unknown';
  if (
    dispatched !== (dispatchedAt !== undefined) ||
    (dispatchedAt !== undefined &&
      (dispatchedAt < input.createdAt ||
        dispatchedAt >= input.expiresAt ||
        dispatchedAt > updatedAt))
  )
    inputError();
  if ((status === 'succeeded') !== (raw.receipt !== undefined)) inputError();
  let receipt: DotIntentReceipt | undefined;
  if (raw.receipt !== undefined) {
    const record = object(raw.receipt, ['summary', 'sourceIds'], ['sources', 'responseBytes']);
    let sources: readonly Readonly<SourceRecord>[] | undefined;
    if (record.sources !== undefined) {
      if (!Array.isArray(record.sources) || record.sources.length > 10) inputError();
      const sourceValues = record.sources;
      const descriptors = Object.getOwnPropertyDescriptors(sourceValues);
      if (
        Object.getPrototypeOf(sourceValues) !== Array.prototype ||
        Reflect.ownKeys(sourceValues).length !== sourceValues.length + 1
      )
        inputError();
      sources = Object.freeze(
        Array.from({ length: sourceValues.length }, (_, index) => {
          const field = descriptors[String(index)];
          if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) inputError();
          const value = field.value;
          const source = object(value, [
            'id',
            'url',
            'title',
            'kind',
            'retrievedAt',
            'contentHash',
            'excerpt',
          ]);
          if ((source.kind !== 'search' && source.kind !== 'page') || source.excerpt !== '')
            inputError();
          const url = text(source.url, 2048);
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            inputError();
          }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
            inputError();
          return Object.freeze({
            id: text(source.id, 256),
            url,
            title: text(source.title, 300),
            kind: source.kind,
            retrievedAt: integer(source.retrievedAt),
            contentHash: text(source.contentHash, 256),
            excerpt: '',
          });
        }),
      );
    }
    receipt = Object.freeze({
      summary: text(record.summary, 2048),
      sourceIds: strings(record.sourceIds, 50),
      ...(sources === undefined ? {} : { sources }),
      ...(record.responseBytes === undefined
        ? {}
        : { responseBytes: integer(record.responseBytes) }),
    });
    if (new Set(receipt.sourceIds).size !== receipt.sourceIds.length) inputError();
    const sourceIds = receipt.sourceIds;
    if (
      sources &&
      (sources.length !== sourceIds.length ||
        sources.some((source, index) => source.id !== sourceIds[index]))
    )
      inputError();
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 32 * 1024) inputError();
  }
  return Object.freeze({
    version: 1,
    ...input,
    digest: text(raw.digest, 64),
    status,
    revision,
    updatedAt,
    ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
    ...(receipt ? { receipt } : {}),
  });
}
