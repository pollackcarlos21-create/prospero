import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createLiveBudgetManifest,
  validateBudgetState,
  type LiveBudgetManifest,
  type LiveBudgetPending,
  type LiveBudgetState,
  type LiveRequestKind,
} from './live-budget';
import type { LiveTransportReceipt } from './live-transport';

type ReconciliationFailure = 'identity' | 'history' | 'receipt' | 'accounting' | 'storage';
export class LiveReconciliationError extends Error {
  constructor(readonly reason: ReconciliationFailure) {
    super(`Live acceptance reconciliation rejected the evidence: ${reason}.`);
  }
}
export interface LiveAccountingFact {
  readonly reservationId: string;
  readonly caseId: string;
  readonly kind: LiveRequestKind;
  readonly redirect: boolean;
  readonly capBytes: number;
  readonly reservedRevision: number;
  readonly dispatchRevision: number | null;
  readonly settlementRevision: number | null;
  readonly dispatchIntent: boolean;
  readonly accountingSettled: boolean;
  readonly charge: 'known' | 'unknown' | 'not-dispatched' | 'pending';
  readonly chargedBytes: number | null;
  readonly settlementMechanism: 'settled' | 'closed' | 'recovered' | null;
  readonly transportAttempted: boolean | 'unknown';
  /** Original validated snapshot; accounting recovery never rewrites its fields. */
  readonly receipt: Readonly<LiveTransportReceipt> | null;
}
export interface LiveBudgetReconciliation {
  readonly schemaVersion: 1;
  readonly status: 'reconciled' | 'pending';
  readonly authorizationId: string;
  readonly manifestDigest: string;
  readonly journalSha256: string;
  readonly globalHistoryHash: string;
  readonly revision: number;
  readonly accountingComplete: boolean;
  readonly transportEvidenceComplete: boolean;
  readonly gaps: readonly {
    readonly reservationId: string;
    readonly reason: 'missing-receipt' | 'unresolved-reservation' | 'unfinished-receipt';
  }[];
  readonly counts: Readonly<{
    requests: Readonly<{ provider: number; search: number; page: number; redirects: number }>;
    dispatchIntents: number;
    settledReservations: number;
    chargedBytes: number;
    reservedBytes: number;
    unknownSettlements: number;
    observedTransportAttempts: number;
    unknownTransportAttempts: number;
    closed: boolean;
  }>;
  readonly facts: readonly LiveAccountingFact[];
}
type MutableFact = { -readonly [Key in keyof LiveAccountingFact]: LiveAccountingFact[Key] };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeSql = (value: string) => value.replace(/\s+/g, ' ').trim();
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const stateKeys = [
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
];
const pendingKeys = ['id', 'caseId', 'kind', 'redirect', 'bytes', 'dispatched'];
const receiptKeys = [
  'reservationId',
  'caseId',
  'kind',
  'redirect',
  'transportAttempted',
  'outcome',
  'status',
  'reservedBytes',
  'observedBytes',
  'bytesKnown',
  'ledgerSettled',
  'failure',
];
const requestKeys = ['provider', 'search', 'page', 'redirects'] as const;
const events = ['reserved', 'dispatch', 'settled', 'closed', 'recovered'];
function reject(reason: ReconciliationFailure): never {
  throw new LiveReconciliationError(reason);
}
function keys(
  value: unknown,
  names: readonly string[],
  reason: ReconciliationFailure,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    reject(reason);
}
function canonicalState(state: LiveBudgetState): string {
  return JSON.stringify({
    version: state.version,
    requests: {
      provider: state.requests.provider,
      search: state.requests.search,
      page: state.requests.page,
      redirects: state.requests.redirects,
    },
    chargedBytes: state.chargedBytes,
    reservedBytes: state.reservedBytes,
    dispatched: state.dispatched,
    settled: state.settled,
    unknownReceipts: state.unknownReceipts,
    closed: state.closed,
    clockFloor: state.clockFloor,
    pending: state.pending.map((item) => ({
      id: item.id,
      caseId: item.caseId,
      kind: item.kind,
      redirect: item.redirect,
      bytes: item.bytes,
      dispatched: item.dispatched,
    })),
  });
}
function parsedState(
  value: string,
  manifest: LiveBudgetManifest,
  selected: boolean,
): LiveBudgetState {
  const state = JSON.parse(value) as LiveBudgetState;
  keys(state, stateKeys, 'history');
  keys(state.requests, requestKeys, 'history');
  if (!Array.isArray(state.pending)) reject('history');
  for (const pending of state.pending) keys(pending, pendingKeys, 'history');
  // Other grants' manifests are not available; validate their shape and safe arithmetic,
  // while only the selected grant's exact scope and quotas can be certified here.
  const bound = selected
    ? manifest
    : {
        ...manifest,
        createdAt: 1,
        caseIds: ['W', 'F', 'C'].flatMap((prefix) =>
          Array.from({ length: 10 }, (_, index) => prefix + String(index + 1).padStart(2, '0')),
        ),
        limits: Object.fromEntries(
          Object.keys(manifest.limits).map((key) => [key, Number.MAX_SAFE_INTEGER]),
        ) as unknown as LiveBudgetManifest['limits'],
      };
  validateBudgetState(state, bound);
  if (canonicalState(state) !== value) reject('history');
  return state;
}
function schema(db: DatabaseSync, identity: string) {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) reject('history');
  const expectedColumns = {
    budget_identity: ['singleton', 'schema_version', 'identity_sha256'],
    budget_records: [
      'sequence',
      'authorization_id',
      'manifest_digest',
      'revision',
      'event',
      'state',
      'previous_hash',
      'record_hash',
    ],
  };
  const definitions = {
    budget_identity:
      'CREATE TABLE budget_identity ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1), identity_sha256 TEXT NOT NULL )',
    budget_records:
      'CREATE TABLE budget_records ( sequence INTEGER PRIMARY KEY, authorization_id TEXT NOT NULL, manifest_digest TEXT NOT NULL, revision INTEGER NOT NULL, event TEXT NOT NULL, state TEXT NOT NULL, previous_hash TEXT NOT NULL, record_hash TEXT NOT NULL, UNIQUE (authorization_id, revision) )',
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const definition = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?').get(table);
    if (
      definition?.type !== 'table' ||
      typeof definition.sql !== 'string' ||
      normalizeSql(definition.sql) !== normalizeSql(definitions[table as keyof typeof definitions])
    )
      reject('history');
    const actual = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) reject('history');
  }
  for (const table of ['budget_identity', 'budget_records']) {
    for (const action of ['update', 'delete']) {
      const name = `${table}_no_${action}`;
      const message =
        table === 'budget_identity'
          ? 'Immutable live budget identity'
          : 'Immutable live budget history';
      const expected = `CREATE TRIGGER ${name} BEFORE ${action.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`;
      const found = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?').get(name);
      if (
        found?.type !== 'trigger' ||
        typeof found.sql !== 'string' ||
        normalizeSql(found.sql) !== normalizeSql(expected)
      )
        reject('history');
    }
  }
  const rows = db.prepare('SELECT * FROM budget_identity').all();
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== 1 ||
    rows[0]?.schema_version !== 1 ||
    rows[0]?.identity_sha256 !== identity
  )
    reject('identity');
}
function compareIdentity(before: LiveBudgetPending, after: LiveBudgetPending) {
  if (
    before.id !== after.id ||
    before.caseId !== after.caseId ||
    before.kind !== after.kind ||
    before.redirect !== after.redirect ||
    before.bytes !== after.bytes ||
    (before.dispatched && !after.dispatched)
  )
    reject('accounting');
}
function sameCounters(expected: LiveBudgetState, actual: LiveBudgetState) {
  if (
    requestKeys.some((kind) => expected.requests[kind] !== actual.requests[kind]) ||
    ['chargedBytes', 'reservedBytes', 'dispatched', 'settled', 'unknownReceipts', 'closed'].some(
      (key) => expected[key as keyof LiveBudgetState] !== actual[key as keyof LiveBudgetState],
    ) ||
    actual.clockFloor < expected.clockFloor
  )
    reject('accounting');
}
function receipt(value: unknown, facts: Map<string, MutableFact>): LiveTransportReceipt {
  keys(value, receiptKeys, 'receipt');
  if (typeof value.reservationId !== 'string') reject('receipt');
  const fact = facts.get(value.reservationId);
  if (
    !fact ||
    value.caseId !== fact.caseId ||
    value.kind !== fact.kind ||
    value.redirect !== fact.redirect ||
    value.reservedBytes !== fact.capBytes
  )
    reject('receipt');
  for (const key of ['transportAttempted', 'bytesKnown', 'ledgerSettled'])
    if (typeof value[key] !== 'boolean') reject('receipt');
  if (
    typeof value.outcome !== 'string' ||
    !['pending', 'completed', 'failed', 'cancelled', 'rejected'].includes(value.outcome) ||
    !integer(value.observedBytes) ||
    (value.status !== null && (!integer(value.status, 100) || value.status > 599)) ||
    (value.failure !== null &&
      (typeof value.failure !== 'string' ||
        ![
          'budget',
          'journal',
          'endpoint',
          'network',
          'cancelled',
          'too-large',
          'incompatible',
        ].includes(value.failure)))
  )
    reject('receipt');
  if (
    (value.bytesKnown && value.observedBytes > fact.capBytes) ||
    (!value.transportAttempted && (value.status !== null || value.observedBytes !== 0)) ||
    (value.outcome === 'pending' && (value.bytesKnown || value.ledgerSettled)) ||
    (value.outcome === 'completed' &&
      (!value.transportAttempted || !value.bytesKnown || value.status === null)) ||
    (value.outcome === 'rejected' &&
      (value.transportAttempted || !value.bytesKnown || value.ledgerSettled))
  )
    reject('receipt');
  if (value.transportAttempted && !fact.dispatchIntent) reject('accounting');
  if (value.ledgerSettled && (!fact.accountingSettled || fact.settlementMechanism !== 'settled'))
    reject('accounting');
  if (fact.settlementMechanism === 'settled' && value.outcome !== 'pending') {
    if (fact.charge === 'unknown') {
      if (value.bytesKnown) reject('accounting');
    } else if (!value.bytesKnown || fact.chargedBytes !== value.observedBytes) reject('accounting');
  }
  if (
    value.outcome === 'pending' &&
    fact.accountingSettled &&
    fact.charge !== 'unknown' &&
    fact.chargedBytes !== null &&
    value.observedBytes > fact.chargedBytes
  )
    reject('accounting');
  if (
    value.outcome !== 'pending' &&
    fact.accountingSettled &&
    fact.charge !== 'unknown' &&
    !value.transportAttempted &&
    fact.chargedBytes !== 0
  )
    reject('accounting');
  return Object.freeze({ ...value }) as unknown as LiveTransportReceipt;
}

/** Independent, read-only accounting audit; it grants no authority and proves no remote HTTP. */
export function reconcileLiveBudget(input: {
  databasePath: string;
  manifest: LiveBudgetManifest;
  receipts: readonly LiveTransportReceipt[];
}): LiveBudgetReconciliation {
  let db: DatabaseSync | undefined;
  try {
    const { schemaVersion, digest, ...manifestInput } = input.manifest;
    const manifest = createLiveBudgetManifest(manifestInput);
    if (schemaVersion !== 1 || digest !== manifest.digest) reject('identity');
    const selectedPath = resolve(input.databasePath);
    const before = lstatSync(selectedPath);
    if (!before.isFile() || before.isSymbolicLink()) reject('identity');
    const canonicalPath = realpathSync(selectedPath);
    const identity = sha(canonicalPath);
    if (identity !== manifest.journalSha256) reject('identity');
    db = new DatabaseSync(canonicalPath, { readOnly: true });
    db.exec('BEGIN');
    schema(db, identity);
    let sequence = 0;
    let hash = sha(`prospero-live-budget-journal:genesis:v1\n${identity}`);
    const revisions = new Map<string, { revision: number; digest: string }>();
    const facts = new Map<string, MutableFact>();
    let previous: LiveBudgetState = {
      version: 1,
      requests: { provider: 0, search: 0, page: 0, redirects: 0 },
      chargedBytes: 0,
      reservedBytes: 0,
      dispatched: 0,
      settled: 0,
      unknownReceipts: 0,
      closed: false,
      clockFloor: manifest.createdAt,
      pending: [],
    };
    let selectedRevision = 0;
    for (const row of db.prepare('SELECT * FROM budget_records ORDER BY sequence').all()) {
      if (
        !integer(row.sequence, 1) ||
        row.sequence !== sequence + 1 ||
        typeof row.authorization_id !== 'string' ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(row.authorization_id) ||
        typeof row.manifest_digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.manifest_digest) ||
        !integer(row.revision, 1) ||
        typeof row.event !== 'string' ||
        !events.includes(row.event) ||
        typeof row.state !== 'string' ||
        row.previous_hash !== hash ||
        typeof row.record_hash !== 'string'
      )
        reject('history');
      const seen = revisions.get(row.authorization_id);
      if (
        row.revision !== (seen?.revision ?? 0) + 1 ||
        (seen && seen.digest !== row.manifest_digest)
      )
        reject('history');
      const selected = row.authorization_id === manifest.authorizationId;
      if (selected && row.manifest_digest !== manifest.digest) reject('identity');
      const state = parsedState(row.state, manifest, selected);
      const computed = sha(
        `prospero-live-budget-journal:record:v1\n${JSON.stringify({ schemaVersion: 1, sequence: row.sequence, authorizationId: row.authorization_id, manifestDigest: row.manifest_digest, revision: row.revision, event: row.event, state: row.state, previousHash: hash })}`,
      );
      if (computed !== row.record_hash) reject('history');
      sequence = row.sequence;
      hash = computed;
      revisions.set(row.authorization_id, { revision: row.revision, digest: row.manifest_digest });
      if (!selected) continue;
      const beforePending = new Map(previous.pending.map((entry) => [entry.id, entry]));
      const afterPending = new Map(state.pending.map((entry) => [entry.id, entry]));
      const added = state.pending.filter((entry) => !beforePending.has(entry.id));
      const removed = previous.pending.filter((entry) => !afterPending.has(entry.id));
      const changed: LiveBudgetPending[] = [];
      for (const entry of state.pending) {
        const beforeEntry = beforePending.get(entry.id);
        if (beforeEntry) {
          compareIdentity(beforeEntry, entry);
          if (beforeEntry.dispatched !== entry.dispatched) changed.push(entry);
        }
      }
      const expected = { ...previous, requests: { ...previous.requests } };
      const finish = (
        entry: LiveBudgetPending,
        charge: LiveAccountingFact['charge'],
        bytes: number,
        mechanism: 'settled' | 'closed' | 'recovered',
      ) => {
        const fact = facts.get(entry.id);
        if (!fact || fact.accountingSettled) reject('accounting');
        fact.accountingSettled = true;
        fact.settlementRevision = row.revision as number;
        fact.settlementMechanism = mechanism;
        fact.chargedBytes = bytes;
        fact.charge = charge;
        expected.reservedBytes -= entry.bytes;
        expected.chargedBytes += bytes;
        expected.settled++;
        if (charge === 'unknown') expected.unknownReceipts++;
      };
      if (row.event === 'reserved') {
        if (previous.closed || added.length !== 1 || removed.length || changed.length)
          reject('accounting');
        const entry = added[0];
        if (!entry || entry.dispatched || facts.has(entry.id)) reject('accounting');
        expected.requests[entry.kind]++;
        if (entry.redirect) expected.requests.redirects++;
        expected.reservedBytes += entry.bytes;
        facts.set(entry.id, {
          reservationId: entry.id,
          caseId: entry.caseId,
          kind: entry.kind,
          redirect: entry.redirect,
          capBytes: entry.bytes,
          reservedRevision: row.revision,
          dispatchRevision: null,
          settlementRevision: null,
          dispatchIntent: false,
          accountingSettled: false,
          charge: 'pending',
          chargedBytes: null,
          settlementMechanism: null,
          transportAttempted: false,
          receipt: null,
        });
      } else if (row.event === 'dispatch') {
        if (previous.closed || added.length || removed.length || changed.length !== 1)
          reject('accounting');
        const entry = changed[0];
        const fact = entry && facts.get(entry.id);
        if (!fact || fact.dispatchIntent) reject('accounting');
        fact.dispatchIntent = true;
        fact.dispatchRevision = row.revision;
        fact.transportAttempted = 'unknown';
        expected.dispatched++;
      } else if (row.event === 'settled') {
        if (previous.closed || added.length || changed.length || removed.length !== 1)
          reject('accounting');
        const entry = removed[0];
        if (!entry) reject('accounting');
        const bytes = state.chargedBytes - previous.chargedBytes;
        const unknown = state.unknownReceipts - previous.unknownReceipts;
        if (
          !integer(bytes) ||
          bytes > entry.bytes ||
          ![0, 1].includes(unknown) ||
          (unknown === 1 && (!entry.dispatched || bytes !== entry.bytes)) ||
          (!entry.dispatched && (unknown !== 0 || bytes !== 0))
        )
          reject('accounting');
        finish(
          entry,
          unknown === 1 ? 'unknown' : entry.dispatched ? 'known' : 'not-dispatched',
          bytes,
          'settled',
        );
      } else {
        if (
          previous.closed ||
          added.length ||
          changed.length ||
          state.pending.length ||
          removed.length !== previous.pending.length ||
          (row.event === 'recovered' && removed.length === 0)
        )
          reject('accounting');
        if (row.event === 'closed') expected.closed = true;
        for (const entry of removed)
          finish(
            entry,
            entry.dispatched ? 'unknown' : 'not-dispatched',
            entry.dispatched ? entry.bytes : 0,
            row.event as 'closed' | 'recovered',
          );
      }
      sameCounters(expected, state);
      previous = state;
      selectedRevision = row.revision;
    }
    if (!selectedRevision) reject('history');
    const after = lstatSync(canonicalPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      realpathSync(canonicalPath) !== canonicalPath
    )
      reject('identity');
    if (!Array.isArray(input.receipts)) reject('receipt');
    const provided = new Set<string>();
    for (const value of input.receipts) {
      const checked = receipt(value, facts);
      if (provided.has(checked.reservationId)) reject('receipt');
      provided.add(checked.reservationId);
      const fact = facts.get(checked.reservationId);
      if (!fact) reject('receipt');
      fact.receipt = checked;
      fact.transportAttempted =
        checked.outcome === 'pending' && !checked.transportAttempted && fact.dispatchIntent
          ? 'unknown'
          : checked.transportAttempted;
    }
    const gaps: LiveBudgetReconciliation['gaps'][number][] = [];
    for (const fact of facts.values()) {
      if (!fact.accountingSettled)
        gaps.push({ reservationId: fact.reservationId, reason: 'unresolved-reservation' });
      if (!fact.receipt)
        gaps.push({ reservationId: fact.reservationId, reason: 'missing-receipt' });
      else if (fact.receipt.outcome === 'pending')
        gaps.push({ reservationId: fact.reservationId, reason: 'unfinished-receipt' });
    }
    const accountingComplete = [...facts.values()].every((fact) => fact.accountingSettled);
    const transportEvidenceComplete = [...facts.values()].every(
      (fact) => fact.receipt && fact.receipt.outcome !== 'pending',
    );
    const output: LiveBudgetReconciliation = {
      schemaVersion: 1,
      status: accountingComplete && transportEvidenceComplete ? 'reconciled' : 'pending',
      authorizationId: manifest.authorizationId,
      manifestDigest: manifest.digest,
      journalSha256: identity,
      globalHistoryHash: hash,
      revision: selectedRevision,
      accountingComplete,
      transportEvidenceComplete,
      gaps: Object.freeze(gaps.map((gap) => Object.freeze(gap))),
      counts: Object.freeze({
        requests: Object.freeze({ ...previous.requests }),
        dispatchIntents: previous.dispatched,
        settledReservations: previous.settled,
        chargedBytes: previous.chargedBytes,
        reservedBytes: previous.reservedBytes,
        unknownSettlements: previous.unknownReceipts,
        observedTransportAttempts: [...facts.values()].filter(
          (fact) => fact.transportAttempted === true,
        ).length,
        unknownTransportAttempts: [...facts.values()].filter(
          (fact) => fact.transportAttempted === 'unknown',
        ).length,
        closed: previous.closed,
      }),
      facts: Object.freeze([...facts.values()].map((fact) => Object.freeze({ ...fact }))),
    };
    db.exec('COMMIT');
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof LiveReconciliationError) throw error;
    throw new LiveReconciliationError('storage');
  } finally {
    try {
      db?.exec('ROLLBACK');
    } catch {}
    try {
      db?.close();
    } catch {}
  }
}
