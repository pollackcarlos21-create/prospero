import { makeSource, plainSnippet, extractHtml } from './content';
import { WebError } from './errors';
import {
  canonicalPublicUrl,
  pinnedHttpsTransport,
  resolvePublicAddress,
  systemResolver,
  validateTransportBody,
} from './network';
import type {
  WebClient,
  WebDependencies,
  WebSource,
  WebTransportResponse,
  WebRequestOptions,
  WebSearchOptions,
} from './types';

export { WebError, type WebErrorCode } from './errors';
export { canonicalPublicUrl, isPublicAddress } from './network';
export { resolveCitation, sourceForModel, type SourceCitation } from './content';
export type {
  WebClient,
  WebDependencies,
  WebSource,
  WebAddress,
  WebResolver,
  WebTransport,
  WebTransportRequest,
  WebTransportResponse,
  WebRequestOptions,
  WebSearchOptions,
} from './types';

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const PAGE_HEADERS = Object.freeze({
  Accept: 'text/html',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Prospero/0.2',
});

export interface BraveWebConfig {
  /** Only main may decrypt/pass this credential. It never reaches page fetches. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export type TavilyWebConfig = BraveWebConfig;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new WebError('cancelled'));
    };
    // Observe both branches even for an already aborted request.
    promise.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(new WebError('cancelled'));
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function scope(external: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timeout =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 30_000)
      : 15_000;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeout);
  return {
    signal: controller.signal,
    error(error: unknown): WebError {
      if (expired) return new WebError('timeout');
      if (controller.signal.aborted) return new WebError('cancelled');
      return error instanceof WebError ? error : new WebError('network');
    },
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}

function successful(response: WebTransportResponse, searching = false): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new WebError(
    searching && [401, 403].includes(response.status)
      ? 'auth'
      : response.status === 429
        ? 'rate-limit'
        : response.status >= 500
          ? 'server'
          : 'http',
  );
}

function decodeBody(response: WebTransportResponse): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new WebError('incompatible');
  }
}

function responseLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new WebError('invalid-input');
  return value;
}

/** Independent networking adapter; no renderer, Electron, filesystem, storage or ModelPort. */
abstract class SafeWebClient implements WebClient {
  protected readonly dependencies: WebDependencies;
  protected readonly apiKey: string;
  constructor(
    protected readonly config: BraveWebConfig = {},
    dependencies: Partial<WebDependencies> = {},
  ) {
    this.apiKey = config.apiKey?.trim() ?? '';
    if (this.apiKey && !/^[\x21-\x7e]{8,4096}$/.test(this.apiKey))
      throw new WebError('invalid-input');
    this.dependencies = {
      resolve: dependencies.resolve ?? systemResolver,
      transport: dependencies.transport ?? pinnedHttpsTransport,
      now: dependencies.now ?? (() => new Date()),
    };
  }

  protected async request(
    url: URL,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>>,
    maxBytes: number,
    body?: Uint8Array,
  ): Promise<WebTransportResponse> {
    if (signal.aborted) throw new WebError('cancelled');
    canonicalPublicUrl(url.href);
    const address = await withAbort(resolvePublicAddress(url, this.dependencies.resolve), signal);
    if (signal.aborted) throw new WebError('cancelled');
    const input = {
      url,
      address,
      signal,
      headers,
      maxBytes,
      ...(body === undefined ? {} : { method: 'POST' as const, body }),
    };
    const response = await withAbort(this.dependencies.transport(input), signal);
    validateTransportBody(response, input);
    return response;
  }

  abstract search(query: string, options?: WebSearchOptions): Promise<readonly WebSource[]>;

  async fetchPage(value: string, options: WebRequestOptions = {}): Promise<WebSource> {
    let url = new URL(canonicalPublicUrl(value));
    const maxBytes = responseLimit(options.maxResponseBytes, MAX_PAGE_BYTES);
    const requestScope = scope(options.signal, this.config.timeoutMs);
    try {
      let remainingBytes = maxBytes;
      const seen = new Set<string>();
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        if (seen.has(url.href)) throw new WebError('redirect-limit');
        seen.add(url.href);
        const response = await this.request(url, requestScope.signal, PAGE_HEADERS, remainingBytes);
        remainingBytes -= response.body.byteLength;
        options.onResponseBytes?.(response.body.byteLength);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;
          if (!location || redirects === MAX_REDIRECTS) throw new WebError('redirect-limit');
          let next: string;
          try {
            next = new URL(location, url).href;
          } catch {
            throw new WebError('blocked-url');
          }
          url = new URL(canonicalPublicUrl(next));
          continue;
        }
        successful(response);
        const type = response.headers['content-type'] ?? '';
        if (!/^text\/html(?:\s*;|$)/i.test(type)) throw new WebError('unsupported-content');
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1];
        if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset.toLowerCase()))
          throw new WebError('unsupported-content');
        const { title, content } = extractHtml(decodeBody(response));
        return makeSource({
          url: url.href,
          title,
          content,
          kind: 'page',
          retrievedAt: this.dependencies.now().toISOString(),
        });
      }
      throw new WebError('redirect-limit');
    } catch (error) {
      throw requestScope.error(error);
    } finally {
      requestScope.dispose();
    }
  }
}

export class BraveWebClient extends SafeWebClient {
  async search(query: string, options: WebSearchOptions = {}): Promise<readonly WebSource[]> {
    const count = options.maxResults ?? 5;
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 600 ||
      query.trim().split(/\s+/).length > 75 ||
      [...query].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 20
    )
      throw new WebError('invalid-input');
    if (!this.apiKey) throw new WebError('auth');
    const maxBytes = responseLimit(options.maxResponseBytes, MAX_SEARCH_BYTES);
    const requestScope = scope(options.signal, this.config.timeoutMs);
    try {
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      url.searchParams.set('q', query.trim());
      url.searchParams.set('count', String(count));
      url.searchParams.set('result_filter', 'web');
      url.searchParams.set('text_decorations', 'false');
      const response = await this.request(
        url,
        requestScope.signal,
        {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Prospero/0.2',
          'X-Subscription-Token': this.apiKey,
        },
        maxBytes,
      );
      options.onResponseBytes?.(response.body.byteLength);
      // Search never redirects: the credential is bound to one fixed endpoint.
      successful(response, true);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? ''))
        throw new WebError('incompatible');
      const text = decodeBody(response);
      if (text.includes(this.apiKey) || text.includes(JSON.stringify(this.apiKey).slice(1, -1)))
        throw new WebError('incompatible');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new WebError('incompatible');
      }
      if (!record(data) || data.type !== 'search') throw new WebError('incompatible');
      if (data.web === undefined || data.web === null) return Object.freeze([]);
      if (!record(data.web) || !Array.isArray(data.web.results)) throw new WebError('incompatible');
      const retrievedAt = this.dependencies.now().toISOString();
      const sources: WebSource[] = [];
      const seen = new Set<string>();
      for (const result of data.web.results.slice(0, 40)) {
        if (!record(result) || typeof result.url !== 'string' || typeof result.title !== 'string')
          throw new WebError('incompatible');
        if (
          result.description !== undefined &&
          result.description !== null &&
          typeof result.description !== 'string'
        )
          throw new WebError('incompatible');
        let resultUrl: string;
        try {
          resultUrl = canonicalPublicUrl(result.url);
        } catch {
          // Brave can return HTTP/private results; never upgrade or fetch them implicitly.
          continue;
        }
        if (seen.has(resultUrl)) continue;
        const title = plainSnippet(result.title, 300);
        const content = plainSnippet(
          typeof result.description === 'string' ? result.description : '',
          4000,
        );
        if (title.includes(this.apiKey) || content.includes(this.apiKey))
          throw new WebError('incompatible');
        sources.push(makeSource({ url: resultUrl, title, content, kind: 'search', retrievedAt }));
        seen.add(resultUrl);
        if (sources.length >= count) break;
      }
      return Object.freeze(sources);
    } catch (error) {
      throw requestScope.error(error);
    } finally {
      requestScope.dispose();
    }
  }
}

/** Tavily discovery only; fetched page evidence still uses Prospero's own safe GET path. */
export class TavilyWebClient extends SafeWebClient {
  async search(query: string, options: WebSearchOptions = {}): Promise<readonly WebSource[]> {
    const count = options.maxResults ?? 5;
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 600 ||
      query.trim().split(/\s+/).length > 75 ||
      [...query].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 20
    )
      throw new WebError('invalid-input');
    if (!this.apiKey) throw new WebError('auth');
    const maxBytes = responseLimit(options.maxResponseBytes, MAX_SEARCH_BYTES);
    const requestScope = scope(options.signal, this.config.timeoutMs);
    try {
      const body = new TextEncoder().encode(
        JSON.stringify({
          query: query.trim(),
          search_depth: 'basic',
          max_results: count,
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
        }),
      );
      const response = await this.request(
        new URL(TAVILY_SEARCH_ENDPOINT),
        requestScope.signal,
        {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Type': 'application/json',
          'Content-Length': String(body.byteLength),
          'User-Agent': 'Prospero/0.2',
          Authorization: `Bearer ${this.apiKey}`,
        },
        maxBytes,
        body,
      );
      options.onResponseBytes?.(response.body.byteLength);
      // Never follow a search redirect or send this credential to returned result URLs.
      if ([432, 433].includes(response.status)) throw new WebError('rate-limit');
      successful(response, true);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? ''))
        throw new WebError('incompatible');
      const text = decodeBody(response);
      if (text.includes(this.apiKey) || text.includes(JSON.stringify(this.apiKey).slice(1, -1)))
        throw new WebError('incompatible');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new WebError('incompatible');
      }
      if (!record(data) || !Array.isArray(data.results)) throw new WebError('incompatible');
      const retrievedAt = this.dependencies.now().toISOString();
      const sources: WebSource[] = [];
      const seen = new Set<string>();
      for (const result of data.results.slice(0, 40)) {
        if (
          !record(result) ||
          typeof result.url !== 'string' ||
          typeof result.title !== 'string' ||
          typeof result.content !== 'string'
        )
          throw new WebError('incompatible');
        let resultUrl: string;
        try {
          resultUrl = canonicalPublicUrl(result.url);
        } catch {
          continue;
        }
        if (seen.has(resultUrl)) continue;
        const title = plainSnippet(result.title, 300);
        const content = plainSnippet(result.content, 4000);
        if (title.includes(this.apiKey) || content.includes(this.apiKey))
          throw new WebError('incompatible');
        sources.push(makeSource({ url: resultUrl, title, content, kind: 'search', retrievedAt }));
        seen.add(resultUrl);
        if (sources.length >= count) break;
      }
      return Object.freeze(sources);
    } catch (error) {
      throw requestScope.error(error);
    } finally {
      requestScope.dispose();
    }
  }
}
