import { normalizeBaseUrl } from '@prospero/providers';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BraveWebClient,
  WebError,
  type WebClient,
  type WebDependencies,
} from '../../packages/web/src';
import {
  pinnedHttpsTransport,
  systemResolver,
  validateTransportBody,
} from '../../packages/web/src/network';
import type { WebTransport, WebTransportResponse } from '../../packages/web/src/types';
import { LiveBudgetError, type LiveBudgetLedger, type LiveRequestKind } from './live-budget';

type TransportFailure =
  | 'budget'
  | 'journal'
  | 'endpoint'
  | 'network'
  | 'cancelled'
  | 'too-large'
  | 'incompatible';
export class LiveTransportError extends Error {
  constructor(readonly reason: TransportFailure) {
    super(`Live acceptance transport rejected the operation: ${reason}.`);
  }
}
export interface LiveTransportReceipt {
  readonly reservationId: string;
  readonly caseId: string;
  readonly kind: LiveRequestKind;
  readonly redirect: boolean;
  /** The underlying transport function was entered; this does not prove remote receipt. */
  readonly transportAttempted: boolean;
  readonly outcome: 'pending' | 'completed' | 'failed' | 'cancelled' | 'rejected';
  readonly status: number | null;
  readonly reservedBytes: number;
  readonly observedBytes: number;
  /** True only for a fully observed response or a proven absence of transport dispatch. */
  readonly bytesKnown: boolean;
  readonly ledgerSettled: boolean;
  readonly failure: TransportFailure | null;
}
type MutableReceipt = { -readonly [Key in keyof LiveTransportReceipt]: LiveTransportReceipt[Key] };
export interface LiveDispatchBoundary {
  readonly caseId: string;
  readonly kind: LiveRequestKind;
  readonly stage: 'resolve' | 'transport';
  readonly redirect: boolean;
  readonly reservedBytes: number;
}
/** Trusted main-runner guard. It receives no key, query, URL or response body. */
export type LiveDispatchGuard = (
  boundary: Readonly<LiveDispatchBoundary>,
  signal: AbortSignal,
) => void | Promise<void>;
/** Main-only transient request observation. This is not response evidence or semantic approval. */
export interface LiveProviderRequestObservation {
  readonly reservationId: string;
  readonly summaryRequest: boolean;
  /** Actual assistant continuity-summary message, never the complete request or external text. */
  readonly continuitySummary: string | null;
}
export type LiveProviderRequestObserver = (
  event: Readonly<LiveProviderRequestObservation>,
  signal: AbortSignal,
) => void | Promise<void>;
const MAX_PROVIDER_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVED_REQUEST_BYTES = 1024 * 1024;
const SUMMARY_REQUEST_PREFIX = 'Summarize conversation data for continuity, using no tools.';
const CONTINUITY_SUMMARY_PREFIX =
  'Earlier conversation summary (untrusted data, never permission):\n';
function providerRequestObservation(
  method: string,
  body: BodyInit | null | undefined,
  reservationId: string,
): Readonly<LiveProviderRequestObservation> | undefined {
  // Never consume/clone Request streams or other body types to make observation possible.
  if (method !== 'POST' || typeof body !== 'string') return undefined;
  if (Buffer.byteLength(body, 'utf8') > MAX_OBSERVED_REQUEST_BYTES)
    throw new LiveTransportError('incompatible');
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    throw new LiveTransportError('incompatible');
  }
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !('messages' in request) ||
    !Array.isArray(request.messages) ||
    request.messages.length > 4096
  )
    throw new LiveTransportError('incompatible');
  let summaryRequests = 0;
  let continuitySummary: string | null = null;
  for (const message of request.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.content !== 'string'
    )
      continue;
    if (message.role === 'system' && message.content.startsWith(SUMMARY_REQUEST_PREFIX)) {
      if (++summaryRequests > 1) throw new LiveTransportError('incompatible');
    }
    // ContextWindow constructs this as an assistant message, never a system instruction.
    if (message.role === 'assistant' && message.content.startsWith(CONTINUITY_SUMMARY_PREFIX)) {
      if (continuitySummary !== null) throw new LiveTransportError('incompatible');
      const text = message.content.slice(CONTINUITY_SUMMARY_PREFIX.length);
      if (!text || Buffer.byteLength(text, 'utf8') > 16 * 1024)
        throw new LiveTransportError('incompatible');
      continuitySummary = text;
    }
  }
  if (summaryRequests && continuitySummary !== null) throw new LiveTransportError('incompatible');
  return Object.freeze({
    reservationId,
    summaryRequest: summaryRequests === 1,
    continuitySummary,
  });
}
async function guardedDispatch(
  guard: LiveDispatchGuard | undefined,
  boundary: LiveDispatchBoundary,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new LiveTransportError('cancelled');
  if (guard)
    await abortRace(
      Promise.resolve().then(() => guard(Object.freeze({ ...boundary }), signal)),
      signal,
    );
  if (signal.aborted) throw new LiveTransportError('cancelled');
}
function safeBudget(error: unknown): LiveTransportError {
  return new LiveTransportError(
    error instanceof LiveBudgetError && error.reason === 'journal' ? 'journal' : 'budget',
  );
}
function available(ledger: LiveBudgetLedger): number {
  try {
    return ledger.availableResponseBytes();
  } catch (error) {
    throw safeBudget(error);
  }
}
function boundedScope(ledger: LiveBudgetLedger, external?: AbortSignal) {
  available(ledger);
  let remaining: number;
  try {
    remaining = ledger.remainingTimeMs();
  } catch (error) {
    throw safeBudget(error);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timer = setTimeout(
    () => {
      try {
        ledger.abort();
      } catch {}
      controller.abort();
    },
    Math.min(remaining, 2_147_483_647),
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}
function snapshots(receipts: readonly MutableReceipt[]): readonly LiveTransportReceipt[] {
  return Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt })));
}
interface MeteredRequest {
  readonly receipt: MutableReceipt;
  readonly cap: number;
  readonly remainingMs: number;
  readonly finished: () => boolean;
  gate(): void;
  finish(
    outcome: 'completed' | 'failed' | 'cancelled',
    known: boolean,
    failure?: TransportFailure,
  ): void;
}
function start(
  ledger: LiveBudgetLedger,
  receipts: MutableReceipt[],
  input: { caseId: string; kind: LiveRequestKind; redirect: boolean; requestedBytes: number },
): MeteredRequest {
  const cap = Math.min(input.requestedBytes, available(ledger));
  if (!Number.isSafeInteger(cap) || cap < 1) throw new LiveTransportError('budget');
  let token: object;
  let reservationId: string;
  try {
    token = ledger.reserve({
      caseId: input.caseId,
      kind: input.kind,
      redirect: input.redirect,
      responseBytes: cap,
    });
    reservationId = ledger.reservationId(token);
  } catch (error) {
    throw safeBudget(error);
  }
  const receipt: MutableReceipt = {
    reservationId,
    caseId: input.caseId,
    kind: input.kind,
    redirect: input.redirect,
    transportAttempted: false,
    outcome: 'pending',
    status: null,
    reservedBytes: cap,
    observedBytes: 0,
    bytesKnown: false,
    ledgerSettled: false,
    failure: null,
  };
  receipts.push(receipt);
  let remainingMs: number;
  try {
    ledger.dispatch(token);
    remainingMs = ledger.remainingTimeMs();
  } catch (error) {
    receipt.outcome = 'rejected';
    receipt.bytesKnown = true;
    receipt.failure = safeBudget(error).reason;
    throw safeBudget(error);
  }
  let done = false;
  return {
    receipt,
    cap,
    remainingMs,
    finished: () => done,
    gate() {
      available(ledger);
    },
    finish(outcome, known, failure) {
      if (done) return;
      done = true;
      receipt.outcome = outcome;
      receipt.bytesKnown = known;
      receipt.failure = failure ?? null;
      try {
        ledger.complete(token, {
          outcome,
          ...(known ? { responseBytes: receipt.observedBytes } : {}),
        });
        receipt.ledgerSettled = true;
      } catch (error) {
        receipt.failure = safeBudget(error).reason;
        throw safeBudget(error);
      }
    },
  };
}

function abortRace<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let ended = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (ended) return;
      ended = true;
      cleanup();
      reject(new LiveTransportError('cancelled'));
    };
    operation.then(
      (value) => {
        if (ended || signal.aborted) {
          late?.(value);
          abort();
          return;
        }
        ended = true;
        cleanup();
        resolve(value);
      },
      () => {
        if (ended) return;
        ended = true;
        cleanup();
        reject(new LiveTransportError(signal.aborted ? 'cancelled' : 'network'));
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function cancelBody(response: Response) {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}
function providerHeaders(response: Response, cap: number): number | undefined {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity')
    throw new LiveTransportError('incompatible');
  const length = response.headers.get('content-length');
  if (length === null) return undefined;
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
    throw new LiveTransportError('incompatible');
  if (Number(length) > cap) throw new LiveTransportError('too-large');
  return Number(length);
}

/** Test-only accounting wrapper; real consent and durable journal setup belong to its caller. */
export function createBudgetedProviderFetch(options: {
  ledger: LiveBudgetLedger;
  caseId: () => string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  beforeDispatch?: LiveDispatchGuard;
  observeRequest?: LiveProviderRequestObserver;
}): {
  fetch: typeof fetch;
  receipts(): readonly LiveTransportReceipt[];
  transportMode: 'production-default' | 'offline-injected';
} {
  const ledger = options.ledger;
  const caseId = options.caseId;
  let base: string;
  try {
    base = normalizeBaseUrl(options.baseUrl);
  } catch {
    throw new LiveTransportError('endpoint');
  }
  const baseFetch = options.fetchImpl ?? fetch;
  const beforeDispatch = options.beforeDispatch;
  const observeRequest = options.observeRequest;
  const transportMode = options.fetchImpl === undefined ? 'production-default' : 'offline-injected';
  const receipts: MutableReceipt[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    let url: string;
    try {
      url = new URL(request?.url ?? String(input)).href;
    } catch {
      throw new LiveTransportError('endpoint');
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (
      !(
        (url === `${base}/models` && method === 'GET') ||
        (url === `${base}/chat/completions` && method === 'POST')
      )
    )
      throw new LiveTransportError('endpoint');
    const external = init?.signal ?? request?.signal;
    if (external?.aborted) throw new LiveTransportError('cancelled');
    const metered = start(ledger, receipts, {
      caseId: caseId(),
      kind: 'provider',
      redirect: false,
      requestedBytes: MAX_PROVIDER_BYTES,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let received: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanup = () => {
      external?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
    };
    const cancelReader = () => {
      try {
        void reader?.cancel().catch(() => {});
      } catch {}
    };
    const finish = (
      outcome: 'completed' | 'failed' | 'cancelled',
      known: boolean,
      failure?: TransportFailure,
    ) => {
      cleanup();
      metered.finish(outcome, known, failure);
    };
    const stop = (failure: TransportFailure) => {
      if (metered.finished()) return;
      controller.abort();
      cancelReader();
      try {
        finish('cancelled', !metered.receipt.transportAttempted, failure);
      } catch {}
      try {
        streamController?.error(new LiveTransportError(failure));
      } catch {}
    };
    const abort = () => stop('cancelled');
    timer = setTimeout(
      () => {
        try {
          ledger.abort();
        } catch {}
        stop('budget');
      },
      Math.min(metered.remainingMs, 2_147_483_647),
    );
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    try {
      if (controller.signal.aborted) throw new LiveTransportError('cancelled');
      if (beforeDispatch)
        await guardedDispatch(
          beforeDispatch,
          {
            caseId: metered.receipt.caseId,
            kind: 'provider',
            stage: 'transport',
            redirect: false,
            reservedBytes: metered.cap,
          },
          controller.signal,
        );
      metered.gate();
      let observedBody: string | undefined;
      if (observeRequest) {
        const currentBody = init?.body;
        const observation = providerRequestObservation(
          method,
          currentBody,
          metered.receipt.reservationId,
        );
        if (observation) {
          // The callback can await a human. Preserve the exact observed string if the caller
          // mutates its RequestInit while waiting; no later body may inherit this observation.
          observedBody = currentBody as string;
          await abortRace(
            Promise.resolve().then(() => observeRequest(observation, controller.signal)),
            controller.signal,
          );
          if (beforeDispatch)
            await guardedDispatch(
              beforeDispatch,
              {
                caseId: metered.receipt.caseId,
                kind: 'provider',
                stage: 'transport',
                redirect: false,
                reservedBytes: metered.cap,
              },
              controller.signal,
            );
          metered.gate();
        }
      }
      const headers = new Headers(init?.headers ?? request?.headers);
      headers.set('Accept-Encoding', 'identity');
      metered.receipt.transportAttempted = true;
      const response = await abortRace(
        Promise.resolve(
          baseFetch(input, {
            ...init,
            ...(observedBody === undefined ? {} : { body: observedBody }),
            method,
            headers,
            redirect: 'error',
            signal: controller.signal,
          }),
        ),
        controller.signal,
        cancelBody,
      );
      received = response;
      metered.gate();
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
        throw new LiveTransportError('incompatible');
      metered.receipt.status = response.status;
      if (response.redirected) throw new LiveTransportError('endpoint');
      const expectedBytes = providerHeaders(response, metered.cap);
      if (!response.body) {
        if (expectedBytes !== undefined && expectedBytes !== 0)
          throw new LiveTransportError('incompatible');
        finish('completed', true);
        return response;
      }
      const activeReader = response.body.getReader();
      reader = activeReader;
      const body = new ReadableStream<Uint8Array>(
        {
          start(current) {
            streamController = current;
          },
          async pull(current) {
            if (metered.finished()) return;
            try {
              metered.gate();
              const chunk = await abortRace(activeReader.read(), controller.signal);
              if (metered.finished()) return;
              metered.gate();
              if (chunk.done) {
                if (expectedBytes !== undefined && expectedBytes !== metered.receipt.observedBytes)
                  throw new LiveTransportError('incompatible');
                finish('completed', true);
                current.close();
                return;
              }
              metered.receipt.observedBytes += chunk.value.byteLength;
              if (metered.receipt.observedBytes > metered.cap)
                throw new LiveTransportError('too-large');
              current.enqueue(chunk.value);
            } catch (error) {
              const safe =
                error instanceof LiveTransportError ? error : new LiveTransportError('network');
              controller.abort();
              cancelReader();
              try {
                finish(safe.reason === 'cancelled' ? 'cancelled' : 'failed', false, safe.reason);
              } catch {}
              try {
                current.error(safe);
              } catch {}
            }
          },
          cancel() {
            if (metered.finished()) return;
            controller.abort();
            cancelReader();
            finish('cancelled', false, 'cancelled');
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const safe =
        error instanceof LiveTransportError
          ? error
          : new LiveTransportError(controller.signal.aborted ? 'cancelled' : 'network');
      controller.abort();
      cancelReader();
      if (received) cancelBody(received);
      try {
        finish(
          safe.reason === 'cancelled' ? 'cancelled' : 'failed',
          !metered.receipt.transportAttempted,
          safe.reason,
        );
      } catch {}
      throw safe;
    }
  }) as typeof fetch;
  return { fetch: wrapped, receipts: () => snapshots(receipts), transportMode };
}

export function createBudgetedWebClient(options: {
  ledger: LiveBudgetLedger;
  caseId: () => string;
  apiKey: string;
  dependencies?: Partial<WebDependencies>;
  beforeDispatch?: LiveDispatchGuard;
}): {
  client: WebClient;
  receipts(): readonly LiveTransportReceipt[];
  transportMode: 'production-default' | 'offline-injected';
} {
  const ledger = options.ledger;
  const caseId = options.caseId;
  const dependencies = options.dependencies === undefined ? undefined : { ...options.dependencies };
  const beforeDispatch = options.beforeDispatch;
  const receipts: MutableReceipt[] = [];
  const contexts = new AsyncLocalStorage<{
    kind: 'search' | 'page';
    caseId: string;
    rawCalls: number;
    signal?: AbortSignal;
  }>();
  const rawTransport = dependencies?.transport ?? pinnedHttpsTransport;
  const transport: WebTransport = async (input) => {
    const context = contexts.getStore();
    if (!context) throw new LiveTransportError('endpoint');
    if (input.signal.aborted) throw new LiveTransportError('cancelled');
    const redirect = context.rawCalls++ > 0;
    const metered = start(ledger, receipts, {
      caseId: context.caseId,
      kind: context.kind,
      redirect,
      requestedBytes: input.maxBytes,
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(
      () => {
        try {
          ledger.abort();
        } catch {}
        controller.abort();
      },
      Math.min(metered.remainingMs, 2_147_483_647),
    );
    let response: WebTransportResponse;
    try {
      if (controller.signal.aborted) {
        metered.finish('cancelled', true, 'cancelled');
        throw new LiveTransportError('cancelled');
      }
      if (beforeDispatch)
        await guardedDispatch(
          beforeDispatch,
          {
            caseId: context.caseId,
            kind: context.kind,
            stage: 'transport',
            redirect,
            reservedBytes: metered.cap,
          },
          controller.signal,
        );
      metered.gate();
      metered.receipt.transportAttempted = true;
      response = await abortRace(
        Promise.resolve(
          rawTransport({ ...input, signal: controller.signal, maxBytes: metered.cap }),
        ),
        controller.signal,
      );
      metered.gate();
      if (response.body instanceof Uint8Array)
        metered.receipt.observedBytes = response.body.byteLength;
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
        metered.receipt.status = response.status;
      validateTransportBody(response, { maxBytes: metered.cap });
      const length = response.headers['content-length'];
      if (length !== undefined && Number(length) !== response.body.byteLength)
        throw new LiveTransportError('incompatible');
      metered.finish('completed', true);
      return response;
    } catch (error) {
      const safe =
        error instanceof LiveTransportError
          ? error
          : error instanceof WebError && error.code === 'too-large'
            ? new LiveTransportError('too-large')
            : error instanceof WebError &&
                ['incompatible', 'unsupported-content'].includes(error.code)
              ? new LiveTransportError('incompatible')
              : new LiveTransportError(controller.signal.aborted ? 'cancelled' : 'network');
      try {
        metered.finish(
          safe.reason === 'cancelled' ? 'cancelled' : 'failed',
          !metered.receipt.transportAttempted,
          safe.reason,
        );
      } catch {}
      throw safe;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
    }
  };
  const actual = new BraveWebClient(
    { apiKey: options.apiKey },
    {
      resolve: async (hostname) => {
        available(ledger);
        const context = contexts.getStore();
        if (!context?.signal) throw new LiveTransportError('endpoint');
        if (beforeDispatch)
          await guardedDispatch(
            beforeDispatch,
            {
              caseId: context.caseId,
              kind: context.kind,
              stage: 'resolve',
              redirect: context.rawCalls > 0,
              reservedBytes: 0,
            },
            context.signal,
          );
        available(ledger);
        if (context.signal.aborted) throw new LiveTransportError('cancelled');
        return (dependencies?.resolve ?? systemResolver)(hostname);
      },
      transport,
      ...(dependencies?.now ? { now: dependencies.now } : {}),
    },
  );
  const client: WebClient = {
    search(query, requestOptions) {
      return contexts.run({ kind: 'search', caseId: caseId(), rawCalls: 0 }, async () => {
        const scope = boundedScope(ledger, requestOptions?.signal);
        const context = contexts.getStore();
        if (context) context.signal = scope.signal;
        try {
          return await actual.search(query, { ...requestOptions, signal: scope.signal });
        } finally {
          scope.dispose();
        }
      });
    },
    fetchPage(url, requestOptions) {
      return contexts.run({ kind: 'page', caseId: caseId(), rawCalls: 0 }, async () => {
        const scope = boundedScope(ledger, requestOptions?.signal);
        const context = contexts.getStore();
        if (context) context.signal = scope.signal;
        try {
          return await actual.fetchPage(url, { ...requestOptions, signal: scope.signal });
        } finally {
          scope.dispose();
        }
      });
    },
  };
  return {
    client,
    receipts: () => snapshots(receipts),
    transportMode: dependencies === undefined ? 'production-default' : 'offline-injected',
  };
}
