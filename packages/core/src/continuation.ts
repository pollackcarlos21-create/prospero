import type { SourceRecord } from './actions';
import type { AgentContinuation, AgentLimits, Message, ToolCall } from './types';

export const SUSPENDED_TOOL_CONTENT =
  'Tool action suspended for approval. This action has not run; the saved continuation grants no permission.';
export const DEFERRED_TOOL_CONTENT =
  'Tool action skipped because execution suspended before approval. This action did not run; request it again only if still needed.';
export const continuationBytes = 1024 * 1024;
const maximums: Required<AgentLimits> = {
  maxModelTurns: 100,
  maxToolCalls: 200,
  maxExecutionMs: 1_800_000,
  maxPermissionWaitMs: 600_000,
  maxWallClockMs: 3_600_000,
  maxContextBytes: 1024 * 1024,
};
const defaults: Required<AgentLimits> = {
  maxModelTurns: 12,
  maxToolCalls: 32,
  maxExecutionMs: 180_000,
  maxPermissionWaitMs: 300_000,
  maxWallClockMs: 900_000,
  maxContextBytes: 192 * 1024,
};
export function agentLimits(limits?: AgentLimits): Required<AgentLimits> {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => {
      const name = key as keyof AgentLimits;
      const value = limits?.[name];
      return [
        name,
        value !== undefined && Number.isInteger(value) && value > 0
          ? Math.min(value, maximums[name])
          : fallback,
      ];
    }),
  ) as Required<AgentLimits>;
}
function invalid(): never {
  throw new Error(
    'Invalid or exhausted agent continuation. Inspect the saved execution before continuing.',
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid();
  return value;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max) invalid();
  return value;
}
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map(parse);
}
function tool(value: unknown): ToolCall {
  const input = record(value);
  keys(input, ['id', 'name', 'arguments']);
  const call = {
    id: string(input.id, 256),
    name: string(input.name, 128),
    arguments: string(input.arguments, 64 * 1024),
  };
  return call;
}
function message(value: unknown): Message {
  const input = record(value);
  keys(input, ['role', 'content'], ['toolCalls', 'toolCallId']);
  if (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'tool') invalid();
  const output: Message = {
    role: input.role,
    content: string(input.content, continuationBytes, true),
  };
  if (input.toolCalls !== undefined) {
    if (output.role !== 'assistant') invalid();
    output.toolCalls = list(input.toolCalls, 200, tool);
    if (!output.toolCalls.length) invalid();
  }
  if (output.role === 'tool') output.toolCallId = string(input.toolCallId, 256);
  else if (input.toolCallId !== undefined) invalid();
  return output;
}
function source(value: unknown): SourceRecord {
  const input = record(value);
  keys(input, ['id', 'url', 'title', 'kind', 'retrievedAt', 'contentHash', 'excerpt']);
  if (input.kind !== 'search' && input.kind !== 'page') invalid();
  return {
    id: string(input.id, 256),
    url: string(input.url, 8192),
    title: string(input.title, 16384, true),
    kind: input.kind,
    retrievedAt: number(input.retrievedAt),
    contentHash: string(input.contentHash, 256),
    excerpt: string(input.excerpt, 16384, true),
  };
}
/** Copy only JSON data without invoking getters, toJSON or caller-owned code. */
function data(value: unknown, depth = 0, count = { value: 0 }): unknown {
  if (++count.value > 16000 || depth > 16) invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value === 'string') return string(value, continuationBytes, true);
  if (typeof value !== 'object') invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length) invalid();
  if (array) {
    if (Object.keys(descriptors).length !== value.length + 1 || value.length > 16000) invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      return data(descriptor.value, depth + 1, count);
    });
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || name === '__proto__')
      invalid();
    output[name] = data(descriptor.value, depth + 1, count);
  }
  return output;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Strict public rehydration; validity is data consistency, never authorization. */
export function rehydrateAgentContinuation(value: unknown): AgentContinuation {
  const input = record(data(value));
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > continuationBytes) invalid();
  keys(input, [
    'version',
    'executionId',
    'messages',
    'memory',
    'pending',
    'modelTurns',
    'toolCalls',
    'remainingExecutionMs',
    'suspendedAt',
    'wallDeadline',
    'limits',
    'denied',
    'sources',
  ]);
  if (input.version !== 1) invalid();
  const limitsInput = record(input.limits);
  keys(limitsInput, Object.keys(defaults));
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AgentLimits)[])
    limits[key] = number(limitsInput[key], maximums[key], 1);
  const messages = list(input.messages, 1000, message);
  let latestGroup = -1;
  for (let index = 0; index < messages.length; ) {
    const current = messages[index];
    if (current.role === 'tool') invalid();
    const calls = current.toolCalls ?? [];
    const expected = new Set(calls.map((call) => call.id));
    if (expected.size !== calls.length) invalid();
    if (calls.length) latestGroup = index;
    index++;
    while (index < messages.length && messages[index].role === 'tool') {
      if (!expected.delete(messages[index].toolCallId ?? '')) invalid();
      index++;
    }
    if (expected.size) invalid();
  }
  const pendingInput = record(input.pending);
  keys(pendingInput, ['assistantIndex', 'resultIndex', 'expiresAt']);
  const assistantIndex = number(pendingInput.assistantIndex, messages.length - 1);
  const resultIndex = number(pendingInput.resultIndex, messages.length - 1);
  const pending = messages[resultIndex];
  const group = messages[assistantIndex];
  const calls = group.toolCalls ?? [];
  const offset = resultIndex - assistantIndex - 1;
  if (
    assistantIndex !== latestGroup ||
    group.role !== 'assistant' ||
    offset < 0 ||
    offset >= calls.length ||
    messages.length !== assistantIndex + 1 + calls.length ||
    pending.role !== 'tool' ||
    pending.content !== SUSPENDED_TOOL_CONTENT ||
    pending.toolCallId !== calls[offset].id
  )
    invalid();
  for (let index = 0; index < calls.length; index++) {
    const result = messages[assistantIndex + index + 1];
    if (
      result.toolCallId !== calls[index].id ||
      (index > offset && result.content !== DEFERRED_TOOL_CONTENT)
    )
      invalid();
  }
  const deniedInput = record(input.denied);
  keys(deniedInput, ['mutations', 'network', 'reads']);
  if (typeof deniedInput.mutations !== 'boolean' || typeof deniedInput.network !== 'boolean')
    invalid();
  const remainingExecutionMs = number(input.remainingExecutionMs, limits.maxExecutionMs);
  const suspendedAt = number(input.suspendedAt);
  const wallDeadline = number(input.wallDeadline);
  const expiresAt = number(pendingInput.expiresAt);
  if (
    remainingExecutionMs <= 0 ||
    wallDeadline <= suspendedAt ||
    wallDeadline - suspendedAt > limits.maxWallClockMs ||
    expiresAt <= suspendedAt ||
    expiresAt > wallDeadline ||
    expiresAt - suspendedAt > limits.maxPermissionWaitMs
  )
    invalid();
  try {
    record(JSON.parse(calls[offset].arguments));
  } catch {
    invalid();
  }
  const reads = list(deniedInput.reads, 200, (value) => string(value, 8192));
  if (new Set(reads).size !== reads.length) invalid();
  const sources = list(input.sources, 200, source);
  if (new Set(sources.map((entry) => entry.id)).size !== sources.length) invalid();
  return freeze({
    version: 1,
    executionId: string(input.executionId, 256),
    messages,
    memory: list(input.memory, 128, (value) => string(value, 64 * 1024, true)),
    pending: { assistantIndex, resultIndex, expiresAt },
    modelTurns: number(input.modelTurns, limits.maxModelTurns, 1),
    toolCalls: number(input.toolCalls, limits.maxToolCalls, 1),
    remainingExecutionMs,
    suspendedAt,
    wallDeadline,
    limits,
    denied: { mutations: deniedInput.mutations, network: deniedInput.network, reads },
    sources,
  });
}
