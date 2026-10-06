import type { PermissionDecision } from '@prospero/core';
import type {
  ContextMenuTarget,
  ProviderInput,
  Settings,
  WebSearchInput,
  WebSearchProvider,
  WebSearchTestInput,
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
  exact(v, ['theme', 'defaultProviderId', 'askBeforeReads', 'memory']);
  if (
    !['system', 'light', 'dark'].includes(v.theme as string) ||
    typeof v.askBeforeReads !== 'boolean' ||
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
