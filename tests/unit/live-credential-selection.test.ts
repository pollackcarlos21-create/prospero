import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// This main-only importer needs actual node:sqlite URI semantics, not Bun's compatibility shim.
// Every child creates fake ciphertext in owned temp databases; no native crypto or HTTP is used.
const execute = promisify(execFile);
let buildRoot: string;
let moduleUrl: string;
beforeAll(async () => {
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-credential-selection-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(resolve('tests/acceptance/live-credential-selection.ts'))};
     export { createLiveFixture } from ${JSON.stringify(resolve('tests/acceptance/live-fixtures.ts'))};`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!result.success) throw new Error('Could not compile the owned native SQLite test entry.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(code: string) {
  const prefix = `
  import assert from 'node:assert/strict';
  import { DatabaseSync } from 'node:sqlite';
  import { createHash } from 'node:crypto';
  import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { dirname, join } from 'node:path';
  import { prepareLiveCredentialSelection as prepare, copyLiveCredentialSelection as copy,
    assertLiveCredentialProfile as owned, createLiveFixture } from ${JSON.stringify(moduleUrl)};
  const dispose = [];
  const approved = { beforeRead: () => true };
  const selected = { providerId: 'selected', expectedBaseUrl: 'https://api.example.test/v1',
    model: 'offline-model', includeBrave: true };
  const metadata = { id: selected.providerId, displayName: 'Offline provider',
    baseUrl: selected.expectedBaseUrl, model: selected.model, timeoutMs: 60000,
    supportsTools: true, hasApiKey: true };
  const encrypted = Uint8Array.from([19, 88, 35, 42]);
  const brave = Uint8Array.from([91, 47, 33]);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function fixture(options = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'prospero-source-reference-')));
    chmodSync(root, 0o700);
    dispose.push(() => rmSync(root, { recursive: true, force: true }));
    const sourceDatabasePath = join(root, 'source.sqlite');
    const db = new DatabaseSync(sourceDatabasePath);
    db.exec('CREATE TABLE providers (id TEXT PRIMARY KEY,payload TEXT NOT NULL);' +
      'CREATE TABLE credentials (id TEXT PRIMARY KEY,ciphertext BLOB NOT NULL);' +
      'CREATE TABLE conversations (id TEXT,payload TEXT);CREATE TABLE settings(key TEXT,payload TEXT);' +
      'PRAGMA user_version=2;');
    db.prepare('INSERT INTO providers VALUES(?,?)').run('selected', JSON.stringify(metadata));
    db.prepare('INSERT INTO providers VALUES(?,?)').run('unselected', 'unrelated invalid JSON');
    db.prepare('INSERT INTO credentials VALUES(?,?)').run('selected', encrypted);
    db.prepare('INSERT INTO credentials VALUES(?,?)').run('brave-search', brave);
    db.prepare('INSERT INTO credentials VALUES(?,?)').run('unselected', Uint8Array.from([222,223]));
    db.prepare('INSERT INTO conversations VALUES(?,?)').run('private', 'private fixture body');
    db.prepare('INSERT INTO settings VALUES(?,?)').run('private', 'private setting');
    if (options.wal) db.exec('PRAGMA journal_mode=WAL;');
    db.close();chmodSync(sourceDatabasePath, 0o600);
    return { root, sourceDatabasePath, input: { sourceDatabasePath, ...selected } };
  }
  function edit(path, callback) { const db = new DatabaseSync(path);try{callback(db);}finally{db.close();} }
  async function reason(promise, expected) {
    await assert.rejects(promise, (error) => {
      assert.equal(error.reason, expected); assert(!error.message.includes('source.sqlite'));
      return true;
    });
  }
  try { ${code} }
  finally { for (const close of dispose.reverse()) await close(); }
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', prefix], {
      timeout: 20000,
      maxBuffer: 32768,
    });
    expect(result.stdout).toBe('');
  } catch (error) {
    // Avoid echoing the full child script (or query fixtures) in the parent test output.
    const diagnostic = (error as { stderr?: string }).stderr ?? 'Native test child did not finish.';
    throw new Error(`Native credential selection test failed:\n${diagnostic.slice(0, 8192)}`);
  }
}

test('missing or denied trusted review stops before source filesystem access, including copy', async () => {
  await native(`
    const input = { sourceDatabasePath: '/not-a-source/database.sqlite', ...selected };
    await reason(prepare(input), 'authorization');
    await reason(prepare(input, { beforeRead: () => false }), 'authorization');
    await reason(prepare(input, { beforeRead: () => { throw new Error('private callback'); } }), 'authorization');
    const f = fixture();
    const prepared = await prepare(f.input, approved);
    await reason(copy(prepared.token), 'authorization');
    await reason(copy(prepared.token, approved), 'used');
  `);
});

test('native immutable WAL reads copy only selected encrypted records and preserve the source bytes', async () => {
  await native(`
    const f = fixture({ wal: true });
    const before = hash(readFileSync(f.sourceDatabasePath));
    const entries = readdirSync(f.root);
    const reviews = [];
    const review = { beforeRead: (request) => { reviews.push(request.stage); assert(Object.isFrozen(request));
      assert(Object.isFrozen(request.selection));return true; } };
    const prepared = await prepare(f.input, review);
    assert(Object.isFrozen(prepared));assert(Object.isFrozen(prepared.descriptor));
    assert.equal(prepared.descriptor.binding, 'native-envelope-check-required');
    const exported = JSON.stringify(prepared);
    assert(!exported.includes(f.sourceDatabasePath));assert(!exported.includes('ciphertext'));
    const profile = await copy(prepared.token, review);dispose.push(() => profile.close());
    await owned(profile);
    assert.notEqual(profile.databasePath, f.sourceDatabasePath);
    assert.equal(lstatSync(profile.isolatedRoot).mode & 0o777, 0o700);
    assert.equal(lstatSync(profile.databasePath).mode & 0o777, 0o600);
    const db = new DatabaseSync(profile.databasePath);
    try {
      assert.deepEqual(db.prepare('SELECT id FROM providers ORDER BY id').all().map((r) => r.id), ['selected']);
      assert.deepEqual(db.prepare('SELECT id FROM credentials ORDER BY id').all().map((r) => r.id), ['brave-search','selected']);
      assert.deepEqual([...db.prepare('SELECT ciphertext FROM credentials WHERE id=?').get('selected').ciphertext], [...encrypted]);
      assert.deepEqual([...db.prepare('SELECT ciphertext FROM credentials WHERE id=?').get('brave-search').ciphertext], [...brave]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
    } finally { db.close(); }
    assert.deepEqual(reviews, ['prepare','copy']);
    assert.equal(hash(readFileSync(f.sourceDatabasePath)), before);
    assert.deepEqual(readdirSync(f.root), entries);
    await Promise.all([profile.close(), profile.close()]);await profile.close();
    assert(!existsSync(profile.isolatedRoot));await reason(owned(profile), 'identity');
  `);
});

test('not selecting Brave never reads or copies malformed unrelated credentials or private settings', async () => {
  await native(`
    const f = fixture(); edit(f.sourceDatabasePath, (db) => {
      db.prepare('UPDATE credentials SET ciphertext=? WHERE id=?').run('', 'brave-search');
    });
    const prepared = await prepare({ ...f.input, includeBrave: false }, approved);
    assert.equal(prepared.descriptor.hasBrave, false);
    const profile = await copy(prepared.token, approved);dispose.push(() => profile.close());
    const db = new DatabaseSync(profile.databasePath);
    assert.deepEqual(db.prepare('SELECT id FROM credentials').all().map((r) => r.id), ['selected']);db.close();
  `);
});

test('endpoint normalization binds the exact stored endpoint and model without replacing metadata', async () => {
  await native(`
    const f = fixture();
    await reason(prepare({ ...f.input, expectedBaseUrl:'https://other.example.test/v1' }, approved), 'metadata');
    await reason(prepare({ ...f.input, model:'another-model' }, approved), 'metadata');
    const good = await prepare({ ...f.input, expectedBaseUrl:'https://api.example.test/v1/chat/completions' }, approved);
    assert.equal(good.descriptor.baseUrl, selected.expectedBaseUrl);
    await reason(prepare({ ...f.input, expectedBaseUrl:'https://secret@api.example.test/v1' }, approved), 'selection');
    await reason(prepare({ ...f.input, providerId:'brave-search' }, approved), 'selection');
    for (const update of [
      { baseUrl: metadata.baseUrl + '/' }, { id:'different' }, { supportsTools:false },
      { hasApiKey:false }, { apiKey:'forbidden-payload' }, { timeoutMs:0 }
    ]) {
      edit(f.sourceDatabasePath, (db) => db.prepare('UPDATE providers SET payload=? WHERE id=?').run(JSON.stringify({ ...metadata,...update }), 'selected'));
      await reason(prepare(f.input, approved), 'metadata');
    }
  `);
});

test('selected credential and provider payloads have strict type, size and schema bounds', async () => {
  await native(`
    for (const value of [new Uint8Array(), new Uint8Array(65537), 'not-encrypted-blob']) {
      const f = fixture();edit(f.sourceDatabasePath, (db) => db.prepare('UPDATE credentials SET ciphertext=? WHERE id=?').run(value, 'selected'));
      await reason(prepare(f.input, approved), 'credential');
    }
    const f = fixture();edit(f.sourceDatabasePath, (db) => db.prepare('UPDATE providers SET payload=? WHERE id=?').run(' '.repeat(8193), 'selected'));
    await reason(prepare(f.input, approved), 'metadata');
    const future = fixture();edit(future.sourceDatabasePath, (db) => db.exec('PRAGMA user_version=3'));
    await reason(prepare(future.input, approved), 'metadata');
    const view = fixture();edit(view.sourceDatabasePath, (db) => db.exec('ALTER TABLE providers RENAME TO hidden_providers;CREATE VIEW providers AS SELECT * FROM hidden_providers;'));
    await reason(prepare(view.input, approved), 'metadata');
    const missing = fixture();edit(missing.sourceDatabasePath, (db) => db.prepare('DELETE FROM credentials WHERE id=?').run('brave-search'));
    await reason(prepare(missing.input, approved), 'credential');
  `);
});

test('file, directory symlinks, hardlinks and loose permissions cannot become an approved source', async () => {
  await native(`
    const f = fixture();const link = join(f.root,'linked.sqlite');symlinkSync(f.sourceDatabasePath,link);
    await reason(prepare({ ...f.input, sourceDatabasePath:link }, approved), 'identity');
    const parentLink = join(f.root,'parent-link');symlinkSync(f.root,parentLink);
    await reason(prepare({ ...f.input, sourceDatabasePath:join(parentLink,'source.sqlite') }, approved), 'identity');
    const hard = join(f.root,'hard.sqlite');linkSync(f.sourceDatabasePath,hard);
    await reason(prepare(f.input, approved), 'identity');rmSync(hard);
    chmodSync(f.sourceDatabasePath,0o644);await reason(prepare(f.input, approved),'identity');
    chmodSync(f.sourceDatabasePath,0o600);
    await reason(prepare({ ...f.input, sourceDatabasePath:f.root+'/folder/../source.sqlite' }, approved), 'selection');
  `);
});

test('active WAL, SHM or rollback journals are rejected without checkpointing or creating sidecars', async () => {
  await native(`
    for (const suffix of ['-wal','-shm','-journal']) {
      const f = fixture();writeFileSync(f.sourceDatabasePath + suffix,'fixture activity');
      const before = readdirSync(f.root);const original = hash(readFileSync(f.sourceDatabasePath));
      await reason(prepare(f.input,approved),'active-source');
      assert.deepEqual(readdirSync(f.root),before);assert.equal(hash(readFileSync(f.sourceDatabasePath)),original);
    }
    const live = fixture({wal:true});const writer = new DatabaseSync(live.sourceDatabasePath);
    try {
      writer.exec('BEGIN IMMEDIATE;');writer.prepare('UPDATE providers SET payload=payload WHERE id=?').run('selected');
      const files = readdirSync(live.root);await reason(prepare(live.input,approved),'active-source');
      assert.deepEqual(readdirSync(live.root),files);
    } finally { writer.exec('ROLLBACK');writer.close(); }
  `);
});

test('source replacement or any database change needs a freshly reviewed selection', async () => {
  await native(`
    for (const mutate of [
      (f) => edit(f.sourceDatabasePath,(db) => db.prepare('UPDATE credentials SET ciphertext=? WHERE id=?').run(Uint8Array.from([1,2,3]),'selected')),
      (f) => edit(f.sourceDatabasePath,(db) => db.prepare('UPDATE providers SET payload=? WHERE id=?').run(JSON.stringify({...metadata,displayName:'New'}),'selected')),
      (f) => {renameSync(f.sourceDatabasePath,f.sourceDatabasePath+'.old');writeFileSync(f.sourceDatabasePath,readFileSync(f.sourceDatabasePath+'.old'),{mode:0o600});},
      (f) => edit(f.sourceDatabasePath,(db) => db.prepare('INSERT INTO settings VALUES (?,?)').run('changed','unselected change'))
    ]) {
      const f=fixture();const prepared=await prepare(f.input,approved);mutate(f);
      await reason(copy(prepared.token,approved),'stale');await reason(copy(prepared.token,approved),'used');
    }
    const f=fixture();const prepared=await prepare(f.input,approved);
    await reason(copy(prepared.token,{beforeRead:() => {
      writeFileSync(f.sourceDatabasePath+'-wal','new activity');return true;
    }}),'active-source');
  `);
});

test('selection tokens cannot be forged, replayed or raced while trusted approval is pending', async () => {
  await native(`
    await reason(copy({},approved),'selection');
    const f=fixture();const prepared=await prepare(f.input,approved);
    let release;const first=copy(prepared.token,{beforeRead:() => new Promise((resolve) => {release=resolve;})});
    await reason(copy(prepared.token,approved),'used');release(true);
    const profile=await first;dispose.push(() => profile.close());await reason(copy(prepared.token,approved),'used');
  `);
});

test('expired or cancelled selections never create a destination and do not export native envelopes', async () => {
  await native(`
    const f=fixture();const prepared=await prepare(f.input,{...approved,ttlMs:1000});
    const originalNow=Date.now;Date.now=() => prepared.descriptor.expiresAt;
    try{await reason(copy(prepared.token,approved),'expired');}finally{Date.now=originalNow;}
    const controller=new AbortController();controller.abort();
    await assert.rejects(prepare(f.input,{...approved,signal:controller.signal}),{name:'AbortError'});
    const second=await prepare(f.input,approved);
    const during=new AbortController();await assert.rejects(copy(second.token,{signal:during.signal,beforeRead:() => {during.abort();return true;}}),{name:'AbortError'});
    assert.deepEqual(readdirSync(f.root),['source.sqlite']);
  `);
});

test('profile cleanup rejects a replaced root, forged handle or replaced database', async () => {
  await native(`
    const f=fixture();const prepared=await prepare(f.input,approved);const profile=await copy(prepared.token,approved);
    const moved=profile.isolatedRoot+'.owned';renameSync(profile.isolatedRoot,moved);mkdirSync(profile.isolatedRoot,{mode:0o700});
    writeFileSync(join(profile.isolatedRoot,'sentinel.txt'),'replacement must survive');
    await reason(profile.close(),'identity');assert(existsSync(join(profile.isolatedRoot,'sentinel.txt')));
    await reason(owned({...profile}),'identity');
    // Both test directories are synthetic; explicitly clean without asking the rejected handle to delete replacements.
    rmSync(profile.isolatedRoot,{recursive:true});rmSync(moved,{recursive:true});
    const second=await prepare(f.input,approved);const profile2=await copy(second.token,approved);
    renameSync(profile2.databasePath,profile2.databasePath+'.old');writeFileSync(profile2.databasePath,'replacement',{mode:0o600});
    await reason(owned(profile2),'identity');await reason(profile2.close(),'identity');
    assert.equal(readFileSync(profile2.databasePath,'utf8'),'replacement');rmSync(profile2.isolatedRoot,{recursive:true});
  `);
});

test('fixture-branded placement is limited to its owned parent and rejects copied or closed fixtures', async () => {
  await native(`
    const f=fixture();const caseFixture=await createLiveFixture('F01');dispose.push(() => caseFixture.close());
    const prepared=await prepare(f.input,approved);const profile=await copy(prepared.token,{...approved,fixture:caseFixture});
    dispose.push(() => profile.close());assert.equal(dirname(profile.isolatedRoot),dirname(caseFixture.root));await owned(profile);
    const forged=await prepare(f.input,approved);await reason(copy(forged.token,{...approved,fixture:{...caseFixture}}),'identity');
    await profile.close();await caseFixture.close();
    const closed=await prepare(f.input,approved);await reason(copy(closed.token,{...approved,fixture:caseFixture}),'identity');
  `);
});
