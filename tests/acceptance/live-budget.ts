import { createHash, randomUUID } from 'node:crypto';

export type LiveRequestKind = 'provider' | 'search' | 'page';
export interface LiveBudgetLimits {
  provider: number;
  search: number;
  page: number;
  redirects: number;
  responseBodyBytes: number;
  wallClockMs: number;
}
export interface LiveBudgetInput {
  authorizationId: string;
  sourceSha256: string;
  buildSha256: string;
  journalSha256: string;
  caseIds: readonly string[];
  createdAt: number;
  expiresAt: number;
  limits: LiveBudgetLimits;
}
export interface LiveBudgetManifest extends LiveBudgetInput {
  readonly authorizationId: string;
  readonly sourceSha256: string;
  readonly buildSha256: string;
  readonly journalSha256: string;
  readonly caseIds: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly limits: Readonly<LiveBudgetLimits>;
}
type Failure =
  | 'manifest'
  | 'authorization'
  | 'identity'
  | 'expired'
  | 'quota'
  | 'reservation'
  | 'receipt'
  | 'journal'
  | 'suspended'
  | 'closed';
export class LiveBudgetError extends Error {
  constructor(readonly reason: Failure) {
    super(`Live acceptance budget rejected the operation: ${reason}.`);
  }
}
const inputKeys = [
  'authorizationId',
  'sourceSha256',
  'buildSha256',
  'journalSha256',
  'caseIds',
  'createdAt',
  'expiresAt',
  'limits',
];
const limitKeys = ['provider', 'search', 'page', 'redirects', 'responseBodyBytes', 'wallClockMs'];
const caseIds = new Set(
  ['W', 'F', 'C'].flatMap((prefix) =>
    Array.from({ length: 10 }, (_, index) => prefix + String(index + 1).padStart(2, '0')),
  ),
);
function keys(value: unknown, expected: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  )
    throw new LiveBudgetError('manifest');
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
export function createLiveBudgetManifest(input: LiveBudgetInput): LiveBudgetManifest {
  keys(input, inputKeys);
  keys(input.limits, limitKeys);
  if (
    typeof input.authorizationId !== 'string' ||
    typeof input.sourceSha256 !== 'string' ||
    typeof input.buildSha256 !== 'string' ||
    typeof input.journalSha256 !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(input.authorizationId) ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(input.buildSha256) ||
    !/^[a-f0-9]{64}$/.test(input.journalSha256) ||
    !Array.isArray(input.caseIds) ||
    !input.caseIds.length ||
    input.caseIds.some((id) => !caseIds.has(id)) ||
    new Set(input.caseIds).size !== input.caseIds.length ||
    !integer(input.createdAt, 1) ||
    !integer(input.expiresAt, 1) ||
    input.expiresAt <= input.createdAt ||
    limitKeys.some((key) => !integer(input.limits[key as keyof LiveBudgetLimits])) ||
    !input.limits.wallClockMs ||
    !Number.isSafeInteger(input.createdAt + input.limits.wallClockMs)
  )
    throw new LiveBudgetError('manifest');
  const value = {
    schemaVersion: 1 as const,
    authorizationId: input.authorizationId,
    sourceSha256: input.sourceSha256,
    buildSha256: input.buildSha256,
    journalSha256: input.journalSha256,
    caseIds: Object.freeze([...input.caseIds].sort()),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    limits: Object.freeze({
      provider: input.limits.provider,
      search: input.limits.search,
      page: input.limits.page,
      redirects: input.limits.redirects,
      responseBodyBytes: input.limits.responseBodyBytes,
      wallClockMs: input.limits.wallClockMs,
    }),
  };
  return Object.freeze({
    ...value,
    digest: createHash('sha256')
      .update(`prospero-live-budget:v1\n${JSON.stringify(value)}`)
      .digest('hex'),
  });
}
export interface LiveBudgetPending {
  id: string;
  caseId: string;
  kind: LiveRequestKind;
  redirect: boolean;
  bytes: number;
  dispatched: boolean;
}
export interface LiveBudgetState {
  version: 1;
  requests: { provider: number; search: number; page: number; redirects: number };
  chargedBytes: number;
  reservedBytes: number;
  dispatched: number;
  settled: number;
  unknownReceipts: number;
  closed: boolean;
  clockFloor: number;
  pending: readonly LiveBudgetPending[];
}
export interface LiveBudgetJournal {
  readonly identitySha256: string;
  load(manifest: LiveBudgetManifest): { revision: number; state: LiveBudgetState } | undefined;
  commit(
    manifest: LiveBudgetManifest,
    expectedRevision: number,
    state: LiveBudgetState,
    event: 'reserved' | 'dispatch' | 'settled' | 'closed' | 'recovered',
  ): number;
}

export function validateBudgetState(state: LiveBudgetState, manifest: LiveBudgetManifest): void {
  try {
    keys(state, [
      'version',
      'requests',
      'chargedBytes',
      'reservedBytes',
      'dispatched',
      'settled',
      'unknownReceipts',
      'closed',
      'clockFloor',
      'pending',
    ]);
    keys(state.requests, ['provider', 'search', 'page', 'redirects']);
    const total = state.requests.provider + state.requests.search + state.requests.page;
    if (
      state.version !== 1 ||
      !Array.isArray(state.pending) ||
      typeof state.closed !== 'boolean' ||
      !Number.isFinite(state.clockFloor) ||
      state.clockFloor < manifest.createdAt ||
      state.clockFloor > Number.MAX_SAFE_INTEGER ||
      !integer(total) ||
      (['provider', 'search', 'page', 'redirects'] as const).some(
        (kind) => !integer(state.requests[kind]) || state.requests[kind] > manifest.limits[kind],
      ) ||
      state.requests.redirects > total ||
      [
        state.chargedBytes,
        state.reservedBytes,
        state.dispatched,
        state.settled,
        state.unknownReceipts,
      ].some((value) => !integer(value)) ||
      !integer(state.chargedBytes + state.reservedBytes) ||
      state.chargedBytes + state.reservedBytes > manifest.limits.responseBodyBytes ||
      state.dispatched > total ||
      state.settled + state.pending.length !== total ||
      state.unknownReceipts > state.settled ||
      state.unknownReceipts > state.dispatched ||
      (state.closed && state.pending.length > 0)
    )
      throw new LiveBudgetError('journal');
    const ids = new Set<string>();
    let reserved = 0;
    let dispatched = 0;
    const pendingCounts = { provider: 0, search: 0, page: 0, redirects: 0 };
    for (const entry of state.pending) {
      keys(entry, ['id', 'caseId', 'kind', 'redirect', 'bytes', 'dispatched']);
      if (
        typeof entry.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
        ids.has(entry.id) ||
        !manifest.caseIds.includes(entry.caseId) ||
        !['provider', 'search', 'page'].includes(entry.kind) ||
        typeof entry.redirect !== 'boolean' ||
        typeof entry.dispatched !== 'boolean' ||
        !integer(entry.bytes, 1)
      )
        throw new LiveBudgetError('journal');
      ids.add(entry.id);
      pendingCounts[entry.kind as LiveRequestKind]++;
      if (entry.redirect) pendingCounts.redirects++;
      reserved += entry.bytes;
      dispatched += entry.dispatched ? 1 : 0;
    }
    if (
      reserved !== state.reservedBytes ||
      dispatched > state.dispatched ||
      (['provider', 'search', 'page', 'redirects'] as const).some(
        (kind) => pendingCounts[kind] > state.requests[kind],
      )
    )
      throw new LiveBudgetError('journal');
  } catch {
    throw new LiveBudgetError('journal');
  }
}
interface Entry extends LiveBudgetPending {
  settled: boolean;
}
// A durable journal is required for recovery. No facts reconstructed from that journal
// restore permission; trusted human consent and execution identities are checked anew.
const owners = new Map<string, { identity: object; journal?: string }>();

/** Offline preparation only: no HTTP, credential storage or human authorization occurs here.
 * A trusted runner must separately obtain actual human consent, match approval snapshots,
 * enforce transport body caps and durably journal dispatch. Request caps are not dollar caps.
 */
export class LiveBudgetLedger {
  readonly manifest: LiveBudgetManifest;
  private readonly humanConfirmed: boolean;
  private readonly identityMatches: boolean;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly startWall: number;
  private readonly startMonotonic: number;
  private clockFloor: number;
  private readonly tokens = new WeakMap<object, Entry>();
  private readonly outstanding = new Set<Entry>();
  private readonly requests = { provider: 0, search: 0, page: 0, redirects: 0 };
  private chargedBytes = 0;
  private reservedBytes = 0;
  private dispatched = 0;
  private settled = 0;
  private unknownReceipts = 0;
  private closed = false;
  private readonly ownerIdentity = Object.freeze({});
  private claimed = false;
  private readonly journal?: LiveBudgetJournal;
  private journalInitialized = false;
  private journalRevision = 0;
  private journalCommitFailed = false;
  private localWriterSuspended = false;
  constructor(
    manifest: LiveBudgetManifest,
    options: {
      humanConfirmed?: boolean;
      executionIdentity?: { sourceSha256: string; buildSha256: string };
      now?: () => number;
      monotonic?: () => number;
      journal?: LiveBudgetJournal;
    } = {},
  ) {
    keys(manifest, [...inputKeys, 'schemaVersion', 'digest']);
    const {
      authorizationId,
      sourceSha256,
      buildSha256,
      journalSha256,
      caseIds: selected,
      createdAt,
      expiresAt,
      limits,
    } = manifest;
    this.manifest = createLiveBudgetManifest({
      authorizationId,
      sourceSha256,
      buildSha256,
      journalSha256,
      caseIds: selected,
      createdAt,
      expiresAt,
      limits,
    });
    if (manifest.schemaVersion !== 1 || manifest.digest !== this.manifest.digest)
      throw new LiveBudgetError('manifest');
    this.humanConfirmed = options.humanConfirmed === true;
    this.journal = options.journal;
    this.identityMatches =
      options.executionIdentity?.sourceSha256 === sourceSha256 &&
      options.executionIdentity?.buildSha256 === buildSha256;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.startWall = this.now();
    this.clockFloor = this.startWall;
    this.startMonotonic = this.monotonic();
    if (!Number.isFinite(this.startWall) || !Number.isFinite(this.startMonotonic))
      throw new LiveBudgetError('expired');
  }
  private active() {
    if (this.localWriterSuspended) throw new LiveBudgetError('suspended');
    if (this.closed) throw new LiveBudgetError('closed');
    if (!this.humanConfirmed) throw new LiveBudgetError('authorization');
    if (!this.identityMatches) throw new LiveBudgetError('identity');
    const wall = this.now();
    const elapsed = Math.max(0, this.monotonic() - this.startMonotonic);
    this.clockFloor = Math.max(this.clockFloor, wall, this.startWall + elapsed);
    const deadline = Math.min(
      this.manifest.expiresAt,
      this.manifest.createdAt + this.manifest.limits.wallClockMs,
    );
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(elapsed) ||
      !Number.isFinite(this.clockFloor) ||
      this.clockFloor < this.manifest.createdAt ||
      this.clockFloor >= deadline
    ) {
      this.revoke();
      throw new LiveBudgetError('expired');
    }
  }
  private state(): LiveBudgetState {
    return {
      version: 1,
      requests: { ...this.requests },
      chargedBytes: this.chargedBytes,
      reservedBytes: this.reservedBytes,
      dispatched: this.dispatched,
      settled: this.settled,
      unknownReceipts: this.unknownReceipts,
      closed: this.closed,
      clockFloor: this.clockFloor,
      pending: [...this.outstanding].map(({ id, caseId, kind, redirect, bytes, dispatched }) => ({
        id,
        caseId,
        kind,
        redirect,
        bytes,
        dispatched,
      })),
    };
  }
  private commit(event: Parameters<LiveBudgetJournal['commit']>[3]) {
    if (!this.journal || !this.journalInitialized) return;
    try {
      const revision = this.journal.commit(
        this.manifest,
        this.journalRevision,
        this.state(),
        event,
      );
      if (!integer(revision, 1) || revision !== this.journalRevision + 1)
        throw new LiveBudgetError('journal');
      this.journalRevision = revision;
    } catch {
      // Commit may have reached disk. Never continue from provisional memory or refund it.
      this.closed = true;
      this.journalCommitFailed = true;
      throw new LiveBudgetError('journal');
    }
  }
  private initializeJournal() {
    if (!this.journal || this.journalInitialized) return;
    try {
      if (this.journal.identitySha256 !== this.manifest.journalSha256)
        throw new LiveBudgetError('journal');
      const saved = this.journal.load(this.manifest);
      this.journalInitialized = true;
      if (!saved) return;
      if (!integer(saved.revision, 1)) throw new LiveBudgetError('journal');
      validateBudgetState(saved.state, this.manifest);
      if (this.startWall + 1 < saved.state.clockFloor) throw new LiveBudgetError('journal');
      this.journalRevision = saved.revision;
      Object.assign(this.requests, saved.state.requests);
      this.chargedBytes = saved.state.chargedBytes;
      this.reservedBytes = saved.state.reservedBytes;
      this.dispatched = saved.state.dispatched;
      this.settled = saved.state.settled;
      this.unknownReceipts = saved.state.unknownReceipts;
      this.closed = saved.state.closed;
      this.clockFloor = Math.max(this.clockFloor, saved.state.clockFloor);
      this.claimed = Object.values(this.requests).some((count) => count > 0);
      // A dispatch intent might have reached transport. Old tokens are never recreated.
      // Proven pre-dispatch reservations release bytes, but never their request slot.
      for (const pending of saved.state.pending) {
        this.reservedBytes -= pending.bytes;
        this.chargedBytes += pending.dispatched ? pending.bytes : 0;
        this.unknownReceipts += pending.dispatched ? 1 : 0;
        this.settled++;
      }
      if (saved.state.pending.length) this.commit('recovered');
    } catch {
      this.closed = true;
      this.journalCommitFailed = true;
      throw new LiveBudgetError('journal');
    }
  }
  reserve(input: {
    caseId: string;
    kind: LiveRequestKind;
    redirect?: boolean;
    responseBytes: number;
  }): object {
    this.active();
    this.initializeJournal();
    this.active();
    if (
      !this.manifest.caseIds.includes(input.caseId) ||
      !['provider', 'search', 'page'].includes(input.kind) ||
      !integer(input.responseBytes, 1) ||
      (input.redirect !== undefined && typeof input.redirect !== 'boolean')
    )
      throw new LiveBudgetError('reservation');
    const owner = owners.get(this.manifest.authorizationId);
    if (
      owner &&
      owner.identity !== this.ownerIdentity &&
      (!this.journal || owner.journal !== this.manifest.journalSha256)
    )
      throw new LiveBudgetError('closed');
    const limits = this.manifest.limits;
    if (
      this.requests[input.kind] >= limits[input.kind] ||
      (input.redirect && this.requests.redirects >= limits.redirects) ||
      input.responseBytes > limits.responseBodyBytes - this.chargedBytes - this.reservedBytes
    )
      throw new LiveBudgetError('quota');
    owners.set(this.manifest.authorizationId, {
      identity: this.ownerIdentity,
      journal: this.journal?.identitySha256,
    });
    this.claimed = true;
    this.requests[input.kind]++;
    if (input.redirect) this.requests.redirects++;
    this.reservedBytes += input.responseBytes;
    const entry: Entry = {
      id: randomUUID(),
      caseId: input.caseId,
      kind: input.kind,
      redirect: input.redirect ?? false,
      bytes: input.responseBytes,
      dispatched: false,
      settled: false,
    };
    const token: object = Object.freeze(Object.create(null));
    this.tokens.set(token, entry);
    this.outstanding.add(entry);
    this.commit('reserved');
    return token;
  }
  private entry(token: object): Entry {
    const entry = token && typeof token === 'object' ? this.tokens.get(token) : undefined;
    if (!entry || entry.settled) throw new LiveBudgetError('reservation');
    return entry;
  }
  availableResponseBytes(): number {
    this.active();
    this.initializeJournal();
    this.active();
    return this.manifest.limits.responseBodyBytes - this.chargedBytes - this.reservedBytes;
  }
  remainingTimeMs(): number {
    this.active();
    this.initializeJournal();
    this.active();
    return Math.max(
      0,
      Math.floor(
        Math.min(
          this.manifest.expiresAt,
          this.manifest.createdAt + this.manifest.limits.wallClockMs,
        ) - this.clockFloor,
      ),
    );
  }
  reservationId(token: object): string {
    return this.entry(token).id;
  }
  dispatch(token: object) {
    this.active();
    const entry = this.entry(token);
    if (entry.dispatched) throw new LiveBudgetError('reservation');
    entry.dispatched = true;
    this.dispatched++;
    this.commit('dispatch');
  }
  private settle(entry: Entry, bytes: number, known: boolean) {
    entry.settled = true;
    this.outstanding.delete(entry);
    this.reservedBytes -= entry.bytes;
    this.chargedBytes += bytes;
    this.settled++;
    if (!known) this.unknownReceipts++;
  }
  complete(
    token: object,
    receipt: { outcome: 'completed' | 'failed' | 'cancelled'; responseBytes?: number },
  ) {
    if (this.localWriterSuspended) throw new LiveBudgetError('suspended');
    if (this.closed) throw new LiveBudgetError('closed');
    const entry = this.entry(token);
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).some((key) => !['outcome', 'responseBytes'].includes(key))
    ) {
      this.revoke();
      throw new LiveBudgetError('receipt');
    }
    const known = receipt.responseBytes !== undefined;
    if (
      !['completed', 'failed', 'cancelled'].includes(receipt.outcome) ||
      (known && (!integer(receipt.responseBytes) || receipt.responseBytes > entry.bytes)) ||
      (!entry.dispatched && (receipt.outcome !== 'cancelled' || receipt.responseBytes !== 0)) ||
      (receipt.outcome === 'completed' && !known)
    ) {
      this.revoke();
      throw new LiveBudgetError('receipt');
    }
    this.settle(entry, known ? (receipt.responseBytes ?? 0) : entry.bytes, known);
    this.commit('settled');
  }
  revoke() {
    if (this.localWriterSuspended) throw new LiveBudgetError('suspended');
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.outstanding])
      this.settle(entry, entry.dispatched ? entry.bytes : 0, !entry.dispatched);
    this.commit('closed');
  }
  abort() {
    this.revoke();
  }
  /** Permanently disables this local writer without closing the durable authorization.
   * Caller must first quiesce all actual meters, close its connection and independently
   * establish exclusive ownership before resuming the same journal. This is no process lock,
   * consent, transfer receipt or evidence that another process actually ended.
   */
  suspendForHandoff(): void {
    if (this.localWriterSuspended) throw new LiveBudgetError('suspended');
    if (!this.journal || !this.journalInitialized || this.journalCommitFailed)
      throw new LiveBudgetError('journal');
    if (this.closed) throw new LiveBudgetError('closed');
    if (!this.humanConfirmed) throw new LiveBudgetError('authorization');
    if (!this.identityMatches) throw new LiveBudgetError('identity');
    // Handoff refusal must not perform recovery, settle a live token or append closed state.
    const wall = this.now();
    const elapsed = Math.max(0, this.monotonic() - this.startMonotonic);
    const floor = Math.max(this.clockFloor, wall, this.startWall + elapsed);
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(elapsed) ||
      !Number.isFinite(floor) ||
      floor < this.manifest.createdAt ||
      floor >=
        Math.min(
          this.manifest.expiresAt,
          this.manifest.createdAt + this.manifest.limits.wallClockMs,
        )
    )
      throw new LiveBudgetError('expired');
    if (this.outstanding.size || this.reservedBytes !== 0) throw new LiveBudgetError('reservation');
    this.localWriterSuspended = true;
  }
  usage() {
    return Object.freeze({
      ...this.requests,
      dispatchIntents: this.dispatched,
      settledReservations: this.settled,
      chargedResponseBodyBytes: this.chargedBytes,
      reservedResponseBodyBytes: this.reservedBytes,
      unknownResponseReceipts: this.unknownReceipts,
      closed: this.closed,
      sameAuthorizationCannotResetInThisProcess: this.claimed,
      durableAcrossProcessRestart: this.journalInitialized && !this.journalCommitFailed,
      persistedDispatchIntents: this.journalCommitFailed
        ? 'unknown'
        : this.journalInitialized
          ? this.dispatched
          : 'not-journaled',
      journalRevision: this.journalRevision,
      journalCommitFailed: this.journalCommitFailed,
      /** Local historical snapshot only. A suspended writer cannot represent current DB head. */
      localWriterSuspended: this.localWriterSuspended,
    });
  }
}
