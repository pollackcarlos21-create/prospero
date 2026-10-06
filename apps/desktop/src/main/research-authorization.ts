import { createHash, randomUUID } from 'node:crypto';
import { canonicalPublicUrl, type WebSource } from '@prospero/web';

export const RESEARCH_LIMITS = Object.freeze({
  maxQueries: 12,
  maxResults: 10,
  maxFetches: 24,
  maxLifetimeMs: 15 * 60_000,
  maxResponseBytes: 16 * 1024 * 1024,
  searchResponseBytes: 512 * 1024,
  fetchResponseBytes: 2 * 1024 * 1024,
});

export interface ResearchQuery {
  readonly query: string;
  readonly maxResults: number;
}

export interface ResearchAuthorizationInput {
  readonly conversationId: string;
  readonly executionId: string;
  readonly title: string;
  /** Exact queries approved by the user; source text cannot append or rewrite them. */
  readonly queries: readonly ResearchQuery[];
  readonly maxSearches: number;
  readonly maxFetches: number;
  readonly maxResponseBytes: number;
  readonly expiresAt: number;
}

export interface ResearchSnapshot extends ResearchAuthorizationInput {
  readonly version: 1;
  readonly id: string;
  readonly digest: string;
  readonly createdAt: number;
}

export type ResearchAuthorizationStatus =
  | 'prepared'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'closed';

export type ResearchAuthorizationErrorCode =
  | 'invalid-input'
  | 'snapshot-mismatch'
  | 'not-approved'
  | 'inactive'
  | 'expired'
  | 'scope-mismatch'
  | 'query-not-approved'
  | 'source-not-discovered'
  | 'limit'
  | 'replay'
  | 'invalid-receipt'
  | 'audit-failed';

const MESSAGES: Record<ResearchAuthorizationErrorCode, string> = {
  'invalid-input': 'The research authorization has invalid input.',
  'snapshot-mismatch': 'The research approval does not match the immutable snapshot.',
  'not-approved': 'This research snapshot has not been approved.',
  inactive: 'This research authorization is no longer active.',
  expired: 'This research authorization has expired.',
  'scope-mismatch': 'The research request belongs to a different task or execution.',
  'query-not-approved': 'This exact search query and result limit were not approved.',
  'source-not-discovered': 'Only sources returned by a successful approved search may be fetched.',
  limit: 'The research authorization budget has been reached.',
  replay: 'This research approval, query, source or request has already been used.',
  'invalid-receipt': 'The research result receipt is invalid.',
  'audit-failed': 'The research audit event could not be recorded safely.',
};

/** Errors intentionally exclude queries, URLs, response bodies and credentials. */
export class ResearchAuthorizationError extends Error {
  constructor(public readonly code: ResearchAuthorizationErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ResearchAuthorizationError';
  }
}

interface ResearchBinding {
  readonly conversationId: string;
  readonly executionId: string;
}

export interface ResearchReservation extends ResearchBinding {
  readonly id: string;
  readonly snapshotId: string;
  readonly digest: string;
  readonly kind: 'search' | 'fetch';
  readonly query?: string;
  readonly maxResults?: number;
  readonly sourceId?: string;
  readonly url?: string;
  readonly maxResponseBytes: number;
  readonly expiresAt: number;
}

export interface ResearchDiscoveredSource {
  readonly id: string;
  readonly url: string;
  readonly searchReservationId: string;
}

export interface ResearchAuthorizationUsage {
  readonly status: ResearchAuthorizationStatus;
  readonly searches: number;
  readonly fetches: number;
  readonly responseBytes: number;
  readonly reservedResponseBytes: number;
  readonly remainingResponseBytes: number;
}

export interface ResearchAuditEvent {
  readonly sequence: number;
  readonly at: number;
  readonly snapshotId: string;
  readonly digest: string;
  readonly type:
    | 'prepared'
    | 'decision'
    | 'reserved'
    | 'started'
    | 'completed'
    | 'failed'
    | 'revoked'
    | 'expired'
    | 'closed';
  readonly status: ResearchAuthorizationStatus;
  readonly decision?: 'allow-once' | 'deny';
  readonly reservationId?: string;
  readonly kind?: ResearchReservation['kind'];
  readonly sourceIds?: readonly string[];
  readonly responseBytes?: number;
  readonly maxResponseBytes?: number;
  readonly code?: ResearchAuthorizationErrorCode;
}

export interface ResearchAuthorizationDependencies {
  readonly now?: () => number;
  /** Synchronous main-owned audit callback. Throwing invalidates this authorization. */
  readonly onEvent?: (event: ResearchAuditEvent) => void;
}

function fail(code: ResearchAuthorizationErrorCode): never {
  throw new ResearchAuthorizationError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    ![...value].some((letter) => letter.charCodeAt(0) < 32 || letter.charCodeAt(0) === 127)
  );
}

function snapshot(inputValue: ResearchAuthorizationInput, now: number): ResearchSnapshot {
  let input: ResearchAuthorizationInput;
  try {
    // Copy once before validation so the approved fields cannot change between reads.
    input = structuredClone(inputValue);
  } catch {
    fail('invalid-input');
  }
  if (
    !exactKeys(input, [
      'conversationId',
      'executionId',
      'title',
      'queries',
      'maxSearches',
      'maxFetches',
      'maxResponseBytes',
      'expiresAt',
    ]) ||
    !boundedText(input.conversationId, 128) ||
    !boundedText(input.executionId, 128) ||
    !boundedText(input.title, 120) ||
    !Array.isArray(input.queries) ||
    !integer(input.queries.length, 1, RESEARCH_LIMITS.maxQueries) ||
    !integer(input.maxSearches, 1, input.queries.length) ||
    !integer(input.maxFetches, 0, RESEARCH_LIMITS.maxFetches) ||
    !integer(input.maxResponseBytes, 1, RESEARCH_LIMITS.maxResponseBytes) ||
    !integer(now, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(input.expiresAt, now + 1, now + RESEARCH_LIMITS.maxLifetimeMs)
  )
    fail('invalid-input');
  const seen = new Set<string>();
  const queries: ResearchQuery[] = [];
  for (const value of input.queries) {
    if (
      !exactKeys(value, ['query', 'maxResults']) ||
      !boundedText(value.query, 600) ||
      value.query.split(/\s+/).length > 75 ||
      !integer(value.maxResults, 1, RESEARCH_LIMITS.maxResults) ||
      seen.has(value.query)
    )
      fail('invalid-input');
    seen.add(value.query);
    queries.push(Object.freeze({ query: value.query, maxResults: value.maxResults }));
  }
  const value = {
    version: 1 as const,
    id: randomUUID(),
    conversationId: input.conversationId,
    executionId: input.executionId,
    title: input.title,
    createdAt: now,
    expiresAt: input.expiresAt,
    queries: Object.freeze(queries),
    maxSearches: input.maxSearches,
    maxFetches: input.maxFetches,
    maxResponseBytes: input.maxResponseBytes,
  };
  const digest = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  return Object.freeze({ ...value, digest });
}

interface PendingReservation {
  readonly reservation: ResearchReservation;
  started: boolean;
  settled: boolean;
}

/**
 * Ephemeral main-owned authority for one execution. It has no network, credential,
 * filesystem, shell or storage port. A serialized snapshot is preview data, never
 * a restorable grant; only this instance's opaque reservations have authority.
 */
export class ResearchAuthorization {
  readonly snapshot: ResearchSnapshot;
  #status: ResearchAuthorizationStatus = 'prepared';
  #searches = 0;
  #fetches = 0;
  #responseBytes = 0;
  #reservedResponseBytes = 0;
  #queriesUsed = new Set<string>();
  #urlsUsed = new Set<string>();
  #sources = new Map<string, ResearchDiscoveredSource>();
  #pending = new WeakMap<ResearchReservation, PendingReservation>();
  #events: ResearchAuditEvent[] = [];
  #now: () => number;
  #onEvent?: (event: ResearchAuditEvent) => void;

  constructor(
    input: ResearchAuthorizationInput,
    dependencies: ResearchAuthorizationDependencies = {},
  ) {
    this.#now = dependencies.now ?? Date.now;
    this.#onEvent = dependencies.onEvent;
    this.snapshot = snapshot(input, this.#now());
    this.#emit({ type: 'prepared' });
    // Prevent replacing the public snapshot while private execution state remains mutable.
    Object.freeze(this);
  }

  #time(): number {
    const now = this.#now();
    if (!integer(now, this.snapshot.createdAt, Number.MAX_SAFE_INTEGER)) {
      this.#status = 'revoked';
      this.#sources.clear();
      fail('inactive');
    }
    return now;
  }

  #emit(
    value: Omit<ResearchAuditEvent, 'sequence' | 'at' | 'snapshotId' | 'digest' | 'status'>,
  ): void {
    const event: ResearchAuditEvent = Object.freeze({
      ...value,
      ...(value.sourceIds ? { sourceIds: Object.freeze([...value.sourceIds]) } : {}),
      sequence: this.#events.length + 1,
      at: this.#time(),
      snapshotId: this.snapshot.id,
      digest: this.snapshot.digest,
      status: this.#status,
    });
    this.#events.push(event);
    try {
      this.#onEvent?.(event);
    } catch {
      this.#status = 'revoked';
      this.#sources.clear();
      fail('audit-failed');
    }
  }

  #expire(): void {
    if (this.#status === 'prepared' || this.#status === 'approved') {
      if (this.#time() >= this.snapshot.expiresAt) {
        this.#status = 'expired';
        this.#sources.clear();
        this.#emit({ type: 'expired' });
      }
    }
  }

  #active(): void {
    this.#expire();
    if (this.#status === 'expired') fail('expired');
    if (this.#status === 'prepared') fail('not-approved');
    if (this.#status !== 'approved') fail('inactive');
  }

  #binding(input: ResearchBinding): void {
    if (
      input.conversationId !== this.snapshot.conversationId ||
      input.executionId !== this.snapshot.executionId
    )
      fail('scope-mismatch');
  }

  decide(input: {
    readonly snapshotId: string;
    readonly digest: string;
    readonly decision: 'allow-once' | 'deny';
  }): void {
    this.#expire();
    if (!exactKeys(input, ['snapshotId', 'digest', 'decision'])) fail('invalid-input');
    if (input.snapshotId !== this.snapshot.id || input.digest !== this.snapshot.digest)
      fail('snapshot-mismatch');
    if (this.#status === 'expired') fail('expired');
    if (this.#status !== 'prepared') fail('replay');
    if (input.decision !== 'allow-once' && input.decision !== 'deny') fail('invalid-input');
    this.#status = input.decision === 'allow-once' ? 'approved' : 'denied';
    this.#emit({ type: 'decision', decision: input.decision });
  }

  #reserve(
    value: Pick<ResearchReservation, 'kind' | 'query' | 'maxResults' | 'sourceId' | 'url'>,
  ): ResearchReservation {
    const remaining =
      this.snapshot.maxResponseBytes - this.#responseBytes - this.#reservedResponseBytes;
    if (remaining <= 0) fail('limit');
    const maximum =
      value.kind === 'search'
        ? RESEARCH_LIMITS.searchResponseBytes
        : RESEARCH_LIMITS.fetchResponseBytes;
    const reservation: ResearchReservation = Object.freeze({
      ...value,
      id: randomUUID(),
      snapshotId: this.snapshot.id,
      digest: this.snapshot.digest,
      conversationId: this.snapshot.conversationId,
      executionId: this.snapshot.executionId,
      maxResponseBytes: Math.min(remaining, maximum),
      expiresAt: this.snapshot.expiresAt,
    });
    this.#pending.set(reservation, { reservation, started: false, settled: false });
    this.#reservedResponseBytes += reservation.maxResponseBytes;
    if (reservation.kind === 'search') {
      this.#searches += 1;
      this.#queriesUsed.add(reservation.query ?? '');
    } else {
      this.#fetches += 1;
      this.#urlsUsed.add(reservation.url ?? '');
    }
    this.#emit({
      type: 'reserved',
      reservationId: reservation.id,
      kind: reservation.kind,
      maxResponseBytes: reservation.maxResponseBytes,
    });
    this.#active();
    return reservation;
  }

  reserveSearch(
    input: ResearchBinding & { readonly query: string; readonly maxResults?: number },
  ): ResearchReservation {
    this.#active();
    if (
      !record(input) ||
      Object.keys(input).some(
        (key) => !['conversationId', 'executionId', 'query', 'maxResults'].includes(key),
      )
    )
      fail('invalid-input');
    this.#binding(input);
    const query = this.snapshot.queries.find((value) => value.query === input.query);
    if (!query) fail('query-not-approved');
    const maxResults = input.maxResults ?? query.maxResults;
    if (!integer(maxResults, 1, query.maxResults)) fail('query-not-approved');
    if (this.#queriesUsed.has(query.query)) fail('replay');
    if (this.#searches >= this.snapshot.maxSearches) fail('limit');
    return this.#reserve({ kind: 'search', query: query.query, maxResults });
  }

  reserveFetch(input: ResearchBinding & { readonly sourceId: string }): ResearchReservation {
    this.#active();
    if (!exactKeys(input, ['conversationId', 'executionId', 'sourceId'])) fail('invalid-input');
    this.#binding(input);
    const source = this.#sources.get(input.sourceId);
    if (!source) fail('source-not-discovered');
    if (this.#urlsUsed.has(source.url)) fail('replay');
    if (this.#fetches >= this.snapshot.maxFetches) fail('limit');
    return this.#reserve({ kind: 'fetch', sourceId: source.id, url: source.url });
  }

  #reservation(value: ResearchReservation, kind?: ResearchReservation['kind']): PendingReservation {
    const pending = record(value)
      ? this.#pending.get(value as unknown as ResearchReservation)
      : undefined;
    if (!pending || pending.reservation !== value || (kind && value.kind !== kind))
      fail('invalid-receipt');
    if (pending.settled) fail('replay');
    return pending;
  }

  /**
   * Call immediately before I/O, after any prepare/approval wait. This consumes the
   * reservation's sole dispatch permission; a second dispatch is always rejected.
   * A started event is authorization to dispatch, not proof that HTTP succeeded.
   */
  validateReservation(
    reservation: ResearchReservation,
    binding?: ResearchBinding,
  ): ResearchReservation {
    const pending = this.#reservation(reservation);
    this.#active();
    if (binding !== undefined) {
      if (!exactKeys(binding, ['conversationId', 'executionId'])) fail('invalid-input');
      this.#binding(binding);
    }
    if (pending.started) fail('replay');
    pending.started = true;
    this.#emit({ type: 'started', reservationId: reservation.id, kind: reservation.kind });
    this.#active();
    return reservation;
  }

  #startedReservation(
    reservation: ResearchReservation,
    kind: ResearchReservation['kind'],
  ): PendingReservation {
    const pending = this.#reservation(reservation, kind);
    if (!pending.started) fail('invalid-receipt');
    return pending;
  }

  #settle(pending: PendingReservation, bytes: number): void {
    if (!integer(bytes, 0, pending.reservation.maxResponseBytes)) {
      // An adapter violating its pre-request cap cannot gain more research authority.
      pending.settled = true;
      this.#reservedResponseBytes -= pending.reservation.maxResponseBytes;
      this.#responseBytes += pending.reservation.maxResponseBytes;
      this.#status = 'revoked';
      this.#sources.clear();
      this.#emit({
        type: 'failed',
        reservationId: pending.reservation.id,
        kind: pending.reservation.kind,
        code: 'invalid-receipt',
      });
      fail('invalid-receipt');
    }
    pending.settled = true;
    this.#reservedResponseBytes -= pending.reservation.maxResponseBytes;
    this.#responseBytes += bytes;
  }

  #acceptResult(reservation: ResearchReservation, responseBytes: number): void {
    try {
      this.#active();
    } catch (error) {
      // A late receipt still accounts for the real request; it grants no new sources.
      this.#emit({
        type: 'failed',
        reservationId: reservation.id,
        kind: reservation.kind,
        responseBytes,
        code: error instanceof ResearchAuthorizationError ? error.code : 'inactive',
      });
      throw error;
    }
  }

  /** Only call with an actual successful SearchPort result, never model or page data. */
  recordDiscoveredSources(
    reservation: ResearchReservation,
    sources: readonly Pick<WebSource, 'id' | 'url' | 'kind'>[],
    responseBytes: number,
  ): readonly ResearchDiscoveredSource[] {
    const pending = this.#startedReservation(reservation, 'search');
    this.#settle(pending, responseBytes);
    this.#acceptResult(reservation, responseBytes);
    const discovered: ResearchDiscoveredSource[] = [];
    try {
      if (!Array.isArray(sources) || sources.length > (reservation.maxResults ?? 0))
        fail('invalid-receipt');
      const seenIds = new Set<string>();
      const seenUrls = new Set<string>();
      for (const source of sources) {
        if (
          !record(source) ||
          typeof source.id !== 'string' ||
          !/^src_[a-f0-9]{24}$/.test(source.id) ||
          typeof source.url !== 'string' ||
          source.kind !== 'search'
        )
          fail('invalid-receipt');
        const url = canonicalPublicUrl(source.url);
        const previous = this.#sources.get(source.id);
        if (seenIds.has(source.id) || seenUrls.has(url) || (previous && previous.url !== url))
          fail('invalid-receipt');
        seenIds.add(source.id);
        seenUrls.add(url);
        discovered.push(Object.freeze({ id: source.id, url, searchReservationId: reservation.id }));
      }
    } catch {
      this.#emit({
        type: 'failed',
        reservationId: reservation.id,
        kind: 'search',
        responseBytes,
        code: 'invalid-receipt',
      });
      fail('invalid-receipt');
    }
    for (const source of discovered) this.#sources.set(source.id, source);
    this.#emit({
      type: 'completed',
      reservationId: reservation.id,
      kind: 'search',
      responseBytes,
      sourceIds: discovered.map((source) => source.id),
    });
    return Object.freeze(discovered);
  }

  completeFetch(reservation: ResearchReservation, responseBytes: number): void {
    const pending = this.#startedReservation(reservation, 'fetch');
    this.#settle(pending, responseBytes);
    this.#acceptResult(reservation, responseBytes);
    this.#emit({
      type: 'completed',
      reservationId: reservation.id,
      kind: 'fetch',
      responseBytes,
      sourceIds: [reservation.sourceId ?? ''],
    });
  }

  /** Failed/cancelled attempts consume their one-time request even when no result exists. */
  fail(reservation: ResearchReservation, responseBytes?: number): void {
    const pending = this.#reservation(reservation);
    const charged = responseBytes ?? reservation.maxResponseBytes;
    this.#settle(pending, charged);
    this.#expire();
    this.#emit({
      type: 'failed',
      reservationId: reservation.id,
      kind: reservation.kind,
      responseBytes: charged,
    });
  }

  revoke(): void {
    if (this.#status === 'closed' || this.#status === 'revoked') return;
    this.#status = 'revoked';
    this.#sources.clear();
    this.#emit({ type: 'revoked' });
  }

  close(): void {
    if (this.#status === 'closed') return;
    this.#status = 'closed';
    this.#sources.clear();
    this.#emit({ type: 'closed' });
  }

  usage(): ResearchAuthorizationUsage {
    this.#expire();
    return Object.freeze({
      status: this.#status,
      searches: this.#searches,
      fetches: this.#fetches,
      responseBytes: this.#responseBytes,
      reservedResponseBytes: this.#reservedResponseBytes,
      remainingResponseBytes: Math.max(
        0,
        this.snapshot.maxResponseBytes - this.#responseBytes - this.#reservedResponseBytes,
      ),
    });
  }

  events(): readonly ResearchAuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}

export function createResearchAuthorization(
  input: ResearchAuthorizationInput,
  dependencies: ResearchAuthorizationDependencies = {},
): ResearchAuthorization {
  return new ResearchAuthorization(input, dependencies);
}
