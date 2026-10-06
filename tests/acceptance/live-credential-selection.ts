import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderConfig } from '../../apps/desktop/src/bridge';
import { ProsperoStore } from '../../packages/persistence/src';
import { normalizeBaseUrl } from '../../packages/providers/src';
import {
  captureLiveFixtureCheckpoint,
  runLiveFixtureProfileCleanup,
  type LiveCaseFixture,
} from './live-fixtures';

type SelectionFailure =
  | 'authorization'
  | 'selection'
  | 'identity'
  | 'active-source'
  | 'metadata'
  | 'credential'
  | 'stale'
  | 'used'
  | 'expired'
  | 'storage';
export class LiveCredentialSelectionError extends Error {
  constructor(readonly reason: SelectionFailure) {
    // Never expose paths, SQLite messages, payloads or encrypted bytes through errors.
    super(`Live credential reference rejected the operation: ${reason}.`);
  }
}
export interface LiveCredentialSelectionInput {
  readonly sourceDatabasePath: string;
  readonly providerId: string;
  readonly expectedBaseUrl: string;
  readonly model: string;
  readonly includeBrave: boolean;
}
export interface LiveCredentialReadReview {
  readonly stage: 'prepare' | 'copy';
  readonly selection: Readonly<LiveCredentialSelectionInput>;
}
export type LiveCredentialReadGate = (
  review: Readonly<LiveCredentialReadReview>,
) => boolean | Promise<boolean>;
export interface LiveCredentialSelectionDescriptor {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasBrave: boolean;
  readonly selectionSha256: string;
  readonly expiresAt: number;
  /** Metadata matching cannot authenticate the OS-encrypted envelope. */
  readonly binding: 'native-envelope-check-required';
}
const brand = Symbol('main-owned-live-credential-selection');
export type LiveCredentialSelectionToken = Readonly<{ [brand]: true }>;
export interface LiveCredentialProfile {
  readonly descriptor: Readonly<LiveCredentialSelectionDescriptor>;
  readonly isolatedRoot: string;
  readonly databasePath: string;
  close(): Promise<void>;
}
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
}
interface SelectionOwner {
  selection: Readonly<LiveCredentialSelectionInput>;
  descriptor: Readonly<LiveCredentialSelectionDescriptor>;
  file: FileIdentity;
  recordSha256: string;
  used: boolean;
}
interface ProfileOwner {
  parent: string;
  root: { dev: number; ino: number };
  database: { dev: number; ino: number };
  closed: boolean;
  closing?: Promise<void>;
  fixture?: LiveCaseFixture;
}
interface SelectedRecords {
  provider: ProviderConfig;
  providerCiphertext: Uint8Array;
  braveCiphertext?: Uint8Array;
  recordSha256: string;
}
const selections = new WeakMap<LiveCredentialSelectionToken, SelectionOwner>();
const profiles = new WeakMap<LiveCredentialProfile, ProfileOwner>();
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const MAX_DATABASE_BYTES = 256n * 1024n * 1024n;
const MAX_CIPHERTEXT_BYTES = 65536;
const providerKeys = [
  'id',
  'displayName',
  'baseUrl',
  'model',
  'timeoutMs',
  'supportsTools',
  'hasApiKey',
];
const inputKeys = ['sourceDatabasePath', 'providerId', 'expectedBaseUrl', 'model', 'includeBrave'];
function reject(reason: SelectionFailure): never {
  throw new LiveCredentialSelectionError(reason);
}
function keys(value: unknown, allowed: readonly string[], required: readonly string[] = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    reject('selection');
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}
function selectedInput(
  input: LiveCredentialSelectionInput,
): Readonly<LiveCredentialSelectionInput> {
  keys(input, inputKeys, inputKeys);
  if (
    !text(input.sourceDatabasePath, 4096) ||
    !isAbsolute(input.sourceDatabasePath) ||
    resolve(input.sourceDatabasePath) !== input.sourceDatabasePath ||
    !text(input.providerId, 100) ||
    !/^[A-Za-z0-9_-]+$/.test(input.providerId) ||
    input.providerId === 'brave-search' ||
    !text(input.expectedBaseUrl, 2048) ||
    !text(input.model, 200) ||
    typeof input.includeBrave !== 'boolean'
  )
    reject('selection');
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.expectedBaseUrl);
  } catch {
    return reject('selection');
  }
  return Object.freeze({ ...input, expectedBaseUrl: baseUrl });
}
async function readGate(
  selection: Readonly<LiveCredentialSelectionInput>,
  stage: 'prepare' | 'copy',
  gate: LiveCredentialReadGate | undefined,
  signal: AbortSignal | undefined,
) {
  signal?.throwIfAborted();
  if (typeof gate !== 'function') reject('authorization');
  let accepted = false;
  try {
    accepted = (await gate(Object.freeze({ stage, selection }))) === true;
  } catch {
    reject('authorization');
  }
  signal?.throwIfAborted();
  if (!accepted) reject('authorization');
}
function identity(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
    uid: stat.uid,
    nlink: stat.nlink,
  };
}
function sameFile(left: FileIdentity, right: FileIdentity) {
  return (Object.keys(left) as (keyof FileIdentity)[]).every((key) => left[key] === right[key]);
}
function assertPath(path: string) {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory())) reject('identity');
  }
  if (realpathSync(path) !== path) reject('identity');
}
function assertInactive(path: string) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      lstatSync(path + suffix);
      reject('active-source');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
function sourceFile(path: string): FileIdentity {
  assertPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1n ||
    stat.size > MAX_DATABASE_BYTES ||
    stat.nlink !== 1n ||
    (stat.mode & 0o077n) !== 0n ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  )
    reject('identity');
  assertInactive(path);
  return identity(stat);
}
function schema(db: DatabaseSync) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 1 && version !== 2) reject('metadata');
  for (const [name, columns] of [
    [
      'providers',
      [
        ['id', 'TEXT', 0, 1],
        ['payload', 'TEXT', 1, 0],
      ],
    ],
    [
      'credentials',
      [
        ['id', 'TEXT', 0, 1],
        ['ciphertext', 'BLOB', 1, 0],
      ],
    ],
  ] as const) {
    const definition = db.prepare('SELECT type, sql FROM sqlite_master WHERE name=?').get(name);
    if (
      definition?.type !== 'table' ||
      typeof definition.sql !== 'string' ||
      /\bVIRTUAL\b/i.test(definition.sql)
    )
      reject('metadata');
    const actual = db.prepare(`PRAGMA table_xinfo(${name})`).all();
    if (
      actual.length !== columns.length ||
      actual.some((row, index) => {
        const column = columns[index];
        return (
          row.name !== column[0] ||
          row.type !== column[1] ||
          row.notnull !== column[2] ||
          row.pk !== column[3] ||
          row.hidden !== 0
        );
      })
    )
      reject('metadata');
  }
}
function provider(value: unknown, selection: LiveCredentialSelectionInput): ProviderConfig {
  keys(value, providerKeys, providerKeys);
  const record = value as ProviderConfig;
  if (
    record.id !== selection.providerId ||
    !text(record.displayName, 80) ||
    !text(record.baseUrl, 2048) ||
    record.baseUrl !== selection.expectedBaseUrl ||
    normalizeBaseUrl(record.baseUrl) !== record.baseUrl ||
    record.model !== selection.model ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1000 ||
    record.timeoutMs > 300000 ||
    record.supportsTools !== true ||
    record.hasApiKey !== true
  )
    reject('metadata');
  return Object.freeze({ ...record });
}
function ciphertext(db: DatabaseSync, id: string): Uint8Array {
  const row = db
    .prepare(
      "SELECT ciphertext FROM credentials WHERE id=? AND typeof(ciphertext)='blob' AND length(ciphertext) BETWEEN 1 AND ?",
    )
    .get(id, MAX_CIPHERTEXT_BYTES);
  if (!(row?.ciphertext instanceof Uint8Array)) reject('credential');
  return new Uint8Array(row.ciphertext);
}
function wipe(records: SelectedRecords | undefined) {
  records?.providerCiphertext.fill(0);
  records?.braveCiphertext?.fill(0);
}
/** Requires a quiescent source; immutable fd-backed reads create no source WAL/SHM files.
 * Bun's SQLite compatibility layer does not implement this URI contract. Fail closed there.
 */
function selectedRecords(
  selection: Readonly<LiveCredentialSelectionInput>,
  expected?: FileIdentity,
): { records: SelectedRecords; file: FileIdentity } {
  if ('Bun' in globalThis || !['darwin', 'linux'].includes(process.platform)) reject('storage');
  let fd: number | undefined;
  let db: DatabaseSync | undefined;
  let records: SelectedRecords | undefined;
  try {
    const file = sourceFile(selection.sourceDatabasePath);
    if (expected && !sameFile(file, expected)) reject('stale');
    fd = openSync(selection.sourceDatabasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(file, identity(fstatSync(fd, { bigint: true })))) reject('identity');
    db = new DatabaseSync(`file:/dev/fd/${fd}?mode=ro&immutable=1`, {
      readOnly: true,
      allowExtension: false,
    });
    db.exec('BEGIN');
    schema(db);
    const row = db
      .prepare(
        'SELECT payload FROM providers WHERE id=? AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 8192',
      )
      .get(selection.providerId);
    if (typeof row?.payload !== 'string') reject('metadata');
    let metadata: ProviderConfig;
    try {
      metadata = provider(JSON.parse(row.payload), selection);
    } catch {
      return reject('metadata');
    }
    const providerCiphertext = ciphertext(db, selection.providerId);
    records = { provider: metadata, providerCiphertext, recordSha256: '' };
    if (selection.includeBrave) records.braveCiphertext = ciphertext(db, 'brave-search');
    records.recordSha256 = sha(
      JSON.stringify({
        payload: row.payload,
        provider: sha(providerCiphertext),
        brave: records.braveCiphertext ? sha(records.braveCiphertext) : null,
      }),
    );
    db.exec('COMMIT');
    db.close();
    db = undefined;
    if (
      !sameFile(file, sourceFile(selection.sourceDatabasePath)) ||
      !sameFile(file, identity(fstatSync(fd, { bigint: true })))
    )
      reject('stale');
    return { records, file };
  } catch (error) {
    wipe(records);
    if (error instanceof LiveCredentialSelectionError) throw error;
    return reject('storage');
  } finally {
    try {
      db?.close();
    } catch {}
    if (fd !== undefined) closeSync(fd);
  }
}
/** Main-only explicit-reference preparation. The callback is a trusted seam, not human proof. */
export async function prepareLiveCredentialSelection(
  input: LiveCredentialSelectionInput,
  options: { beforeRead?: LiveCredentialReadGate; signal?: AbortSignal; ttlMs?: number } = {},
): Promise<{
  descriptor: Readonly<LiveCredentialSelectionDescriptor>;
  token: LiveCredentialSelectionToken;
}> {
  keys(options, ['beforeRead', 'signal', 'ttlMs']);
  const selection = selectedInput(input);
  const gate = options.beforeRead;
  const signal = options.signal;
  const ttl = options.ttlMs ?? 300000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300000) reject('selection');
  await readGate(selection, 'prepare', gate, signal);
  const { records, file } = selectedRecords(selection);
  try {
    signal?.throwIfAborted();
    const descriptor = Object.freeze({
      providerId: selection.providerId,
      baseUrl: selection.expectedBaseUrl,
      model: selection.model,
      hasBrave: selection.includeBrave,
      selectionSha256: sha(
        JSON.stringify({
          selection,
          file: Object.fromEntries(
            Object.entries(file).map(([key, value]) => [key, String(value)]),
          ),
          recordSha256: records.recordSha256,
        }),
      ),
      expiresAt: Date.now() + ttl,
      binding: 'native-envelope-check-required' as const,
    });
    const token: LiveCredentialSelectionToken = Object.freeze({ [brand]: true });
    selections.set(token, {
      selection,
      descriptor,
      file,
      recordSha256: records.recordSha256,
      used: false,
    });
    return Object.freeze({ descriptor, token });
  } finally {
    wipe(records);
  }
}
function assertFresh(owner: SelectionOwner, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Date.now() >= owner.descriptor.expiresAt) reject('expired');
}
/** Rejects forged, replaced or already closed profile handles before main opens their store. */
export async function assertLiveCredentialProfile(profile: LiveCredentialProfile): Promise<void> {
  const owner = profiles.get(profile);
  if (!owner || owner.closed) reject('identity');
  try {
    const root = await lstat(profile.isolatedRoot);
    const database = await lstat(profile.databasePath);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== owner.root.dev ||
      root.ino !== owner.root.ino ||
      (root.mode & 0o077) !== 0 ||
      !database.isFile() ||
      database.isSymbolicLink() ||
      database.dev !== owner.database.dev ||
      database.ino !== owner.database.ino ||
      (database.mode & 0o077) !== 0 ||
      (await realpath(dirname(profile.isolatedRoot))) !== owner.parent ||
      (await realpath(profile.isolatedRoot)) !== profile.isolatedRoot ||
      (await realpath(profile.databasePath)) !== profile.databasePath
    )
      reject('identity');
  } catch (error) {
    if (error instanceof LiveCredentialSelectionError) throw error;
    reject('identity');
  }
}
/** Creates only an owned temporary profile. Never decrypts, discovers or changes source data. */
export async function copyLiveCredentialSelection(
  token: LiveCredentialSelectionToken,
  options: {
    beforeRead?: LiveCredentialReadGate;
    signal?: AbortSignal;
    fixture?: LiveCaseFixture;
  } = {},
): Promise<LiveCredentialProfile> {
  keys(options, ['beforeRead', 'signal', 'fixture']);
  const owner = selections.get(token);
  if (!owner) reject('selection');
  if (owner.used) reject('used');
  // Claim before awaiting any external review to prohibit concurrent/replayed copies.
  owner.used = true;
  const gate = options.beforeRead;
  const signal = options.signal;
  const fixture = options.fixture;
  assertFresh(owner, signal);
  await readGate(owner.selection, 'copy', gate, signal);
  assertFresh(owner, signal);
  let parent: string;
  if (fixture) {
    try {
      // Discard this snapshot: only its owner check is used, never a claimed approval event.
      await captureLiveFixtureCheckpoint(fixture, 'during-approval');
      parent = await realpath(dirname(fixture.root));
      if (parent !== dirname(fixture.root)) reject('identity');
    } catch {
      return reject('identity');
    }
  } else parent = await realpath(tmpdir());
  assertFresh(owner, signal);
  const { records } = selectedRecords(owner.selection, owner.file);
  let isolatedRoot: string | undefined;
  let createdIdentity: { dev: number; ino: number } | undefined;
  let store: ProsperoStore | undefined;
  try {
    if (records.recordSha256 !== owner.recordSha256) reject('stale');
    isolatedRoot = await mkdtemp(join(parent, 'prospero-credential-profile-'));
    await chmod(isolatedRoot, 0o700);
    isolatedRoot = await realpath(isolatedRoot);
    const root = await lstat(isolatedRoot);
    createdIdentity = { dev: root.dev, ino: root.ino };
    assertFresh(owner, signal);
    const databasePath = join(isolatedRoot, 'prospero.sqlite');
    store = new ProsperoStore(databasePath);
    store.saveProvider(records.provider);
    store.saveEncryptedCredential(records.provider.id, records.providerCiphertext);
    if (records.braveCiphertext)
      store.saveEncryptedCredential('brave-search', records.braveCiphertext);
    store.close();
    store = undefined;
    assertFresh(owner, signal);
    const database = await lstat(databasePath);
    const profile: LiveCredentialProfile = Object.freeze({
      descriptor: owner.descriptor,
      isolatedRoot,
      databasePath,
      async close() {
        const current = profiles.get(profile);
        if (!current || current.closed) return;
        const cleanup = async () => {
          await assertLiveCredentialProfile(profile);
          await rm(profile.isolatedRoot, { recursive: true, force: false });
          current.closed = true;
        };
        current.closing ??= current.fixture
          ? runLiveFixtureProfileCleanup(current.fixture, cleanup)
          : cleanup();
        const operation = current.closing;
        try {
          await operation;
        } finally {
          // A refused live-child lease performed no cleanup; permit a retry after actual exit.
          if (!current.closed && current.closing === operation) current.closing = undefined;
        }
      },
    });
    profiles.set(profile, {
      parent,
      root: createdIdentity,
      database: { dev: database.dev, ino: database.ino },
      closed: false,
      fixture,
    });
    await assertLiveCredentialProfile(profile);
    return profile;
  } catch (error) {
    try {
      store?.close();
    } catch {}
    if (isolatedRoot && createdIdentity) {
      try {
        const current = await lstat(isolatedRoot);
        if (
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === createdIdentity.dev &&
          current.ino === createdIdentity.ino &&
          (await realpath(dirname(isolatedRoot))) === parent
        )
          await rm(isolatedRoot, { recursive: true, force: false });
      } catch {}
    }
    if (error instanceof LiveCredentialSelectionError || (error as Error).name === 'AbortError')
      throw error;
    return reject('storage');
  } finally {
    wipe(records);
  }
}
