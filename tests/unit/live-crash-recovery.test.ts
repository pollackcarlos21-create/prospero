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
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-crash-recovery-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  const exports = [
    ['tests/acceptance/live-crash-recovery.ts', '*'],
    ['tests/acceptance/live-fixtures.ts', '*'],
    ['tests/acceptance/live-credential-selection.ts', '*'],
    ['tests/acceptance/live-child-supervisor.ts', '*'],
    ['apps/desktop/src/main/service.ts', 'DesktopService'],
    ['packages/persistence/src/index.ts', 'ProsperoStore'],
  ];
  await writeFile(
    entry,
    exports
      .map(
        ([file, names]) =>
          `export ${names === '*' ? '*' : `{ ${names} }`} from ${JSON.stringify(resolve(file))};`,
      )
      .join('\n'),
  );
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!built.success)
    throw new Error('Could not compile the owned crash recovery integration entry.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(code: string) {
  const program = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { DatabaseSync } from 'node:sqlite';
    import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { readFile } from 'node:fs/promises';
    import { createLiveFixture, prepareLiveCredentialSelection, copyLiveCredentialSelection,
      superviseLiveFixtureChild, assertLiveFixtureChildOutcome,
      captureLiveCrashBoundary, verifyLiveCrashRecovery, DesktopService, ProsperoStore,
      renderLiveCaseTask, verifyLiveCaseOutcome } from ${JSON.stringify(moduleUrl)};
    const bundle=${JSON.stringify(moduleUrl)};
    const cleanup=[];
    const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
    const endpoint='https://offline.example.test/v1';
    const provider={id:'selected',displayName:'Offline crash fixture',baseUrl:endpoint,
      model:'offline-model',timeoutMs:1000,supportsTools:true,hasApiKey:true};
    const fakeVault={get:async()=> 'OFFLINE_ONLY_FAKE_CREDENTIAL',put:async()=>{throw new Error('No fake credential replacement');}};
    function tool(actions) {
      return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'offline-plan',type:'function',
        function:{name:'execute_plan',arguments:JSON.stringify({title:'Offline remaining-only plan',actions})}}]},finish_reason:'tool_calls'}]})+'\\n\\ndata: [DONE]\\n\\n',
        {headers:{'content-type':'text/event-stream'}});
    }
    function complete() {
      return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Offline approved fixture writes completed.'},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n',
        {headers:{'content-type':'text/event-stream'}});
    }
    function serviceFor(store,fixture,fetchImpl) {
      return new DesktopService(store,fakeVault,{folder:async()=>fixture.root,files:async()=>[]},()=>{},'offline-crash-test',
        undefined,undefined,undefined,1000,fetchImpl);
    }
    async function setup() {
      const fixture=await createLiveFixture('C07');cleanup.push(()=>fixture.close());
      const sourceDatabasePath=join(dirname(fixture.root),'source-reference.sqlite');
      const source=new ProsperoStore(sourceDatabasePath);source.saveProvider(provider);
      source.saveEncryptedCredential(provider.id,Uint8Array.from([9,8,7,6]));source.close();
      const prepared=await prepareLiveCredentialSelection({sourceDatabasePath,providerId:provider.id,
        expectedBaseUrl:endpoint,model:provider.model,includeBrave:false},{beforeRead:()=>true});
      // Explicit offline fixture authorization; this callback is never real human consent.
      const profile=await copyLiveCredentialSelection(prepared.token,{fixture,beforeRead:()=>true});
      cleanup.push(()=>profile.close());
      const store=new ProsperoStore(profile.databasePath);
      const service=serviceFor(store,fixture,async()=>{throw new Error('Setup must make zero HTTP');});
      const conversation=service.createConversation();service.selectProvider(conversation.id,provider.id);
      await service.addScope(conversation.id,'write');
      const scopeId=service.getConversation(conversation.id).scopes[0].id;
      await service.shutdown();store.close();
      return {fixture,profile,conversationId:conversation.id,scopeId};
    }
    async function crash(f,exitCode=23) {
      const config={databasePath:f.profile.databasePath,conversationId:f.conversationId,scopeId:f.scopeId,
        root:f.fixture.root,task:renderLiveCaseTask(f.fixture),exitCode};
      const source=
      "(async()=>{const {DesktopService,ProsperoStore}=await import("+JSON.stringify(bundle)+");"+
      "const {readFileSync}=require('node:fs');const path=require('node:path');const config="+JSON.stringify(config)+";"+
      "let plan;class CrashStore extends ProsperoStore{actionJournal(id,executionId){const journal=super.actionJournal(id,executionId);return{...journal,"+
      "prepare(value){plan=value;journal.prepare(value);},transition(planId,actionId,status,detail){"+
      "if(actionId==='action-2'&&status==='succeeded'){if(readFileSync(path.join(config.root,'second.txt'),'utf8')!=='second.txt approved content')process.exit(2);"+
      "process.send({version:1,type:'boundary',caseId:'C07',phaseId:'initial',boundaryId:'process-exit-after-effect-before-journal',planId,actionId});"+
      "process.send({version:1,type:'exit-intent',code:23});process.exit(config.exitCode);}journal.transition(planId,actionId,status,detail);}}}};"+
      "const store=new CrashStore(config.databasePath);let calls=0;const fakeFetch=async()=>{calls++;if(calls!==1)throw new Error('Unexpected offline HTTP');"+
      "const actions=['first.txt','second.txt','third.txt'].map(name=>({kind:'write_text',target:{scopeId:config.scopeId,path:name},content:name+' approved content'}));"+
      "return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'offline-three-writes',type:'function',function:{name:'execute_plan',"+
      "arguments:JSON.stringify({title:'Offline crash fixture approved three writes',actions})}}]},finish_reason:'tool_calls'}]})+'\\\\n\\\\ndata: [DONE]\\\\n\\\\n',{headers:{'content-type':'text/event-stream'}});};"+
      "const vault={get:async()=>'OFFLINE_ONLY_FAKE_CREDENTIAL',put:async()=>{throw new Error('readonly fake');}};"+
      "const service=new DesktopService(store,vault,{folder:async()=>config.root,files:async()=>[]},()=>{},'offline-crash-child',undefined,undefined,undefined,1000,fakeFetch);"+
      "await service.sendTask(config.conversationId,config.task);"+
      "for(let index=0;index<2000;index++){const c=service.getConversation(config.conversationId);if(c.pendingPermission){"+
      "const request=c.pendingPermission;const snapshot=request.preview.plan;if(request.call.name!=='execute_plan'||!snapshot||snapshot.actions.length!==3)process.exit(3);"+
      "if(snapshot.actions.some((action,index)=>path.basename(action.target)!==['first.txt','second.txt','third.txt'][index]))process.exit(4);"+
      "service.decideActionPlan(c.id,request.requestId,snapshot.digest,'allow-once');}if(['failed','completed','cancelled'].includes(c.state))process.exit(5);"+
      "await new Promise(resolve=>setTimeout(resolve,2));}process.exit(6);})().catch(()=>process.exit(7));";
      const entryPath=join(f.profile.isolatedRoot,'offline-crash-worker.cjs');writeFileSync(entryPath,source,{mode:0o600});
      const options={entryPath,expectedEntrySha256:sha(source),cwd:f.profile.isolatedRoot,execPath:realpathSync(process.execPath),deadlineMs:7000};
      const outcome=await superviseLiveFixtureChild(f.fixture,options);assertLiveFixtureChildOutcome(f.fixture,outcome);
      assert.equal(outcome.actualExitCode,exitCode,'Offline child did not reach the controlled precommit exit');
      assert.equal(outcome.reason,'exited');assert.equal(outcome.closeObserved,true);
      assert.equal(readFileSync(join(f.fixture.root,'first.txt'),'utf8'),'first.txt approved content');
      assert.equal(readFileSync(join(f.fixture.root,'second.txt'),'utf8'),'second.txt approved content');
      assert(!existsSync(join(f.fixture.root,'third.txt')));
      return {outcome,expectedEntrySha256:options.expectedEntrySha256,expectedExecSha256:sha(readFileSync(options.execPath))};
    }
    const capture=(f,child)=>captureLiveCrashBoundary({fixture:f.fixture,profile:f.profile,
      outcome:child.outcome,conversationId:f.conversationId,expectedEntrySha256:child.expectedEntrySha256,
      expectedExecSha256:child.expectedExecSha256});
    function raw(f,callback) {const db=new DatabaseSync(f.profile.databasePath);try{return callback(db);}finally{db.close();}}
    function reopen(f,fetchImpl=async()=>{throw new Error('Restart must not make HTTP');}) {
      const store=new ProsperoStore(f.profile.databasePath);const service=serviceFor(store,f.fixture,fetchImpl);
      cleanup.push(async()=>{await service.shutdown();store.close();});return {store,service};
    }
    async function waitPermission(service,id) {
      for(let index=0;index<1000;index++){const c=service.getConversation(id);if(c.pendingPermission)return c.pendingPermission;
        if(['completed','failed','cancelled'].includes(c.state))throw new Error('Offline recovery ended without fresh approval');
        await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Offline permission did not appear');
    }
    async function waitComplete(service,id) {
      for(let index=0;index<1000;index++){const c=service.getConversation(id);if(['completed','failed','cancelled'].includes(c.state))return c;
        await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Offline recovery did not settle');
    }
    try { ${code} }
    finally {for(const close of cleanup.reverse())await close();}
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', program], {
      timeout: 20000,
      maxBuffer: 16384,
    });
    expect(result.stdout).toBe('');
  } catch (error) {
    const stderr =
      (error as { stderr?: string }).stderr ?? 'Owned crash recovery test did not finish.';
    throw new Error(`Owned crash recovery integration failed:\n${stderr.slice(0, 8192)}`);
  }
}

test('actual child precommit exit is captured before recovery, then only a fresh third-file approval executes', async () => {
  await native(`
    const f=await setup();const child=await crash(f);
    const boundary=await capture(f,child);
    let turns=0;const {store,service}=reopen(f,async()=>turns++===0?tool([{kind:'write_text',target:{scopeId:f.scopeId,path:'third.txt'},content:'third.txt approved content'}]):complete());
    const restored=service.getConversation(f.conversationId);
    assert.equal(restored.state,'interrupted');assert.equal(restored.pendingPermission,undefined);assert.equal(turns,0);
    const recovered=await verifyLiveCrashRecovery(boundary,service);
    assert.equal(recovered.checkpoint.label,'after-crash');assert.equal(recovered.observation.processExitCode,23);
    assert.equal(recovered.observation.boundaryId,'process-exit-after-effect-before-journal');
    assert.match(recovered.rawJournalSha256,/^[a-f0-9]{64}$/);assert.equal(recovered.previousApproval.decision,'allow-once');
    const old=recovered.previousApproval.request;assert(old.preview.plan);
    assert.throws(()=>service.decideActionPlan(f.conversationId,old.requestId,old.preview.plan.digest,'allow-once'),/no longer/);
    assert(!existsSync(join(f.fixture.root,'third.txt')));
    await service.sendTask(f.conversationId,renderLiveCaseTask(f.fixture,'after-crash'));
    const request=await waitPermission(service,f.conversationId);
    assert.notEqual(request.requestId,old.requestId);assert.notEqual(request.preview.plan.id,old.preview.plan.id);
    assert.equal(request.preview.plan.actions.length,1);assert.equal(request.preview.plan.actions[0].target,join(f.fixture.root,'third.txt'));
    assert.throws(()=>service.decideActionPlan(f.conversationId,old.requestId,old.preview.plan.digest,'allow-once'),/changed|no longer/);
    assert(!existsSync(join(f.fixture.root,'third.txt')));
    // Explicit offline fixture helper grants this new immutable snapshot, never real/human consent.
    service.decideActionPlan(f.conversationId,request.requestId,request.preview.plan.digest,'allow-once');
    const completed=await waitComplete(service,f.conversationId);assert.equal(completed.state,'completed');
    for(const name of ['first.txt','second.txt','third.txt'])assert.equal(await readFile(join(f.fixture.root,name),'utf8'),name+' approved content');
    const plans=store.actionPlans(f.conversationId);assert.equal(plans.length,2);assert.equal(plans[0].status,'interrupted');
    assert.equal(plans[1].plan.actions.length,1);assert.equal(plans[1].status,'completed');
    const oracle=await verifyLiveCaseOutcome(f.fixture,{conversation:completed,
      approvals:[recovered.previousApproval,{request,decision:'allow-once',phaseId:'after-crash'}],
      checkpoints:[recovered.checkpoint],observations:[recovered.observation]});
    assert.equal(oracle.objective,'verified',JSON.stringify(oracle.checks));assert(oracle.checks.every(check=>check.status==='pass'));
  `);
});

test('child-reported exit 23 with actual exit zero and copied receipts cannot establish a crash boundary', async () => {
  await native(`
    const zero=await setup();const zeroChild=await crash(zero,0);await assert.rejects(capture(zero,zeroChild));
    const f=await setup();const child=await crash(f);
    await assert.rejects(capture(f,{...child,outcome:{...child.outcome}}));
    await assert.rejects(capture(f,{...child,outcome:JSON.parse(JSON.stringify(child.outcome))}));
    await assert.rejects(capture(f,{...child,expectedEntrySha256:'f'.repeat(64)}));
    const other=await setup();await assert.rejects(capture(other,child));
  `);
});

test('postcrash effects or raw immutable plan corruption are rejected before a service can recover them', async () => {
  await native(`
    const changed=await setup();const changedChild=await crash(changed);
    writeFileSync(join(changed.fixture.root,'second.txt'),'different postcrash fixture bytes');
    await assert.rejects(capture(changed,changedChild));
    const mutated=await setup();const mutatedChild=await crash(mutated);
    raw(mutated,(db)=>{
      db.exec('DROP TRIGGER action_plan_immutable');
      const row=db.prepare('SELECT id,payload FROM action_plans WHERE conversation_id=?').get(mutated.conversationId);
      const plan=JSON.parse(row.payload);plan.actions[1].afterHash='f'.repeat(64);
      db.prepare('UPDATE action_plans SET payload=? WHERE id=?').run(JSON.stringify(plan),row.id);
    });
    await assert.rejects(capture(mutated,mutatedChild));
    const added=await setup();const addedChild=await crash(added);
    mkdirSync(join(added.fixture.root,'unapproved-directory'),{mode:0o700});
    await assert.rejects(capture(added,addedChild));
  `);
});

test('premature recovery and copied boundary handles cannot substitute for the preserved raw journal', async () => {
  await native(`
    const premature=await setup();const prematureChild=await crash(premature);reopen(premature);
    await assert.rejects(capture(premature,prematureChild));
    const f=await setup();const child=await crash(f);const boundary=await capture(f,child);
    const {service}=reopen(f);
    await assert.rejects(verifyLiveCrashRecovery({...boundary},service));
    await assert.rejects(verifyLiveCrashRecovery(JSON.parse(JSON.stringify(boundary)),service));
    const recovered=await verifyLiveCrashRecovery(boundary,service);assert.equal(recovered.observation.processExitCode,23);
  `);
});

test('selected profile cannot be removed while its actual worker lives; refused cleanup can retry after real settlement', async () => {
  await native(`
    const f=await setup();
    const source="process.send({version:1,type:'ready'});setTimeout(()=>process.exit(0),200);";
    const entryPath=join(f.profile.isolatedRoot,'cleanup-guard.cjs');writeFileSync(entryPath,source,{mode:0o600});
    const running=superviseLiveFixtureChild(f.fixture,{entryPath,expectedEntrySha256:sha(source),cwd:f.profile.isolatedRoot,
      execPath:realpathSync(process.execPath),deadlineMs:3000});
    await assert.rejects(f.profile.close());assert(existsSync(f.profile.databasePath));assert(existsSync(f.fixture.root));
    const outcome=await running;assert.equal(outcome.reason,'exited');assert.equal(outcome.actualExitCode,0);
    await f.profile.close();assert(!existsSync(f.profile.isolatedRoot));
  `);
});
