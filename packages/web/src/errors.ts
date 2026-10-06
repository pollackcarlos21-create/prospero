export type WebErrorCode =
  | 'invalid-input'
  | 'blocked-url'
  | 'blocked-address'
  | 'redirect-limit'
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'http'
  | 'unsupported-content'
  | 'too-large'
  | 'incompatible'
  | 'network'
  | 'timeout'
  | 'cancelled';

const MESSAGES: Record<WebErrorCode, string> = {
  'invalid-input': 'The web request has invalid input.',
  'blocked-url': 'Only public HTTPS URLs without credentials are allowed.',
  'blocked-address': 'The website resolves to an address that is not public.',
  'redirect-limit': 'The website redirected too many times.',
  auth: 'The search credential was rejected. Check Web Search settings.',
  'rate-limit': 'The search service rate limit was reached. Try again later.',
  server: 'The web service is temporarily unavailable.',
  http: 'The website did not return a successful response.',
  'unsupported-content': 'This website does not provide supported HTML content.',
  'too-large': 'The web response exceeds the supported size limit.',
  incompatible: 'The web service returned an incompatible response.',
  network: 'The web request could not connect securely.',
  timeout: 'The web request timed out.',
  cancelled: 'The web request was cancelled.',
};

/** Never retain a server response, credential, URL, or DNS error in public errors. */
export class WebError extends Error {
  constructor(public readonly code: WebErrorCode) {
    super(MESSAGES[code]);
    this.name = 'WebError';
  }
}
