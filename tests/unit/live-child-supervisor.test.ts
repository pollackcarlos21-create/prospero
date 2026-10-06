import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let buildRoot: string;
let moduleUrl: string;
beforeAll(async () => {
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-child-supervisor-tests-')));
  const build = await Bun.build({
    entrypoints: [resolve('tests/acceptance/live-child-supervisor.ts')],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!build.success) throw new Error('Could not compile the controlled Node worker supervisor.');
  moduleUrl = pathToFileURL(join(buildRoot, 'live-child-supervisor.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(code: string) {
  const program = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { performance } from 'node:perf_hooks';
    import { superviseLiveChild as supervise, assertLiveChildOutcome as owned } from ${JSON.stringify(moduleUrl)};
    const roots = [];
    function fixture(source) {
      const cwd=realpathSync(mkdtempSync(join(tmpdir(),'prospero-controlled-child-')));chmodSync(cwd,0o700);roots.push(cwd);
      const entryPath=join(cwd,'worker.cjs');writeFileSync(entryPath,source,{flag:'wx',mode:0o600});
      return {cwd,entryPath,expectedEntrySha256:createHash('sha256').update(source).digest('hex'),
        execPath:realpathSync(process.execPath),deadlineMs:3000};
    }
    function dead(outcome) {
      assert.equal(outcome.spawned,true);assert.equal(outcome.exitObserved,true);assert.equal(outcome.closeObserved,true);
      assert.equal(outcome.settled,true);assert(Number.isSafeInteger(outcome.pid));
      assert.throws(() => process.kill(outcome.pid,0),(error) => error.code==='ESRCH');
    }
    try { ${code} }
    finally { for(const root of roots.reverse()) rmSync(root,{recursive:true,force:true}); }
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', program], {
      timeout: 15000,
      maxBuffer: 16384,
    });
    expect(result.stdout).toBe('');
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? 'Controlled child test did not finish.';
    // No full argv/environment/script echo in the parent test report.
    throw new Error(`Controlled child supervisor test failed:\n${stderr.slice(0, 8192)}`);
  }
}

test('actual Node exit 23 and close determine a branded result, with fixed flags and minimal environment', async () => {
  await native(`
    process.env.PRIVATE_FIXTURE_MARKER='fake environment secret';process.env.NODE_OPTIONS='--invalid-uninherited-flag';
    const options=fixture("if(process.execArgv.length||process.env.NODE_OPTIONS||process.env.PRIVATE_FIXTURE_MARKER)process.exit(2);"+
      "process.send({version:1,type:'exit-intent',code:23},()=>process.exit(23));");
    const outcome=await supervise(options);dead(outcome);
    assert.equal(outcome.reason,'exited');assert.equal(outcome.actualExitCode,23);assert.equal(outcome.actualExitSignal,null);
    assert.equal(outcome.entrySha256,options.expectedEntrySha256);assert.match(outcome.execSha256,/^[a-f0-9]{64}$/);
    assert(Object.isFrozen(outcome));assert(Object.isFrozen(outcome.messages));
    owned(outcome,{entrySha256:options.expectedEntrySha256,execSha256:outcome.execSha256,pid:outcome.pid,exitCode:23});
    assert(!JSON.stringify(outcome).includes('fake environment secret'));
  `);
});

test('a self-reported exit intention followed by actual exit zero cannot satisfy the crash barrier', async () => {
  await native(`
    const outcome=await supervise(fixture("process.send({version:1,type:'exit-intent',code:23},()=>process.exit(0));"));
    dead(outcome);assert.equal(outcome.actualExitCode,0);assert.equal(outcome.messages[0].code,23);
    assert.throws(()=>owned(outcome,{exitCode:23}));owned(outcome,{exitCode:0});
  `);
});

test('actual outcomes cannot be forged from JSON, copied objects or mismatched worker identity', async () => {
  await native(`
    const options=fixture('process.exit(23);');const outcome=await supervise(options);dead(outcome);
    assert.throws(()=>owned({...outcome}));assert.throws(()=>owned(JSON.parse(JSON.stringify(outcome))));
    assert.throws(()=>owned(outcome,{entrySha256:'f'.repeat(64)}));
    assert.throws(()=>owned(outcome,{execSha256:'f'.repeat(64)}));assert.throws(()=>owned(outcome,{pid:outcome.pid+1}));
    assert.throws(()=>owned({actualExitCode:23,closeObserved:true,settled:true}));
  `);
});

test('aborting a hung owned child waits for actual SIGKILL exit rather than successful kill return', async () => {
  await native(`
    const controller=new AbortController();const started=performance.now();
    const outcome=await supervise({...fixture("process.on('SIGTERM',()=>{});process.send({version:1,type:'ready'});setInterval(()=>{},1000);"),
      signal:controller.signal,onMessage:(message)=>{if(message.type==='ready')controller.abort();}});
    dead(outcome);assert.equal(outcome.reason,'aborted');assert.equal(outcome.actualExitSignal,'SIGKILL');
    assert(performance.now()-started>=90);assert.equal(outcome.actualExitCode,null);
  `);
});

test('a finite monotonic deadline terminates a hanging worker despite wall-clock changes', async () => {
  await native(`
    const original=Date.now;Date.now=()=>1;const started=performance.now();
    try {
      const outcome=await supervise({...fixture("process.on('SIGTERM',()=>{});process.send({version:1,type:'ready'});setInterval(()=>{},1000);"),deadlineMs:250});
      dead(outcome);assert.equal(outcome.reason,'timeout');assert.equal(outcome.actualExitSignal,'SIGKILL');
      assert(performance.now()-started>=240);assert(performance.now()-started<2000);
    }finally{Date.now=original;}
  `);
});

test('IPC closure stops a still-running child but natural exit remains an actual exit', async () => {
  await native(`
    const outcome=await supervise(fixture("process.on('SIGTERM',()=>{});process.send({version:1,type:'ready'},()=>process.disconnect());setInterval(()=>{},1000);"));
    dead(outcome);assert.equal(outcome.reason,'ipc-closed');assert.equal(outcome.actualExitSignal,'SIGKILL');
    const exited=await supervise(fixture('process.exit(23);'));dead(exited);assert.equal(exited.reason,'exited');assert.equal(exited.actualExitCode,23);
  `);
});

test('late child messages after abort cannot become accepted control facts', async () => {
  await native(`
    const controller=new AbortController();let observed=0;
    const code="process.on('SIGTERM',()=>{setTimeout(()=>process.send({version:1,type:'exit-intent',code:23}),20);});"+
      "process.send({version:1,type:'ready'});setInterval(()=>{},1000);";
    const outcome=await supervise({...fixture(code),signal:controller.signal,onMessage:()=>{observed++;controller.abort();}});
    dead(outcome);assert.equal(outcome.reason,'aborted');assert.equal(outcome.actualExitSignal,'SIGKILL');
    assert.equal(observed,1);assert.deepEqual(outcome.messages,[{version:1,type:'ready'}]);
  `);
});

test('oversized, extra-field and invalid IPC data stop before the observer receives private data', async () => {
  await native(`
    for(const value of [
      {version:1,type:'ready',body:'private payload'.repeat(50000)},
      {version:1,type:'boundary',caseId:'C07',phaseId:'initial',boundaryId:'process-exit-after-effect-before-journal',planId:'x'.repeat(3000),actionId:'a'},
      {version:1,type:'exit-intent',code:0},'unknown reflected private string'
    ]){
      let observed=0;const outcome=await supervise({...fixture('process.send('+JSON.stringify(value)+');setInterval(()=>{},1000);'),onMessage:()=>{observed++;}});
      dead(outcome);assert.equal(outcome.reason,'protocol');assert.equal(observed,0);assert.equal(outcome.messages.length,0);
      assert(!JSON.stringify(outcome).includes('private payload'));assert(!JSON.stringify(outcome).includes('private string'));
    }
  `);
});

test('control count and combined output caps are enforced without retaining stdout or stderr text', async () => {
  await native(`
    const flood=await supervise(fixture("for(let i=0;i<100;i++)process.send({version:1,type:'ready'});setInterval(()=>{},1000);"));
    dead(flood);assert.equal(flood.reason,'protocol');assert.equal(flood.messages.length,64);assert(flood.acceptedControlBytes<=32768);
    const output=await supervise(fixture("process.stdout.write('private stdout fixture'.repeat(3000));process.stderr.write('private stderr fixture'.repeat(3000));setInterval(()=>{},1000);"));
    dead(output);assert.equal(output.reason,'output-limit');assert.equal(output.outputLimitExceeded,true);
    assert.equal(output.outputBytesObservedAtLeast,32769);
    assert(!JSON.stringify(output).includes('private stdout'));assert(!JSON.stringify(output).includes('private stderr'));
  `);
});

test('spawn failure has no forged exit status and is classified without reflected native error details', async () => {
  await native(`
    const options=fixture('process.exit(23);');const bad=join(options.cwd,'invalid-native-executable');
    writeFileSync(bad,Buffer.from([0,1,2,3,4]),{mode:0o700});
    const outcome=await supervise({...options,execPath:bad});
    assert.equal(outcome.reason,'spawn-error');assert.equal(outcome.spawned,false);assert.equal(outcome.exitObserved,false);
    assert.equal(outcome.actualExitCode,null);assert.equal(outcome.actualExitSignal,null);assert.equal(outcome.pid,null);
    owned(outcome);assert.throws(()=>owned(outcome,{exitCode:23}));assert(!JSON.stringify(outcome).includes('invalid-native-executable'));
  `);
});

test('source digest drift, symlinks or pre-abort stop before any worker execution', async () => {
  await native(`
    const options=fixture('process.exit(23);');const drift=await supervise({...options,expectedEntrySha256:'f'.repeat(64)});
    assert.equal(drift.reason,'identity-changed');assert.equal(drift.spawned,false);assert.equal(drift.closeObserved,false);
    const link=join(options.cwd,'linked.cjs');symlinkSync(options.entryPath,link);
    const linked=await supervise({...options,entryPath:link});assert.equal(linked.reason,'spawn-error');assert.equal(linked.spawned,false);
    const controller=new AbortController();controller.abort();const aborted=await supervise({...options,signal:controller.signal});
    assert.equal(aborted.reason,'aborted');assert.equal(aborted.spawned,false);assert.equal(aborted.entrySha256,null);
    await assert.rejects(supervise({...options,deadlineMs:Infinity}),/controlled worker/);
  `);
});

test('safe boundary IDs are observed without gaining authority and observer errors wait for child settlement', async () => {
  await native(`
    const message={version:1,type:'boundary',caseId:'C07',phaseId:'initial',boundaryId:'process-exit-after-effect-before-journal',planId:'plan-1',actionId:'action-1'};
    const outcome=await supervise(fixture('process.send('+JSON.stringify(message)+',()=>process.exit(23));'));dead(outcome);
    assert.deepEqual(outcome.messages,[message]);assert(Object.isFrozen(outcome.messages[0]));
    const error=await supervise({...fixture("process.send({version:1,type:'ready'});setInterval(()=>{},1000);"),onMessage:()=>{throw new Error('private observer');}});
    dead(error);assert.equal(error.reason,'observer-error');assert(!JSON.stringify(error).includes('private observer'));
    const asyncError=await supervise({...fixture("process.send({version:1,type:'ready'});setInterval(()=>{},1000);"),onMessage:()=>Promise.reject(new Error('private late observer'))});
    dead(asyncError);assert.equal(asyncError.reason,'observer-error');
  `);
});
