import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let buildRoot: string;
let moduleUrl: string;
beforeAll(async () => {
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-fixture-custody-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(resolve('tests/acceptance/live-fixtures.ts'))};\n` +
      `export * from ${JSON.stringify(resolve('tests/acceptance/live-child-supervisor.ts'))};\n`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!build.success) throw new Error('Could not compile owned fixture custody tests.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(code: string) {
  const program = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { createLiveFixture, captureLiveFixtureCheckpoint, superviseLiveFixtureChild as supervise,
      assertLiveFixtureChildOutcome as bound, assertLiveChildOutcome as processOwned,
      runLiveFixtureProfileCleanup } from ${JSON.stringify(moduleUrl)};
    const fixtures=[];
    async function owned(caseId='C07'){const value=await createLiveFixture(caseId);fixtures.push(value);return value;}
    function worker(fixture,source){const cwd=join(dirname(fixture.root),'worker');mkdirSync(cwd,{mode:0o700});
      const entryPath=join(cwd,'entry.cjs');writeFileSync(entryPath,source,{mode:0o600,flag:'wx'});
      return {cwd,entryPath,expectedEntrySha256:createHash('sha256').update(source).digest('hex'),
        execPath:realpathSync(process.execPath),deadlineMs:3000};}
    function exited(outcome){assert(outcome.spawned);assert(outcome.exitObserved);assert(outcome.closeObserved);
      assert.equal(outcome.settled,true);assert.throws(()=>process.kill(outcome.pid,0),error=>error.code==='ESRCH');}
    try { ${code} }
    finally {for(const fixture of fixtures.reverse()) await fixture.close();}
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', program], {
      timeout: 15000,
      maxBuffer: 16384,
    });
    expect(result.stdout).toBe('');
  } catch (error) {
    const stderr =
      (error as { stderr?: string }).stderr ?? 'Owned fixture custody test did not finish.';
    throw new Error(`Owned fixture custody test failed:\n${stderr.slice(0, 8192)}`);
  }
}

test('custody is registered before the first await; close and duplicate workers reject until actual exit and close', async () => {
  await native(`
    const fixture=await owned();const options=worker(fixture,"process.send({version:1,type:'ready'});setTimeout(()=>process.exit(23),200);");
    const running=supervise(fixture,options);
    await assert.rejects(fixture.close(),/invalid/);assert(existsSync(fixture.root));
    await assert.rejects(supervise(fixture,options),/invalid/);
    const outcome=await running;exited(outcome);bound(fixture,outcome);processOwned(outcome,{exitCode:23});
    assert.equal(outcome.actualExitCode,23);assert(existsSync(join(fixture.root,'.preserve/sentinel.bin')));
    await captureLiveFixtureCheckpoint(fixture,'after-crash');
    await fixture.close();assert(!existsSync(fixture.root));
    assert.throws(()=>bound(fixture,outcome),/invalid/);
  `);
});

test('a close awaiting filesystem ownership rechecks a newly claimed custody lease before removing anything', async () => {
  await native(`
    const fixture=await owned();const options=worker(fixture,'setTimeout(()=>process.exit(0),200);');
    const closing=fixture.close();const running=supervise(fixture,options);
    await assert.rejects(closing,/invalid/);assert(existsSync(fixture.root));
    const outcome=await running;exited(outcome);bound(fixture,outcome);assert.equal(outcome.actualExitCode,0);
    await fixture.close();assert(!existsSync(fixture.root));
  `);
});

test('copied, forged and cross-fixture outcomes cannot prove parent custody or turn self-report into exit 23', async () => {
  await native(`
    const fixture=await owned();const other=await owned();
    const options=worker(fixture,"process.send({version:1,type:'exit-intent',code:23},()=>process.exit(0));");
    const outcome=await supervise(fixture,options);exited(outcome);bound(fixture,outcome);
    assert.equal(outcome.actualExitCode,0);assert.throws(()=>processOwned(outcome,{exitCode:23}));
    assert.throws(()=>bound(fixture,{...outcome}),/invalid/);
    assert.throws(()=>bound(fixture,JSON.parse(JSON.stringify(outcome))),/invalid/);
    assert.throws(()=>bound(other,outcome),/invalid/);
    assert.throws(()=>bound({...fixture},outcome),/invalid/);
    assert.throws(()=>bound(fixture,{spawned:true,settled:true,actualExitCode:23}),/invalid/);
    await fixture.close();await other.close();
  `);
});

test('forged, closed and non-C07 fixtures reject before process startup and do not delete an active fixture', async () => {
  await native(`
    const fixture=await owned();const nonCrash=await owned('F02');
    const marker=join(dirname(fixture.root),'should-not-run');
    const options=worker(fixture,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"ran");process.exit(0);');
    await assert.rejects(supervise({...fixture},options),/invalid/);
    await assert.rejects(supervise(nonCrash,options),/invalid/);
    assert(!existsSync(marker));await fixture.close();
    await assert.rejects(supervise(fixture,options),/invalid/);assert(!existsSync(marker));
  `);
});

test('abort retains cleanup custody until the real hanging worker receives SIGKILL and both events are observed', async () => {
  await native(`
    const fixture=await owned();const controller=new AbortController();let closeProbe;
    const options=worker(fixture,"process.on('SIGTERM',()=>{});process.send({version:1,type:'ready'});setInterval(()=>{},1000);");
    const outcome=await supervise(fixture,{...options,signal:controller.signal,onMessage:()=>{
      closeProbe=fixture.close().then(()=>{throw new Error('Premature cleanup');},()=>{assert(existsSync(fixture.root));});
      controller.abort();
    }});
    await closeProbe;exited(outcome);bound(fixture,outcome);assert.equal(outcome.reason,'aborted');
    assert.equal(outcome.actualExitSignal,'SIGKILL');await fixture.close();assert(!existsSync(fixture.root));
  `);
});

test('deadline timeout releases custody only after actual termination, while an aborted-before-spawn outcome is also bound', async () => {
  await native(`
    const fixture=await owned();const options=worker(fixture,"process.on('SIGTERM',()=>{});process.send({version:1,type:'ready'});setInterval(()=>{},1000);");
    const running=supervise(fixture,{...options,deadlineMs:200});await assert.rejects(fixture.close(),/invalid/);
    const outcome=await running;exited(outcome);bound(fixture,outcome);assert.equal(outcome.reason,'timeout');
    assert.equal(outcome.actualExitSignal,'SIGKILL');
    const controller=new AbortController();controller.abort();
    const noSpawn=await supervise(fixture,{...options,signal:controller.signal});bound(fixture,noSpawn);
    assert.equal(noSpawn.spawned,false);assert.equal(noSpawn.exitObserved,false);assert.equal(noSpawn.actualExitCode,null);
    assert.throws(()=>bound(fixture,outcome),/invalid/);assert.throws(()=>processOwned(noSpawn,{exitCode:23}));
    await fixture.close();assert(!existsSync(fixture.root));
  `);
});

test('captured launch options cannot be mutated during awaited fixture validation; prelaunch identity failure leaves no live lease', async () => {
  await native(`
    const fixture=await owned();const options=worker(fixture,'process.exit(23);');
    const running=supervise(fixture,options);options.expectedEntrySha256='0'.repeat(64);
    const outcome=await running;exited(outcome);bound(fixture,outcome);assert.equal(outcome.actualExitCode,23);
    const noSpawn=await supervise(fixture,options);bound(fixture,noSpawn);
    assert.equal(noSpawn.spawned,false);assert.equal(noSpawn.reason,'identity-changed');
    await fixture.close();assert(!existsSync(fixture.root));
  `);
});

test('selected-profile cleanup claims parent custody before awaiting and prevents a new worker or whole-root removal', async () => {
  await native(`
    const fixture=await owned();const options=worker(fixture,'process.exit(0);');
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const cleaning=runLiveFixtureProfileCleanup(fixture,()=>gate);
    await assert.rejects(supervise(fixture,options),/invalid/);
    await assert.rejects(fixture.close(),/invalid/);assert(existsSync(fixture.root));
    release();await cleaning;
    const outcome=await supervise(fixture,options);exited(outcome);bound(fixture,outcome);
    await fixture.close();assert(!existsSync(fixture.root));
  `);
});
