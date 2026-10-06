import type { Message, ModelPort, ModelRequest, ModelResponse, ToolCall } from '@prospero/core';

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  supportsTools?: boolean;
}
export type ProviderErrorCode =
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'incompatible'
  | 'cancelled';
const ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  auth: 'Authentication failed. Check the provider API key.',
  'rate-limit': 'The provider rate limit was reached. Try again later.',
  server: 'The provider is temporarily unavailable. Try again later.',
  network: 'Could not connect to the provider. Check your endpoint and connection.',
  timeout: 'The provider request timed out. Try again.',
  incompatible: 'The endpoint returned an incompatible response.',
  cancelled: 'The provider request was cancelled.',
};

export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ProviderError';
  }
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

function validateConfig(config: ProviderConfig, baseUrl: string): void {
  if (!config.model.trim() || /[\r\n]/.test(config.apiKey)) throw new ProviderError('incompatible');
  if (!config.apiKey.trim() && !isLoopback(new URL(baseUrl))) throw new ProviderError('auth');
}

function authenticationHeaders(config: ProviderConfig): Record<string, string> {
  const key = config.apiKey.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Keep reflected Authorization credentials out of public text and tool requests. */
function secretFilter(secret: string, publish: (delta: string) => void) {
  const patterns = secret ? [...new Set([secret, JSON.stringify(secret).slice(1, -1)])] : [];
  // Choose a separator absent from the credential so masking cannot recreate a
  // short credential at the boundary between neighboring public text pieces.
  let maskCodePoint = 0x2588;
  while (patterns.some((pattern) => pattern.includes(String.fromCodePoint(maskCodePoint))))
    maskCodePoint += 1;
  const mask = String.fromCodePoint(maskCodePoint);
  const replacement = patterns.some((pattern) => '[redacted credential]'.includes(pattern))
    ? mask.repeat(4)
    : `${mask}[redacted credential]${mask}`;
  let pending = '';
  const drain = (final: boolean) => {
    let output = '';
    while (pending) {
      let nextIndex = -1;
      let matched = '';
      for (const pattern of patterns) {
        const index = pending.indexOf(pattern);
        if (
          index !== -1 &&
          (nextIndex === -1 ||
            index < nextIndex ||
            (index === nextIndex && pattern.length > matched.length))
        ) {
          nextIndex = index;
          matched = pattern;
        }
      }
      if (nextIndex !== -1) {
        output += pending.slice(0, nextIndex) + replacement;
        pending = pending.slice(nextIndex + matched.length);
        continue;
      }
      let retained = 0;
      if (!final)
        for (const pattern of patterns) {
          for (let size = Math.min(pattern.length - 1, pending.length); size > retained; size--) {
            if (pending.endsWith(pattern.slice(0, size))) {
              retained = size;
              break;
            }
          }
        }
      output += pending.slice(0, pending.length - retained);
      pending = retained ? pending.slice(-retained) : '';
      break;
    }
    if (output) publish(output);
  };
  return {
    push(delta: string) {
      pending += delta;
      drain(false);
    },
    flush() {
      drain(true);
    },
    contains(value: string) {
      return patterns.some((pattern) => value.includes(pattern));
    },
  };
}

/** Root endpoints (for example DeepSeek) are preserved; no implicit /v1 is added. */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderError('incompatible');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))
  )
    throw new ProviderError('incompatible');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  return url.toString().replace(/\/+$/, '');
}

function deepSeekParameters(baseUrl: string, model: string) {
  // This adapter keeps reasoning private and does not replay it across tool turns.
  if (
    [
      'https://api.deepseek.com',
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/beta',
    ].includes(baseUrl) &&
    ['deepseek-flash', 'deepseek-v4-pro'].includes(model)
  )
    return { thinking: { type: 'disabled' } };
  return {};
}

function statusError(status: number): ProviderError {
  return new ProviderError(
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate-limit'
        : status >= 500
          ? 'server'
          : 'incompatible',
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(new ProviderError('cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new ProviderError('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function wireMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

type RequestScope = { signal: AbortSignal; timedOut(): boolean; dispose(): void };
function requestScope(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestScope {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const ms =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 300_000)
      : 60_000;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}

function safeError(error: unknown, scope: RequestScope): ProviderError {
  if (scope.timedOut()) return new ProviderError('timeout');
  if (scope.signal.aborted) return new ProviderError('cancelled');
  return error instanceof ProviderError ? error : new ProviderError('network');
}

async function consumeStream(
  response: Response,
  onText: (delta: string) => void,
  signal: AbortSignal,
  supportsTools: boolean,
  secret: string,
): Promise<ModelResponse> {
  if (
    !response.body ||
    !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
  )
    throw new ProviderError('incompatible');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let dataLines: string[] = [];
  let content = '';
  const filter = secretFilter(secret, (delta) => {
    content += delta;
    onText(delta);
  });
  let finishReason = '';
  let done = false;
  let bytes = 0;
  let eventCount = 0;
  let usage: ModelResponse['usage'];
  const calls = new Map<number, ToolCall>();
  const incompatible = () => {
    throw new ProviderError('incompatible');
  };
  const dispatch = () => {
    if (signal.aborted) throw new ProviderError('cancelled');
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (done) return incompatible();
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let packet: unknown;
    try {
      packet = JSON.parse(data);
    } catch {
      return incompatible();
    }
    if (!record(packet) || packet.error || !Array.isArray(packet.choices)) return incompatible();
    eventCount += 1;
    if (packet.usage !== undefined && packet.usage !== null) {
      if (!record(packet.usage)) return incompatible();
      const input = packet.usage.prompt_tokens;
      const output = packet.usage.completion_tokens;
      if (
        (input !== undefined && (!Number.isInteger(input) || (input as number) < 0)) ||
        (output !== undefined && (!Number.isInteger(output) || (output as number) < 0))
      )
        return incompatible();
      usage = {
        ...(typeof input === 'number' ? { inputTokens: input } : {}),
        ...(typeof output === 'number' ? { outputTokens: output } : {}),
      };
    }
    if (!packet.choices.length) {
      if (!packet.usage) return incompatible();
      return;
    }
    if (packet.choices.length !== 1) return incompatible();
    const choice: unknown = packet.choices[0];
    if (
      !record(choice) ||
      (choice.index !== undefined && choice.index !== 0) ||
      !record(choice.delta)
    )
      return incompatible();
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant') return incompatible();
    if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string')
      return incompatible();
    if (finishReason && ((typeof delta.content === 'string' && delta.content) || delta.tool_calls))
      return incompatible();
    if (typeof delta.content === 'string' && delta.content) {
      filter.push(delta.content);
    }
    // Provider-specific reasoning fields remain private and are never forwarded.
    if (delta.tool_calls !== undefined) {
      if (!supportsTools || !Array.isArray(delta.tool_calls)) return incompatible();
      for (const item of delta.tool_calls) {
        if (
          !record(item) ||
          !Number.isInteger(item.index) ||
          (item.index as number) < 0 ||
          (item.index as number) > 127 ||
          (item.type !== undefined && item.type !== 'function')
        )
          return incompatible();
        const index = item.index as number;
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (item.id !== undefined) {
          if (typeof item.id !== 'string') return incompatible();
          call.id += item.id;
        }
        if (item.function !== undefined) {
          if (!record(item.function)) return incompatible();
          if (item.function.name !== undefined) {
            if (typeof item.function.name !== 'string') return incompatible();
            call.name += item.function.name;
          }
          if (item.function.arguments !== undefined) {
            if (typeof item.function.arguments !== 'string') return incompatible();
            call.arguments += item.function.arguments;
          }
        }
        calls.set(index, call);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (
        typeof choice.finish_reason !== 'string' ||
        !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason) ||
        (finishReason && choice.finish_reason !== finishReason)
      )
        return incompatible();
      finishReason = choice.finish_reason;
    }
  };
  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event' && value === 'error') incompatible();
  };
  const parseLines = (final: boolean) => {
    while (true) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match || (!final && match[0] === '\r' && match.index === buffer.length - 1)) break;
      processLine(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (final && buffer) {
      processLine(buffer);
      buffer = '';
    }
  };
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) incompatible();
      try {
        buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        incompatible();
      }
      parseLines(false);
      // [DONE] terminates the SSE protocol; do not wait on a server's open socket.
      if (done) break;
    }
    try {
      buffer += decoder.decode();
    } catch {
      incompatible();
    }
    parseLines(true);
    dispatch();
    if (
      !eventCount ||
      !finishReason ||
      (finishReason === 'tool_calls' && !calls.size) ||
      (finishReason === 'stop' && calls.size)
    )
      incompatible();
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call], position) => {
        if (
          index !== position ||
          !call.id ||
          call.id.length > 256 ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)
        )
          incompatible();
        if (
          filter.contains(call.id) ||
          filter.contains(call.name) ||
          filter.contains(call.arguments)
        )
          incompatible();
        return call;
      });
    if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) incompatible();
    filter.flush();
    if (signal.aborted) throw new ProviderError('cancelled');
    return { content, toolCalls, finishReason, ...(usage ? { usage } : {}) };
  } finally {
    // Cancel rather than just release: stop the HTTP body after [DONE] or error.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OpenAICompatibleProvider implements ModelPort {
  private readonly baseUrl: string;
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    validateConfig(config, this.baseUrl);
  }
  async stream(
    request: ModelRequest,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const scope = requestScope(signal, this.config.timeoutMs);
    const apiKey = this.config.apiKey.trim();
    try {
      if (scope.signal.aborted) throw new ProviderError('cancelled');
      const toolsEnabled = this.config.supportsTools !== false && request.tools.length > 0;
      const response = await withAbort(
        this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: scope.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...authenticationHeaders({ ...this.config, apiKey }),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: request.messages.map(wireMessage),
            stream: true,
            ...deepSeekParameters(this.baseUrl, this.config.model),
            ...(toolsEnabled
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                  tool_choice: 'auto',
                }
              : {}),
          }),
        }),
        scope.signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      return await consumeStream(
        response,
        onText,
        scope.signal,
        this.config.supportsTools !== false,
        apiKey,
      );
    } catch (error) {
      throw safeError(error, scope);
    } finally {
      scope.dispose();
    }
  }
}

export interface ConnectionResult {
  status: 'connected' | 'auth' | 'incompatible' | 'network' | 'timeout';
  message: string;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ProviderError('incompatible');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 100_000) throw new ProviderError('incompatible');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (signal.aborted) throw new ProviderError('cancelled');
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('incompatible');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** At most one GET and one one-token completion; all response bodies stay private. */
export async function testConnection(
  config: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionResult> {
  const scope = requestScope(undefined, config.timeoutMs);
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    validateConfig(config, baseUrl);
    const headers = {
      ...authenticationHeaders(config),
      'Content-Type': 'application/json',
    };
    const models = await withAbort(
      fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: scope.signal,
      }),
      scope.signal,
    );
    if (models.ok) {
      let data: unknown;
      try {
        data = await boundedJson(models, scope.signal);
      } catch (error) {
        if (scope.signal.aborted) throw error;
      }
      if (record(data) && Array.isArray(data.data))
        return { status: 'connected', message: 'Connected to the provider.' };
    } else {
      void models.body?.cancel().catch(() => {});
      if (![404, 405, 501].includes(models.status)) throw statusError(models.status);
    }
    const completion = await withAbort(
      fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: scope.signal,
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          stream: false,
          max_tokens: 1,
          ...deepSeekParameters(baseUrl, config.model),
        }),
      }),
      scope.signal,
    );
    if (!completion.ok) {
      void completion.body?.cancel().catch(() => {});
      throw statusError(completion.status);
    }
    const data = await boundedJson(completion, scope.signal);
    if (
      !record(data) ||
      !Array.isArray(data.choices) ||
      !data.choices.length ||
      !record(data.choices[0]) ||
      !record(data.choices[0].message) ||
      typeof data.choices[0].message.content !== 'string'
    )
      throw new ProviderError('incompatible');
    return { status: 'connected', message: 'Connected. A one-token compatibility check was used.' };
  } catch (error) {
    const safe = safeError(error, scope);
    const status =
      safe.code === 'auth' || safe.code === 'timeout' || safe.code === 'incompatible'
        ? safe.code
        : 'network';
    return { status, message: safe.message };
  } finally {
    scope.dispose();
  }
}
