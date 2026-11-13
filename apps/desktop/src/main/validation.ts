import type { PermissionDecision } from '@prospero/core';
import { rehydrateDotResearchPolicy } from '@prospero/dots';
import type { DotPolicyTerms, DotReviewInput } from '../bridge';
import type {
  ContextMenuTarget,
  ProviderInput,
  Settings,
  WebSearchInput,
  WebSearchProvider,
  WebSearchTestInput,
  DotControl,
  DotPage,
} from '../bridge';
export class UserError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UserError('Invalid request.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new UserError('Unexpected request fields.');
}
export function text(value: unknown, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new UserError('Enter valid text within the size limit.');
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new UserError('Invalid identifier.');
  return result;
}
export function dotId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new UserError('Invalid Dot identifier.');
  return result;
}
export function dotRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new UserError('Invalid Dot revision.');
  return value;
}
export function dotControl(value: unknown): DotControl {
  if (!['pause', 'resume', 'complete', 'cancel', 'archive'].includes(value as string))
    throw new UserError('Choose a valid Dot control.');
  return value as DotControl;
}
export function dotInput(value: unknown): { name: string; goal: string } {
  const input = object(value);
  exact(input, ['name', 'goal']);
  return { name: text(input.name, 120), goal: text(input.goal, 16384) };
}
export function dotReviewInput(value: unknown): DotReviewInput {
  const input = object(value);
  exact(input, ['acknowledge', 'note']);
  if (input.acknowledge !== true)
    throw new UserError('Confirm that the request may already have happened.');
  const note = text(input.note, 4096);
  if (Buffer.byteLength(note, 'utf8') > 4096)
    throw new UserError('Enter valid text within the size limit.');
  return { acknowledge: true, note };
}
export function dotPolicyTerms(value: unknown): DotPolicyTerms {
  const input = object(value);
  exact(input, ['queries', 'allowDiscoveredPages', 'expiresAt', 'limits']);
  try {
    const now = Date.now();
    const policy = rehydrateDotResearchPolicy({
      ...input,
      version: 1,
      id: 'validation',
      dotId: 'validation',
      createdAt: now,
      updatedAt: now,
      provider: { id: 'validation', baseUrl: 'https://validation.invalid', model: 'validation' },
      configurationRevision: 0,
      status: 'active',
      revision: 0,
    });
    return {
      queries: policy.queries,
      allowDiscoveredPages: policy.allowDiscoveredPages,
      expiresAt: policy.expiresAt,
      limits: policy.limits,
    };
  } catch {
    throw new UserError('Choose valid exact queries, expiry and bounded research budgets.');
  }
}
export function dotPage(
  value: unknown,
  includeArchived = false,
): DotPage & { includeArchived?: boolean } {
  const input = object(value);
  exact(input, includeArchived ? ['limit', 'offset', 'includeArchived'] : ['limit', 'offset']);
  if (
    input.limit !== undefined &&
    (typeof input.limit !== 'number' ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200)
  )
    throw new UserError('Choose a page size between 1 and 200.');
  if (
    input.offset !== undefined &&
    (typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0)
  )
    throw new UserError('Choose a valid history offset.');
  if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean')
    throw new UserError('Invalid archived filter.');
  return {
    limit: input.limit as number | undefined,
    offset: input.offset as number | undefined,
    ...(includeArchived ? { includeArchived: input.includeArchived as boolean | undefined } : {}),
  };
}
export function dotContextQuery(value: unknown): import('@prospero/dots').DotContextQuery {
  const input = object(value);
  exact(input, ['runId', 'beforeRunId', 'requestOffset']);
  if (input.runId !== undefined && input.beforeRunId !== undefined)
    throw new UserError('Choose a Run or an earlier history page.');
  const requestOffset = input.requestOffset === undefined ? 0 : input.requestOffset;
  if (
    typeof requestOffset !== 'number' ||
    !Number.isSafeInteger(requestOffset) ||
    requestOffset < 0 ||
    requestOffset > 200
  )
    throw new UserError('Choose a valid context request offset.');
  return {
    runId: input.runId === undefined ? undefined : dotId(input.runId),
    beforeRunId: input.beforeRunId === undefined ? undefined : dotId(input.beforeRunId),
    requestOffset,
  };
}
export function decision(value: unknown): PermissionDecision {
  if (value !== 'allow-once' && value !== 'allow-session' && value !== 'deny')
    throw new UserError('Invalid permission decision.');
  return value;
}
export function scopeMode(value: unknown): 'read' | 'write' {
  if (value !== 'read' && value !== 'write')
    throw new UserError('Choose a read-only or writable scope.');
  return value;
}
export function planDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new UserError('Invalid plan digest.');
  return value;
}
export function researchDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new UserError('Invalid research digest.');
  return value;
}
function webSearchProvider(value: unknown): WebSearchProvider | undefined {
  if (value === undefined) return undefined;
  if (value !== 'brave' && value !== 'tavily')
    throw new UserError('Choose a supported Web Search provider.');
  return value;
}
export function webSearchInput(value: unknown): WebSearchInput {
  const v = object(value);
  exact(v, ['provider', 'enabled', 'retention', 'apiKey', 'clearApiKey']);
  const provider = webSearchProvider(v.provider);
  if (
    typeof v.enabled !== 'boolean' ||
    !['session', 'sources'].includes(v.retention as string) ||
    (v.clearApiKey !== undefined && typeof v.clearApiKey !== 'boolean') ||
    (v.apiKey !== undefined &&
      (typeof v.apiKey !== 'string' || v.apiKey.length > 4096 || /[^\x21-\x7e]/.test(v.apiKey)))
  )
    throw new UserError('Invalid Web Search settings.');
  if (v.apiKey && (v.apiKey as string).length < 8)
    throw new UserError('Enter a valid search API key.');
  if (v.clearApiKey && v.apiKey)
    throw new UserError('Choose either replacement or removal of the search key.');
  return {
    ...(provider ? { provider } : {}),
    enabled: v.enabled,
    retention: v.retention as 'session' | 'sources',
    apiKey: v.apiKey as string | undefined,
    clearApiKey: v.clearApiKey as boolean | undefined,
  };
}
export function webSearchTestInput(value: unknown): WebSearchTestInput {
  const v = object(value);
  exact(v, ['provider', 'apiKey']);
  const provider = webSearchProvider(v.provider);
  if (
    v.apiKey !== undefined &&
    (typeof v.apiKey !== 'string' ||
      v.apiKey.length > 4096 ||
      /[^\x21-\x7e]/.test(v.apiKey) ||
      (v.apiKey.length > 0 && v.apiKey.length < 8))
  )
    throw new UserError('Enter a valid search API key.');
  return {
    ...(provider ? { provider } : {}),
    ...(v.apiKey ? { apiKey: v.apiKey as string } : {}),
  };
}
export function providerInput(value: unknown): ProviderInput {
  const v = object(value);
  exact(v, ['id', 'displayName', 'baseUrl', 'model', 'apiKey', 'timeoutMs', 'supportsTools']);
  if (
    v.apiKey !== undefined &&
    (typeof v.apiKey !== 'string' || v.apiKey.length > 8192 || /[\r\n\0]/.test(v.apiKey))
  )
    throw new UserError('Invalid API key.');
  if (
    v.timeoutMs !== undefined &&
    (typeof v.timeoutMs !== 'number' ||
      !Number.isInteger(v.timeoutMs) ||
      v.timeoutMs < 1000 ||
      v.timeoutMs > 300_000)
  )
    throw new UserError('Timeout must be 1–300 seconds.');
  if (v.supportsTools !== undefined && typeof v.supportsTools !== 'boolean')
    throw new UserError('Invalid tool capability.');
  return {
    id: v.id === undefined ? undefined : id(v.id),
    displayName: text(v.displayName, 80).trim(),
    baseUrl: text(v.baseUrl, 2048).trim(),
    model: text(v.model, 200).trim(),
    apiKey: v.apiKey as string | undefined,
    timeoutMs: v.timeoutMs as number | undefined,
    supportsTools: v.supportsTools as boolean | undefined,
  };
}
export function settingsInput(value: unknown): Settings {
  const v = object(value);
  exact(v, ['theme', 'defaultProviderId', 'askBeforeReads', 'memory', 'dotNotifications']);
  if (
    !['system', 'light', 'dark'].includes(v.theme as string) ||
    typeof v.askBeforeReads !== 'boolean' ||
    (v.dotNotifications !== undefined && typeof v.dotNotifications !== 'boolean') ||
    !Array.isArray(v.memory) ||
    v.memory.length > 50
  )
    throw new UserError('Invalid settings.');
  const memory = v.memory.map((entry) => {
    const e = object(entry);
    exact(e, ['id', 'text']);
    return { id: id(e.id), text: text(e.text, 4000).trim() };
  });
  if (new Set(memory.map((e) => e.id)).size !== memory.length)
    throw new UserError('Duplicate memory identifiers.');
  return {
    theme: v.theme as Settings['theme'],
    ...(v.dotNotifications === undefined
      ? {}
      : { dotNotifications: v.dotNotifications as boolean }),
    defaultProviderId: v.defaultProviderId ? id(v.defaultProviderId) : undefined,
    askBeforeReads: v.askBeforeReads,
    memory,
  };
}

export function clipboardText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256_000 || value.includes('\0'))
    throw new UserError('Clipboard text exceeds the size limit.');
  return value;
}
export function contextMenuTarget(value: unknown): ContextMenuTarget {
  const v = object(value);
  const conversationId = id(v.conversationId);
  switch (v.kind) {
    case 'conversation':
      exact(v, ['kind', 'conversationId']);
      return { kind: v.kind, conversationId };
    case 'message':
      exact(v, ['kind', 'conversationId', 'itemId']);
      return { kind: v.kind, conversationId, itemId: id(v.itemId) };
    case 'file':
      exact(v, ['kind', 'conversationId', 'path']);
      return { kind: v.kind, conversationId, path: text(v.path, 4096) };
    default:
      throw new UserError('Invalid context menu target.');
  }
}
