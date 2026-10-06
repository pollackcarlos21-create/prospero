import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  createLiveBudgetManifest,
  type LiveBudgetInput,
  type LiveBudgetState,
} from '../acceptance/live-budget';
import { LiveBudgetJournalError, SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
let nextId = 0;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-budget-journal-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'budget.sqlite');
  const journal = new SqliteLiveBudgetJournal(database, { mode: 'create' });
  cleanup.push(() => journal.close());
  const input: LiveBudgetInput = {
    authorizationId: `offline_journal_${++nextId}`,
    sourceSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    journalSha256: journal.identitySha256,
    caseIds: ['W01'],
    createdAt: 1000,
    expiresAt: 10000,
    limits: {
      provider: 4,
      search: 4,
      page: 4,
      redirects: 2,
      responseBodyBytes: 1024,
      wallClockMs: 9000,
    },
  };
  return { directory, database, journal, input, manifest: createLiveBudgetManifest(input) };
}
function open(database: string) {
  const journal = new SqliteLiveBudgetJournal(database, { mode: 'resume' });
  cleanup.push(() => journal.close());
  return journal;
}
function observer(database: string) {
  const db = new DatabaseSync(database);
  cleanup.push(() => db.close());
  return db;
}
function reserved(): LiveBudgetState {
  return {
    version: 1,
    requests: { provider: 1, search: 0, page: 0, redirects: 0 },
    chargedBytes: 0,
    reservedBytes: 64,
    dispatched: 0,
    settled: 0,
    unknownReceipts: 0,
    closed: false,
    clockFloor: 1000,
    pending: [
      {
        id: 'reservation_one',
        caseId: 'W01',
        kind: 'provider',
        redirect: false,
        bytes: 64,
        dispatched: false,
      },
    ],
  };
}
function dispatched(): LiveBudgetState {
  const state = reserved();
  return {
    ...state,
    dispatched: 1,
    pending: state.pending.map((entry) => ({ ...entry, dispatched: true })),
  };
}
function settled(): LiveBudgetState {
  return {
    ...dispatched(),
    chargedBytes: 23,
    reservedBytes: 0,
    settled: 1,
    pending: [],
  };
}
function rowCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM budget_records').get();
  if (typeof row?.count !== 'number') throw new Error('Missing journal row count');
  return row.count;
}

test('reopened journal preserves revisions, consumption and pending dispatch facts', () => {
  const { database, journal, manifest } = fixture();
  expect(journal.load(manifest)).toBeUndefined();
  expect(journal.commit(manifest, 0, reserved(), 'reserved')).toBe(1);
  expect(journal.commit(manifest, 1, dispatched(), 'dispatch')).toBe(2);
  const resumed = open(database);
  expect(resumed.load(manifest)).toEqual({ revision: 2, state: dispatched() });
  expect(resumed.commit(manifest, 2, settled(), 'settled')).toBe(3);
  expect(open(database).load(manifest)).toEqual({ revision: 3, state: settled() });
  const saved = readFileSync(database);
  expect(saved.includes(Buffer.from('humanConfirmed'))).toBe(false);
  expect(saved.includes(Buffer.from('headers'))).toBe(false);
});

test('manifest drift cannot reuse the same authorization ledger or fabricate a digest', () => {
  const { journal, manifest, input } = fixture();
  journal.commit(manifest, 0, reserved(), 'reserved');
  const drift = createLiveBudgetManifest({ ...input, buildSha256: 'c'.repeat(64) });
  expect(() => journal.load(drift)).toThrow('identity');
  expect(() => journal.load({ ...manifest, digest: 'd'.repeat(64) })).toThrow('identity');
  expect(() => journal.commit(drift, 1, dispatched(), 'dispatch')).toThrow('identity');
});

test('copied database and mismatched canonical journal path fail closed', () => {
  const { directory, database, journal, manifest, input } = fixture();
  journal.commit(manifest, 0, reserved(), 'reserved');
  const copied = join(directory, 'copied.sqlite');
  copyFileSync(database, copied);
  expect(() => new SqliteLiveBudgetJournal(copied, { mode: 'resume' })).toThrow('identity');
  const wrongPath = createLiveBudgetManifest({ ...input, journalSha256: 'c'.repeat(64) });
  expect(() => journal.load(wrongPath)).toThrow('identity');
});

test('two SQLite connections cannot commit the same captured revision twice', () => {
  const { database, journal, manifest } = fixture();
  journal.commit(manifest, 0, reserved(), 'reserved');
  const second = open(database);
  expect(journal.load(manifest)?.revision).toBe(1);
  expect(second.load(manifest)?.revision).toBe(1);
  expect(journal.commit(manifest, 1, dispatched(), 'dispatch')).toBe(2);
  expect(() => second.commit(manifest, 1, dispatched(), 'dispatch')).toThrow('conflict');
  expect(() => second.commit(manifest, 2, settled(), 'settled')).toThrow('closed');
  expect(open(database).load(manifest)).toEqual({ revision: 2, state: dispatched() });
  expect(rowCount(observer(database))).toBe(2);
});

test('insert commit failure rolls back without an append and hides raw SQL errors', () => {
  const { directory, database, journal, manifest } = fixture();
  const db = observer(database);
  db.exec(`CREATE TRIGGER forced_failure BEFORE INSERT ON budget_records BEGIN
    SELECT RAISE(FAIL, 'RAW_SQL_SECRET_CANARY');
  END`);
  let caught: unknown;
  try {
    journal.commit(manifest, 0, reserved(), 'reserved');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LiveBudgetJournalError);
  expect(String(caught)).toContain('storage');
  expect(String(caught)).not.toContain('RAW_SQL_SECRET_CANARY');
  expect(String(caught)).not.toContain(directory);
  expect(rowCount(db)).toBe(0);
  expect(() => open(database).load(manifest)).toThrow('history');
  expect(() => journal.commit(manifest, 0, reserved(), 'reserved')).toThrow('closed');
});

test('actual COMMIT busy failure rolls back an inserted reservation before permitting work', () => {
  const { database, journal, manifest } = fixture();
  const reader = observer(database);
  reader.exec('BEGIN');
  expect(rowCount(reader)).toBe(0);
  expect(() => journal.commit(manifest, 0, reserved(), 'reserved')).toThrow('storage');
  reader.exec('ROLLBACK');
  expect(rowCount(reader)).toBe(0);
  expect(() => open(database).load(manifest)).toThrow('history');
  expect(() => journal.commit(manifest, 0, reserved(), 'reserved')).toThrow('closed');
});

test('resume never initializes a missing or an existing empty database', () => {
  const { directory } = fixture();
  const missing = join(directory, 'missing.sqlite');
  expect(() => new SqliteLiveBudgetJournal(missing, { mode: 'resume' })).toThrow('storage');
  expect(() => readFileSync(missing)).toThrow();
  const empty = join(directory, 'empty.sqlite');
  writeFileSync(empty, '');
  expect(() => new SqliteLiveBudgetJournal(empty, { mode: 'resume' })).toThrow('history');
  expect(readFileSync(empty).length).toBe(0);
});

test('resume rejects schema-only history and another authorization instead of resetting revision zero', () => {
  const empty = fixture();
  const resumedEmpty = open(empty.database);
  expect(() => resumedEmpty.load(empty.manifest)).toThrow('history');
  expect(() => resumedEmpty.commit(empty.manifest, 0, reserved(), 'reserved')).toThrow('history');
  expect(rowCount(observer(empty.database))).toBe(0);
  const occupied = fixture();
  occupied.journal.commit(occupied.manifest, 0, reserved(), 'reserved');
  const other = createLiveBudgetManifest({
    ...occupied.input,
    authorizationId: `offline_other_${++nextId}`,
  });
  const resumedOther = open(occupied.database);
  expect(() => resumedOther.load(other)).toThrow('history');
  expect(() => resumedOther.commit(other, 0, reserved(), 'reserved')).toThrow('history');
  expect(rowCount(observer(occupied.database))).toBe(1);
});

test('create cannot overwrite a prior database and corrupted resume exposes no contents', () => {
  const { directory, database } = fixture();
  expect(() => new SqliteLiveBudgetJournal(database, { mode: 'create' })).toThrow('storage');
  const corrupt = join(directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'RAW_DATABASE_SECRET_CANARY');
  let caught: unknown;
  try {
    new SqliteLiveBudgetJournal(corrupt, { mode: 'resume' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LiveBudgetJournalError);
  expect(String(caught)).not.toContain('RAW_DATABASE_SECRET_CANARY');
  expect(String(caught)).not.toContain(directory);
});

test('append-only triggers reject history and identity updates or deletes', () => {
  const { database, journal, manifest } = fixture();
  journal.commit(manifest, 0, reserved(), 'reserved');
  const db = observer(database);
  for (const sql of [
    'UPDATE budget_records SET revision = 9',
    'DELETE FROM budget_records',
    "UPDATE budget_identity SET identity_sha256 = 'changed'",
    'DELETE FROM budget_identity',
  ])
    expect(() => db.exec(sql)).toThrow('Immutable');
  expect(journal.load(manifest)).toEqual({ revision: 1, state: reserved() });
});

test('hash-chain verification detects altered history even after trigger recreation', () => {
  const { database, journal, manifest } = fixture();
  journal.commit(manifest, 0, reserved(), 'reserved');
  const db = observer(database);
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_records_no_update'")
    .get();
  if (typeof trigger?.sql !== 'string') throw new Error('Missing immutable trigger');
  db.exec('DROP TRIGGER budget_records_no_update');
  const tampered = { ...reserved(), clockFloor: 1001 };
  db.prepare('UPDATE budget_records SET state = ?').run(JSON.stringify(tampered));
  db.exec(trigger.sql);
  expect(() => journal.load(manifest)).toThrow('history');
  expect(() => new SqliteLiveBudgetJournal(database, { mode: 'resume' })).toThrow('history');
});

test('missing immutable trigger or journal schema version prevents resume', () => {
  const first = fixture();
  observer(first.database).exec('DROP TRIGGER budget_records_no_delete');
  expect(() => open(first.database)).toThrow('history');
  const second = fixture();
  observer(second.database).exec('PRAGMA user_version = 2');
  expect(() => open(second.database)).toThrow('history');
});

test('cumulative counts, charged bytes, clock and closed status cannot regress', () => {
  const mutations: ((state: LiveBudgetState) => LiveBudgetState)[] = [
    (state) => ({ ...state, requests: { ...state.requests, provider: 0 }, settled: 0 }),
    (state) => ({ ...state, chargedBytes: 0 }),
    (state) => ({ ...state, dispatched: 0, unknownReceipts: 0 }),
    (state) => ({ ...state, clockFloor: 1000 }),
    (state) => ({ ...state, closed: false }),
  ];
  for (const mutate of mutations) {
    const { database, journal, manifest } = fixture();
    const final: LiveBudgetState = { ...settled(), clockFloor: 1001, closed: true };
    journal.commit(manifest, 0, final, 'closed');
    expect(() => journal.commit(manifest, 1, mutate(final), 'recovered')).toThrow('history');
    expect(rowCount(observer(database))).toBe(1);
  }
});

test('invalid quota state or extra sensitive fields never enter journal storage', () => {
  const { database, journal, manifest } = fixture();
  const extra = { ...reserved(), headers: { authorization: 'SECRET_HEADER_CANARY' } };
  expect(() => journal.commit(manifest, 0, extra, 'reserved')).toThrow('history');
  expect(rowCount(observer(database))).toBe(0);
  expect(readFileSync(database).includes(Buffer.from('SECRET_HEADER_CANARY'))).toBe(false);
  const second = fixture();
  expect(() =>
    second.journal.commit(
      second.manifest,
      0,
      { ...reserved(), reservedBytes: 2048, pending: reserved().pending },
      'reserved',
    ),
  ).toThrow('history');
  expect(rowCount(observer(second.database))).toBe(0);
});

test('an actual Bun child exits after dispatch commit and a new connection retains unknown work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-budget-child-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'child.sqlite');
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, '../acceptance/live-budget-journal.ts'),
  ).href;
  const manifestUrl = pathToFileURL(join(import.meta.dir, '../acceptance/live-budget.ts')).href;
  const input = {
    authorizationId: `offline_child_${++nextId}`,
    sourceSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    caseIds: ['W01'],
    createdAt: 1000,
    expiresAt: 10000,
    limits: {
      provider: 4,
      search: 4,
      page: 4,
      redirects: 2,
      responseBodyBytes: 1024,
      wallClockMs: 9000,
    },
  };
  const script = `
    import { SqliteLiveBudgetJournal } from ${JSON.stringify(moduleUrl)};
    import { createLiveBudgetManifest } from ${JSON.stringify(manifestUrl)};
    const journal = new SqliteLiveBudgetJournal(${JSON.stringify(database)}, { mode: 'create' });
    const manifest = createLiveBudgetManifest({ ...${JSON.stringify(input)}, journalSha256: journal.identitySha256 });
    journal.commit(manifest, 0, ${JSON.stringify(reserved())}, 'reserved');
    journal.commit(manifest, 1, ${JSON.stringify(dispatched())}, 'dispatch');
    process.exit(23);
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10000,
  });
  expect(child.exitCode).toBe(23);
  expect(child.stderr.toString()).not.toContain('Error');
  const resumed = open(database);
  const manifest = createLiveBudgetManifest({ ...input, journalSha256: resumed.identitySha256 });
  const facts = resumed.load(manifest);
  expect(facts).toEqual({ revision: 2, state: dispatched() });
  expect(facts).not.toHaveProperty('humanConfirmed');
  expect(facts).not.toHaveProperty('token');
  expect(rowCount(observer(database))).toBe(2);
});
