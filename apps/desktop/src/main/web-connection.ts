import { WebError, type WebClient, type WebErrorCode } from '@prospero/web';
import type { ConnectionResult, WebSearchProvider } from '../bridge';

const PROBE_QUERY = 'Prospero web search';
const STATUS: Record<WebErrorCode, ConnectionResult['status']> = {
  'invalid-input': 'incompatible',
  'blocked-url': 'network',
  'blocked-address': 'network',
  'redirect-limit': 'network',
  auth: 'auth',
  'rate-limit': 'rate-limit',
  server: 'server',
  http: 'network',
  'unsupported-content': 'incompatible',
  'too-large': 'incompatible',
  incompatible: 'incompatible',
  network: 'network',
  timeout: 'timeout',
  cancelled: 'cancelled',
};
function result(status: ConnectionResult['status'], provider: WebSearchProvider): ConnectionResult {
  const label = provider === 'tavily' ? 'Tavily' : 'Brave Search';
  const messages: Record<ConnectionResult['status'], string> = {
    connected: `Connected to ${label}. The test used one search request.`,
    auth: `The search credential was rejected. Enter or replace the ${label} key.`,
    'rate-limit': `${label} rate limit reached. Wait before testing again.`,
    server: `${label} is temporarily unavailable. Try again later.`,
    incompatible: `${label} returned an incompatible response.`,
    network: `Could not connect securely to ${label}. Check the connection and try again.`,
    timeout: `The ${label} connection test timed out.`,
    cancelled: `The ${label} connection test was cancelled.`,
  };
  return { status, message: messages[status] };
}

/** Main-only probe: fixed query, one request, no settings writes or retained sources. */
export async function testWebSearchConnection(
  apiKey: string,
  webFactory: (apiKey: string) => WebClient,
  options: { signal?: AbortSignal; timeoutMs?: number; provider?: WebSearchProvider } = {},
): Promise<ConnectionResult> {
  const provider = options.provider ?? 'brave';
  if (options.signal?.aborted) return result('cancelled', provider);
  if (!/^[\x21-\x7e]{8,4096}$/.test(apiKey)) return result('auth', provider);
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 30_000)
      : 15_000;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  let removeAbort = () => {};
  try {
    if (controller.signal.aborted) return result('cancelled', provider);
    const client = webFactory(apiKey);
    await new Promise<void>((resolve, reject) => {
      const stopped = () => reject(new WebError(expired ? 'timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', stopped, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', stopped);
      // Observe late completion/rejection even if an injected client ignores cancellation.
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw new WebError(expired ? 'timeout' : 'cancelled');
          return client.search(PROBE_QUERY, { signal: controller.signal, maxResults: 1 });
        })
        .then(() => resolve(), reject);
      if (controller.signal.aborted) stopped();
    });
    return result(
      controller.signal.aborted ? (expired ? 'timeout' : 'cancelled') : 'connected',
      provider,
    );
  } catch (error) {
    return result(
      expired
        ? 'timeout'
        : controller.signal.aborted
          ? 'cancelled'
          : error instanceof WebError
            ? STATUS[error.code]
            : 'network',
      provider,
    );
  } finally {
    clearTimeout(timer);
    removeAbort();
    options.signal?.removeEventListener('abort', abort);
  }
}
