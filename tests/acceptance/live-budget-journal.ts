import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createLiveBudgetManifest,
  validateBudgetState,
  type LiveBudgetJournal,
  type LiveBudgetManifest,
  type LiveBudgetState,
} from './live-budget';

type JournalFailure = 'identity' | 'history' | 'conflict' | 'storage' | 'closed';
export class LiveBudgetJournalError extends Error {
  constructor(readonly reason: JournalFailure) {
    super(`Live acceptance budget journal rejected the operation: ${reason}.`);
  }
}

const events = new Set(['reserved', 'dispatch', 'settled', 'closed', 'recovered']);
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
const requestKeys = ['provider', 'search', 'page', 'redirects'];
const pendingKeys = ['id', 'caseId', 'kind', 'redirect', 'bytes', 'dispatched'];
const schema = {
  budget_identity: `CREATE TABLE budget_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    identity_sha256 TEXT NOT NULL
  )`,
  budget_records: `CREATE TABLE budget_records (
    sequence INTEGER PRIMARY KEY,
    authorization_id TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event TEXT NOT NULL,
    state TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    UNIQUE (authorization_id, revision)
  )`,
  budget_identity_no_update: `CREATE TRIGGER budget_identity_no_update
    BEFORE UPDATE ON budget_identity BEGIN
      SELECT RAISE(ABORT, 'Immutable live budget identity');
    END`,
  budget_identity_no_delete: `CREATE TRIGGER budget_identity_no_delete
    BEFORE DELETE ON budget_identity BEGIN
      SELECT RAISE(ABORT, 'Immutable live budget identity');
    END`,
  budget_records_no_update: `CREATE TRIGGER budget_records_no_update
    BEFORE UPDATE ON budget_records BEGIN
      SELECT RAISE(ABORT, 'Immutable live budget history');
    END`,
  budget_records_no_delete: `CREATE TRIGGER budget_records_no_delete
    BEFORE DELETE ON budget_records BEGIN
      SELECT RAISE(ABORT, 'Immutable live budget history');
    END`,
};
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}

// Only technical counters and opaque identities may enter this dedicated journal.
// Quota and transition semantics are owned by LiveBudgetLedger; extra data is rejected here.
function stateText(value: unknown): string {
  if (!exactKeys(value, stateKeys) || !exactKeys(value.requests, requestKeys))
    throw new LiveBudgetJournalError('history');
  const requests = value.requests;
  if (
    value.version !== 1 ||
    requestKeys.some((key) => !integer(requests[key])) ||
    ['chargedBytes', 'reservedBytes', 'dispatched', 'settled', 'unknownReceipts'].some(
      (key) => !integer(value[key]),
    ) ||
    typeof value.closed !== 'boolean' ||
    typeof value.clockFloor !== 'number' ||
    !Number.isFinite(value.clockFloor) ||
    value.clockFloor < 0 ||
    !Array.isArray(value.pending)
  )
    throw new LiveBudgetJournalError('history');
  const ids = new Set<string>();
  const pending = value.pending.map((entry: unknown) => {
    if (
      !exactKeys(entry, pendingKeys) ||
      typeof entry.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.caseId !== 'string' ||
      !/^[WFC](?:0[1-9]|10)$/.test(entry.caseId) ||
      typeof entry.kind !== 'string' ||
      !['provider', 'search', 'page'].includes(entry.kind) ||
      typeof entry.redirect !== 'boolean' ||
      !integer(entry.bytes, 1) ||
      typeof entry.dispatched !== 'boolean'
    )
      throw new LiveBudgetJournalError('history');
    ids.add(entry.id);
    return {
      id: entry.id,
      caseId: entry.caseId,
      kind: entry.kind,
      redirect: entry.redirect,
      bytes: entry.bytes,
      dispatched: entry.dispatched,
    };
  });
  return JSON.stringify({
    version: 1,
    requests: {
      provider: requests.provider,
      search: requests.search,
      page: requests.page,
      redirects: requests.redirects,
    },
    chargedBytes: value.chargedBytes,
    reservedBytes: value.reservedBytes,
    dispatched: value.dispatched,
    settled: value.settled,
    unknownReceipts: value.unknownReceipts,
    closed: value.closed,
    clockFloor: value.clockFloor,
    pending,
  });
}

interface History {
  sequence: number;
  hash: string;
  grants: Map<string, { digest: string; revision: number; state: LiveBudgetState }>;
}

function checkedState(state: LiveBudgetState, manifest: LiveBudgetManifest) {
  try {
    validateBudgetState(state, manifest);
  } catch {
    throw new LiveBudgetJournalError('history');
  }
}
function increasing(previous: LiveBudgetState, next: LiveBudgetState) {
  if (
    (['provider', 'search', 'page', 'redirects'] as const).some(
      (key) => next.requests[key] < previous.requests[key],
    ) ||
    next.chargedBytes < previous.chargedBytes ||
    next.dispatched < previous.dispatched ||
    next.settled < previous.settled ||
    next.unknownReceipts < previous.unknownReceipts ||
    next.clockFloor < previous.clockFloor ||
    (previous.closed && !next.closed)
  )
    throw new LiveBudgetJournalError('history');
}

/** Test-only durable consumption facts. This never creates or restores human approval. */
export class SqliteLiveBudgetJournal implements LiveBudgetJournal {
  readonly identitySha256: string;
  private readonly canonicalPath: string;
  private readonly fileIdentity: { dev: number; ino: number };
  private readonly db: DatabaseSync;
  private closed = false;
  private connectionClosed = false;
  private readonly mode: 'create' | 'resume';
  constructor(path: string, options: { mode: 'create' | 'resume' }) {
    let opened: DatabaseSync | undefined;
    try {
      if (
        !options ||
        Object.keys(options).length !== 1 ||
        !['create', 'resume'].includes(options.mode)
      )
        throw new LiveBudgetJournalError('storage');
      this.mode = options.mode;
      const selected = resolve(path);
      if (options.mode === 'create') {
        // O_EXCL also rejects an existing/dangling symlink. Never truncate an old ledger.
        const fd = openSync(selected, 'wx', 0o600);
        closeSync(fd);
      }
      const before = lstatSync(selected);
      if (!before.isFile() || before.isSymbolicLink()) throw new LiveBudgetJournalError('identity');
      this.canonicalPath = realpathSync(selected);
      this.identitySha256 = sha256(this.canonicalPath);
      this.fileIdentity = { dev: before.dev, ino: before.ino };
      opened = new DatabaseSync(this.canonicalPath);
      this.db = opened;
      this.assertFile();
      this.db.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA trusted_schema = OFF;
      `);
      if (options.mode === 'create') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const sql of Object.values(schema)) this.db.exec(sql);
          this.db.prepare('INSERT INTO budget_identity VALUES (1, 1, ?)').run(this.identitySha256);
          this.db.exec('PRAGMA user_version = 1; COMMIT');
        } catch (error) {
          this.rollback();
          throw error;
        }
      }
      this.history();
    } catch (error) {
      try {
        opened?.close();
      } catch {}
      if (error instanceof LiveBudgetJournalError) throw error;
      throw new LiveBudgetJournalError('storage');
    }
  }
  private assertFile() {
    const current = lstatSync(this.canonicalPath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== this.fileIdentity.dev ||
      current.ino !== this.fileIdentity.ino ||
      realpathSync(this.canonicalPath) !== this.canonicalPath
    )
      throw new LiveBudgetJournalError('identity');
  }
  private checkManifest(manifest: LiveBudgetManifest) {
    const { schemaVersion, digest, ...input } = manifest;
    const canonical = createLiveBudgetManifest(input);
    if (
      schemaVersion !== 1 ||
      canonical.digest !== digest ||
      manifest.journalSha256 !== this.identitySha256
    )
      throw new LiveBudgetJournalError('identity');
  }
  private history(manifest?: LiveBudgetManifest): History {
    if (this.closed) throw new LiveBudgetJournalError('closed');
    this.assertFile();
    const version = this.db.prepare('PRAGMA user_version').get();
    if (version?.user_version !== 1) throw new LiveBudgetJournalError('history');
    for (const [name, expected] of Object.entries(schema)) {
      const found = this.db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
      if (typeof found?.sql !== 'string' || normalized(found.sql) !== normalized(expected))
        throw new LiveBudgetJournalError('history');
    }
    const identities = this.db.prepare('SELECT * FROM budget_identity').all();
    if (
      identities.length !== 1 ||
      identities[0]?.singleton !== 1 ||
      identities[0]?.schema_version !== 1 ||
      identities[0]?.identity_sha256 !== this.identitySha256
    )
      throw new LiveBudgetJournalError('identity');
    let sequence = 0;
    let hash = sha256(`prospero-live-budget-journal:genesis:v1\n${this.identitySha256}`);
    const grants: History['grants'] = new Map();
    for (const row of this.db.prepare('SELECT * FROM budget_records ORDER BY sequence').all()) {
      if (
        !integer(row.sequence, 1) ||
        row.sequence !== sequence + 1 ||
        typeof row.authorization_id !== 'string' ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(row.authorization_id) ||
        typeof row.manifest_digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.manifest_digest) ||
        !integer(row.revision, 1) ||
        typeof row.event !== 'string' ||
        !events.has(row.event) ||
        typeof row.state !== 'string' ||
        row.previous_hash !== hash ||
        typeof row.record_hash !== 'string'
      )
        throw new LiveBudgetJournalError('history');
      const previous = grants.get(row.authorization_id);
      if (
        row.revision !== (previous?.revision ?? 0) + 1 ||
        (previous && previous.digest !== row.manifest_digest)
      )
        throw new LiveBudgetJournalError('history');
      const parsed = JSON.parse(row.state);
      if (stateText(parsed) !== row.state) throw new LiveBudgetJournalError('history');
      if (previous) increasing(previous.state, parsed as LiveBudgetState);
      if (manifest && row.authorization_id === manifest.authorizationId)
        checkedState(parsed as LiveBudgetState, manifest);
      const computed = this.recordHash(
        row.sequence,
        row.authorization_id,
        row.manifest_digest,
        row.revision,
        row.event,
        row.state,
        hash,
      );
      if (computed !== row.record_hash) throw new LiveBudgetJournalError('history');
      sequence = row.sequence;
      hash = computed;
      grants.set(row.authorization_id, {
        digest: row.manifest_digest,
        revision: row.revision,
        state: parsed as LiveBudgetState,
      });
    }
    return { sequence, hash, grants };
  }
  private recordHash(
    sequence: number,
    authorizationId: string,
    manifestDigest: string,
    revision: number,
    event: string,
    state: string,
    previousHash: string,
  ) {
    return sha256(
      `prospero-live-budget-journal:record:v1\n${JSON.stringify({
        schemaVersion: 1,
        sequence,
        authorizationId,
        manifestDigest,
        revision,
        event,
        state,
        previousHash,
      })}`,
    );
  }
  private rollback() {
    try {
      this.db.exec('ROLLBACK');
    } catch {}
  }
  load(manifest: LiveBudgetManifest): { revision: number; state: LiveBudgetState } | undefined {
    try {
      this.checkManifest(manifest);
      const found = this.history(manifest).grants.get(manifest.authorizationId);
      if (!found && this.mode === 'resume') throw new LiveBudgetJournalError('history');
      if (found && found.digest !== manifest.digest) throw new LiveBudgetJournalError('identity');
      return found ? { revision: found.revision, state: found.state } : undefined;
    } catch (error) {
      if (error instanceof LiveBudgetJournalError) throw error;
      throw new LiveBudgetJournalError('storage');
    }
  }
  commit(
    manifest: LiveBudgetManifest,
    expectedRevision: number,
    state: LiveBudgetState,
    event: 'reserved' | 'dispatch' | 'settled' | 'closed' | 'recovered',
  ): number {
    try {
      if (this.closed) throw new LiveBudgetJournalError('closed');
      this.checkManifest(manifest);
      if (!integer(expectedRevision) || !events.has(event))
        throw new LiveBudgetJournalError('history');
      checkedState(state, manifest);
      const serialized = stateText(state);
      this.db.exec('BEGIN IMMEDIATE');
      const history = this.history(manifest);
      const found = history.grants.get(manifest.authorizationId);
      if (!found && this.mode === 'resume') throw new LiveBudgetJournalError('history');
      if (found && found.digest !== manifest.digest) throw new LiveBudgetJournalError('identity');
      if ((found?.revision ?? 0) !== expectedRevision) throw new LiveBudgetJournalError('conflict');
      if (found) increasing(found.state, state);
      const sequence = history.sequence + 1;
      const revision = expectedRevision + 1;
      if (!integer(sequence, 1) || !integer(revision, 1))
        throw new LiveBudgetJournalError('history');
      const hash = this.recordHash(
        sequence,
        manifest.authorizationId,
        manifest.digest,
        revision,
        event,
        serialized,
        history.hash,
      );
      this.db
        .prepare('INSERT INTO budget_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          sequence,
          manifest.authorizationId,
          manifest.digest,
          revision,
          event,
          serialized,
          history.hash,
          hash,
        );
      this.db.exec('COMMIT');
      return revision;
    } catch (error) {
      this.rollback();
      this.closed = true;
      if (error instanceof LiveBudgetJournalError) throw error;
      throw new LiveBudgetJournalError('storage');
    }
  }
  close() {
    this.closed = true;
    if (this.connectionClosed) return;
    this.connectionClosed = true;
    try {
      this.db.close();
    } catch {
      throw new LiveBudgetJournalError('storage');
    }
  }
}
