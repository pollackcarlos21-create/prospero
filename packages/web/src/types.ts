export interface WebSource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly kind: 'search' | 'page';
  readonly retrievedAt: string;
  readonly contentHash: string;
  readonly excerpt: string;
  /** Untrusted external text. Main owns its short-lived retention. */
  readonly content: string;
  readonly trust: 'untrusted';
}

export interface WebRequestOptions {
  readonly signal?: AbortSignal;
  /** Main-owned response-body budget, enforced while streaming before extraction. */
  readonly maxResponseBytes?: number;
  /** Body byte receipt for each complete response, including redirects. */
  readonly onResponseBytes?: (bytes: number) => void;
}
export interface WebSearchOptions extends WebRequestOptions {
  readonly maxResults?: number;
}
export interface WebClient {
  search(query: string, options?: WebSearchOptions): Promise<readonly WebSource[]>;
  fetchPage(url: string, options?: WebRequestOptions): Promise<WebSource>;
}

export interface WebAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebResolver = (hostname: string) => Promise<readonly WebAddress[]>;

export interface WebTransportRequest {
  readonly url: URL;
  readonly address: WebAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  /** Main-owned only. Page reads and existing callers always default to GET. */
  readonly method?: 'GET' | 'POST';
  /** Only fixed-endpoint search POSTs have a bounded JSON request body. */
  readonly body?: Uint8Array;
}

export interface WebTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

/** A main-owned test seam; production always uses DNS-validated pinned HTTPS. */
export type WebTransport = (request: WebTransportRequest) => Promise<WebTransportResponse>;

export interface WebDependencies {
  readonly resolve: WebResolver;
  readonly transport: WebTransport;
  readonly now: () => Date;
}
