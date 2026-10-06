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
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-child-permission-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  const exports = [
    ['tests/acceptance/live-child-permission.ts', '*'],
    ['tests/acceptance/live-child-permission-worker.ts', '*'],
    ['tests/acceptance/live-crash-recovery.ts', '*'],
    ['tests/acceptance/live-fixtures.ts', '*'],
    ['tests/acceptance/live-credential-selection.ts', '*'],
    ['tests/acceptance/live-child-supervisor.ts', '*'],
    ['tests/acceptance/live-approval.ts', 'livePermissionFingerprint'],
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
    throw new Error('Could not compile the owned child permission protocol entry.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(code: string) {
  const program = `
    import assert from 'node:assert/strict';
    import { createHash,randomUUID } from 'node:crypto';
    import { existsSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
    import { dirname,join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { createLiveFixture,prepareLiveCredentialSelection,copyLiveCredentialSelection,
      superviseLiveFixtureChild,assertLiveFixtureChildOutcome,captureLiveCrashBoundary,verifyLiveCrashRecovery,
      reconcileLiveCrashParentDecision,
      createLiveParentPermissionSession,attachLiveParentPermissionSession,attachLiveChildPermissionWorker,livePermissionFingerprint,
      DesktopService,ProsperoStore,renderLiveCaseTask } from ${JSON.stringify(moduleUrl)};
    const bundle=${JSON.stringify(moduleUrl)};
    const cleanup=[];
    const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
    const endpoint='https://offline.example.test/v1';
    const provider={id:'selected',displayName:'Offline protocol fixture',baseUrl:endpoint,
      model:'offline-model',timeoutMs:1000,supportsTools:true,hasApiKey:true};
    const fakeVault={get:async()=> 'OFFLINE_PROTOCOL_FAKE_KEY',put:async()=>{throw new Error('Read-only fake fixture');}};
    function serviceFor(store,fixture,fetchImpl) {
      return new DesktopService(store,fakeVault,{folder:async()=>fixture.root,files:async()=>[]},()=>{},'offline-permission-test',
        undefined,undefined,undefined,1000,fetchImpl);
    }
    async function setup() {
      const fixture=await createLiveFixture('C07');cleanup.push(()=>fixture.close());
      const sourceDatabasePath=join(dirname(fixture.root),'source-reference.sqlite');
      const source=new ProsperoStore(sourceDatabasePath);source.saveProvider(provider);
      source.saveEncryptedCredential(provider.id,Uint8Array.from([11,9,7,5]));source.close();
      const prepared=await prepareLiveCredentialSelection({sourceDatabasePath,providerId:provider.id,
        expectedBaseUrl:endpoint,model:provider.model,includeBrave:false},{beforeRead:()=>true});
      // This technical gate approves only the synthetic offline temp fixture, never actual credentials.
      const profile=await copyLiveCredentialSelection(prepared.token,{fixture,beforeRead:()=>true});cleanup.push(()=>profile.close());
      const store=new ProsperoStore(profile.databasePath);const service=serviceFor(store,fixture,async()=>{throw new Error('No setup HTTP');});
      const c=service.createConversation();service.selectProvider(c.id,provider.id);await service.addScope(c.id,'write');
      const scopeId=service.getConversation(c.id).scopes[0].id;await service.shutdown();store.close();
      const binding={runId:'offline-protocol-run',generationId:randomUUID(),caseId:'C07',phaseId:'initial',conversationId:c.id};
      return {fixture,profile,conversationId:c.id,scopeId,binding,expiresAt:Date.now()+15000};
    }
    function file(f,name) {return join(f.fixture.root,name);}
    function noEffects(f) {for(const name of ['first.txt','second.txt','third.txt'])assert(!existsSync(file(f,name)));}
    function parentSession(f,reviewPermission,extra={}) {
      return createLiveParentPermissionSession({binding:f.binding,boundary:{roots:[f.fixture.root],scopeIds:[f.scopeId]},
        expiresAt:f.expiresAt,assertCurrent:async(signal)=>signal.throwIfAborted(),reviewPermission,...extra});
    }
    async function worker(f,permissionSession,options={}) {
      const config={databasePath:f.profile.databasePath,conversationId:f.conversationId,scopeId:f.scopeId,root:f.fixture.root,
        binding:options.binding??f.binding,expiresAt:f.expiresAt,task:renderLiveCaseTask(f.fixture,(options.binding??f.binding).phaseId),
        names:options.names??['first.txt','second.txt','third.txt'],crash:options.crash!==false,fault:options.fault??null,
        attackGate:join(f.profile.isolatedRoot,'offline-review-entered')};
      const source=
      "(async()=>{const {DesktopService,ProsperoStore,attachLiveChildPermissionWorker,livePermissionFingerprint}=await import("+JSON.stringify(bundle)+");"+
      "const {existsSync,readFileSync}=require('node:fs');const path=require('node:path');const config="+JSON.stringify(config)+";"+
      // Explicit adversarial transport fixtures only. They do not modify the real protocol implementation.
      "const nativeSend=process.send.bind(process);process.send=(message,...rest)=>{"+
      "if(config.fault==='changed-refresh'&&message.type==='permission-snapshot'&&message.challengeId!==null){const changed=JSON.parse(JSON.stringify(message));"+
      "changed.request.preview.plan.actions[0].afterHash='f'.repeat(64);return nativeSend(changed,...rest);}"+
      "if(config.fault==='duplicate-snapshot'&&message.type==='permission-snapshot'&&message.challengeId===null){const sent=nativeSend(message,...rest);nativeSend(message);return sent;}"+
      "if(['early-ack','review-flood','disconnect-review'].includes(config.fault)&&message.type==='permission-snapshot'&&message.challengeId===null&&message.request){"+
      "const sent=nativeSend(message,...rest);const attack=setInterval(()=>{if(!existsSync(config.attackGate))return;clearInterval(attack);"+
      "if(config.fault==='disconnect-review'){process.disconnect();return;}"+
      "if(config.fault==='early-ack')nativeSend({version:1,type:'permission-ack',binding:message.binding,nonce:message.nonce,"+
      "requestId:message.request.requestId,fingerprint:livePermissionFingerprint(message.request),decision:'allow-once'});"+
      "else for(let n=0;n<24;n++)nativeSend(message);},2);return sent;}"+
      "if(config.fault==='lost-ack'&&message.type==='permission-ack'){const callback=rest.find(value=>typeof value==='function');queueMicrotask(()=>callback?.(null));return true;}"+
      "return nativeSend(message,...rest);};"+
      "class CrashStore extends ProsperoStore{actionJournal(id,executionId){const journal=super.actionJournal(id,executionId);return{...journal,transition(planId,actionId,status,detail){"+
      "if(config.crash&&actionId==='action-2'&&status==='succeeded'){if(readFileSync(path.join(config.root,'second.txt'),'utf8')!=='second.txt approved content')process.exit(2);"+
      "process.send({version:1,type:'boundary',caseId:'C07',phaseId:config.binding.phaseId,boundaryId:'process-exit-after-effect-before-journal',planId,actionId});"+
      "process.send({version:1,type:'exit-intent',code:23});process.exit(23);}journal.transition(planId,actionId,status,detail);}}}};"+
      "const store=new CrashStore(config.databasePath);let calls=0;const fakeFetch=async()=>{calls++;"+
      "if(calls===1){const actions=config.names.map(name=>({kind:'write_text',target:{scopeId:config.scopeId,path:name},content:name+' approved content'}));"+
      "return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'offline-protocol-plan-'+config.binding.generationId,type:'function',function:{name:'execute_plan',"+
      "arguments:JSON.stringify({title:'Offline parent-reviewed immutable fixture writes',actions})}}]},finish_reason:'tool_calls'}]})+'\\\\n\\\\ndata: [DONE]\\\\n\\\\n',{headers:{'content-type':'text/event-stream'}});}"+
      "return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Offline task stopped or completed according to actual tool result.'},finish_reason:'stop'}]})+'\\\\n\\\\ndata: [DONE]\\\\n\\\\n',{headers:{'content-type':'text/event-stream'}});};"+
      "const vault={get:async()=>'OFFLINE_PROTOCOL_FAKE_KEY',put:async()=>{throw new Error('readonly fake');}};"+
      "const service=new DesktopService(store,vault,{folder:async()=>config.root,files:async()=>[]},()=>{},'offline-protocol-child',undefined,undefined,undefined,1000,fakeFetch);"+
      // The one legacy crash-attribution regression uses explicit synthetic fixture approval,
      // so its old durable decision cannot be attributed to a later parent review.
      "const worker=config.fault==='offline-auto-approval'?null:attachLiveChildPermissionWorker({service,binding:config.binding,expiresAt:config.expiresAt});let offlineApprovalUsed=false;"+
      "process.send({version:1,type:'ready'});await service.sendTask(config.conversationId,config.task);"+
      "for(let i=0;i<2500;i++){worker?.publishPending();const c=service.getConversation(config.conversationId);"+
      "if(!worker&&!offlineApprovalUsed&&c.pendingPermission){offlineApprovalUsed=true;service.decideActionPlan(config.conversationId,c.pendingPermission.requestId,c.pendingPermission.preview.plan.digest,'allow-once');}"+
      "if(['failed','completed','cancelled'].includes(c.state)){await worker?.close();await service.shutdown();store.close();process.exit(0);}"+
      "await new Promise(resolve=>setTimeout(resolve,2));}await worker?.close();await service.shutdown();store.close();process.exit(6);})().catch(()=>process.exit(7));";
      const entryPath=join(f.profile.isolatedRoot,'offline-protocol-worker.cjs');writeFileSync(entryPath,source,{mode:0o600});
      const spec={entryPath,expectedEntrySha256:sha(source),cwd:f.profile.isolatedRoot,execPath:realpathSync(process.execPath),deadlineMs:7000,
        ...(permissionSession?{permissionSession}:{}),...(options.signal?{signal:options.signal}:{})};
      const expectedExecSha256=sha(readFileSync(spec.execPath));
      const outcome=await superviseLiveFixtureChild(f.fixture,spec);assertLiveFixtureChildOutcome(f.fixture,outcome);
      assert.equal(outcome.closeObserved,true);assert.equal(outcome.exitObserved,true);
      assert.equal(outcome.execSha256,expectedExecSha256);
      return {outcome,expectedEntrySha256:spec.expectedEntrySha256,expectedExecSha256};
    }
    try { ${code} }
    finally {for(const close of cleanup.reverse())await close();}
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', program], {
      timeout: 25000,
      maxBuffer: 16384,
    });
    expect(result.stdout).toBe('');
  } catch (error) {
    const stderr =
      (error as { stderr?: string }).stderr ?? 'Owned child permission test did not finish.';
    throw new Error(`Owned child permission integration failed:\n${stderr.slice(0, 8192)}`);
  }
}

test('actual parent review authorizes one immutable child plan and receives ACK before real precommit exit', async () => {
  await native(`
    const f=await setup();let reviewed=0;let oldRequest;
    const session=parentSession(f,async({request,fingerprint,binding},signal)=>{
      signal.throwIfAborted();reviewed++;noEffects(f);assert(Object.isFrozen(request));assert(Object.isFrozen(request.preview.plan));
      assert.equal(fingerprint,livePermissionFingerprint(request));assert.deepEqual(binding,f.binding);
      assert.equal(request.call.name,'execute_plan');assert.equal(request.preview.plan.actions.length,3);
      assert.deepEqual(request.preview.plan.actions.map(action=>action.target),['first.txt','second.txt','third.txt'].map(name=>file(f,name)));
      oldRequest=request;return 'allow-once'; // Explicit synthetic offline review only.
    });
    const child=await worker(f,session);assert.equal(child.outcome.reason,'exited');assert.equal(child.outcome.actualExitCode,23);
    assert.equal(reviewed,1);const evidence=session.evidence();assert.equal(evidence.status,'acknowledged');
    assert.equal(evidence.records.length,1);assert.equal(evidence.records[0].decision,'allow-once');assert.equal(evidence.records[0].acknowledged,true);
    assert.equal(evidence.records[0].requestId,oldRequest.requestId);assert(evidence.receivedBytes>0);
    assert.deepEqual(evidence.binding,f.binding);assert.equal(evidence.ackMeaning,'service-decision-admitted; not-durable-or-effect-proof');
    assert(!JSON.stringify(evidence).includes('approved content'));assert(!JSON.stringify(evidence).includes('OFFLINE_PROTOCOL_FAKE_KEY'));
    const boundary=await captureLiveCrashBoundary({fixture:f.fixture,profile:f.profile,outcome:child.outcome,conversationId:f.conversationId,
      expectedEntrySha256:child.expectedEntrySha256,expectedExecSha256:child.expectedExecSha256});
    const agreement=reconcileLiveCrashParentDecision(boundary,session);assert.equal(agreement.delivery,'acknowledged');
    assert.equal(agreement.planId,boundary.planId);assert.equal(agreement.permissionFingerprint,livePermissionFingerprint(oldRequest));
    assert.equal(agreement.proofBoundary,'actual-crash-journal-and-parent-review-intent-only');assert(Object.isFrozen(agreement));
    assert.throws(()=>reconcileLiveCrashParentDecision(boundary,{...session}));
    assert.throws(()=>reconcileLiveCrashParentDecision({...boundary},session));
    const unusedOther=parentSession({...f,binding:{...f.binding,generationId:randomUUID()}},async()=> 'allow-once');
    assert.throws(()=>reconcileLiveCrashParentDecision(boundary,unusedOther));
    const store=new ProsperoStore(f.profile.databasePath);const service=serviceFor(store,f.fixture,async()=>{throw new Error('No restart HTTP');});
    cleanup.push(async()=>{await service.shutdown();store.close();});const restored=service.getConversation(f.conversationId);
    assert.equal(restored.state,'interrupted');assert.equal(restored.pendingPermission,undefined);
    const recovered=await verifyLiveCrashRecovery(boundary,service);assert.equal(recovered.previousApproval.request.requestId,oldRequest.requestId);
    assert.throws(()=>service.decideActionPlan(f.conversationId,oldRequest.requestId,oldRequest.preview.plan.digest,'allow-once'));
    assert.equal(readFileSync(file(f,'first.txt'),'utf8'),'first.txt approved content');
    assert.equal(readFileSync(file(f,'second.txt'),'utf8'),'second.txt approved content');assert(!existsSync(file(f,'third.txt')));
    await service.shutdown();store.close();cleanup.pop();
    const fresh={...f,binding:{...f.binding,generationId:randomUUID(),phaseId:'after-crash'},expiresAt:Date.now()+15000};
    let freshReviewed=0;const freshSession=parentSession(fresh,async({request},signal)=>{
      signal.throwIfAborted();freshReviewed++;assert.notEqual(request.requestId,oldRequest.requestId);
      assert.notEqual(request.preview.plan.id,oldRequest.preview.plan.id);assert.equal(request.preview.plan.actions.length,1);
      assert.equal(request.preview.plan.actions[0].target,file(f,'third.txt'));assert(!existsSync(file(f,'third.txt')));
      assert.equal(readFileSync(file(f,'first.txt'),'utf8'),'first.txt approved content');
      assert.equal(readFileSync(file(f,'second.txt'),'utf8'),'second.txt approved content');return 'allow-once';
    });
    const finished=await worker(fresh,freshSession,{names:['third.txt'],crash:false});assert.equal(finished.outcome.actualExitCode,0);
    assert.equal(freshReviewed,1);assert.equal(freshSession.evidence().records[0].acknowledged,true);
    for(const name of ['first.txt','second.txt','third.txt'])assert.equal(readFileSync(file(f,name),'utf8'),name+' approved content');
    const completedStore=new ProsperoStore(f.profile.databasePath);
    try{const plans=completedStore.actionPlans(f.conversationId);assert.equal(plans.length,2);assert.equal(plans[0].status,'interrupted');assert.equal(plans[1].status,'completed');
      assert.equal(plans[1].plan.actions.length,1);}finally{completedStore.close();}
  `);
});

test('default metadata-only supervision cannot authorize a child permission request', async () => {
  await native(`
    const f=await setup();const child=await worker(f,undefined);
    assert.equal(child.outcome.reason,'protocol');assert.notEqual(child.outcome.actualExitCode,23);noEffects(f);
  `);
});

test('a parent denial is acknowledged once and never produces file effects', async () => {
  await native(`
    const f=await setup();let reviewed=0;const session=parentSession(f,async()=>{reviewed++;noEffects(f);return 'deny';});
    const child=await worker(f,session,{crash:false});assert.equal(child.outcome.actualExitCode,0);noEffects(f);
    const evidence=session.evidence();assert.equal(reviewed,1);assert.equal(evidence.status,'denied');
    assert.equal(evidence.records.length,1);assert.equal(evidence.records[0].decision,'deny');assert.equal(evidence.records[0].acknowledged,true);
  `);
});

test('an omitted parent review defaults to denial rather than reconstructing approval from child metadata', async () => {
  await native(`
    const f=await setup();const session=parentSession(f,undefined);const child=await worker(f,session,{crash:false});
    assert.equal(child.outcome.actualExitCode,0);noEffects(f);
    const evidence=session.evidence();assert.equal(evidence.status,'denied');assert.equal(evidence.records.length,1);
    assert.equal(evidence.records[0].decision,'deny');assert.equal(evidence.records[0].acknowledged,true);
  `);
});

test('a changed refresh snapshot cannot turn an earlier review into authority for different bytes', async () => {
  await native(`
    const f=await setup();let reviewed=0;const session=parentSession(f,async({request})=>{
      reviewed++;noEffects(f);assert.equal(request.preview.plan.actions.length,3);return 'allow-once';
    });
    const child=await worker(f,session,{fault:'changed-refresh'});assert.equal(child.outcome.reason,'protocol');
    assert.equal(reviewed,1);noEffects(f);assert.equal(session.evidence().records.length,0);
  `);
});

test('a replayed initial snapshot terminates the protocol without repeated approval or file effects', async () => {
  await native(`
    const f=await setup();let reviewed=0;const session=parentSession(f,async()=>{reviewed++;return 'allow-once';});
    const child=await worker(f,session,{fault:'duplicate-snapshot'});assert.equal(child.outcome.reason,'protocol');
    assert(reviewed<=1);noEffects(f);assert(!session.evidence().records.some(row=>row.acknowledged));
  `);
});

test('a deliberately lost ACK leaves a sent decision pending even when actual file effects and crash are observable', async () => {
  await native(`
    const f=await setup();let reviewed=0;const session=parentSession(f,async()=>{reviewed++;noEffects(f);return 'allow-once';});
    const child=await worker(f,session,{fault:'lost-ack'});assert.equal(child.outcome.actualExitCode,23);assert.equal(reviewed,1);
    // The fixture drops the actual IPC ACK after Service accepted the decision. Its absence is never invented as success.
    const evidence=session.evidence();assert.equal(evidence.status,'pending');assert.equal(evidence.reason,'ack-missing');
    assert.equal(evidence.records.length,1);assert.equal(evidence.records[0].decision,'allow-once');assert.equal(evidence.records[0].acknowledged,false);
    assert.equal(readFileSync(file(f,'first.txt'),'utf8'),'first.txt approved content');
    assert.equal(readFileSync(file(f,'second.txt'),'utf8'),'second.txt approved content');assert(!existsSync(file(f,'third.txt')));
    const boundary=await captureLiveCrashBoundary({fixture:f.fixture,profile:f.profile,outcome:child.outcome,conversationId:f.conversationId,
      expectedEntrySha256:child.expectedEntrySha256,expectedExecSha256:child.expectedExecSha256});
    const agreement=reconcileLiveCrashParentDecision(boundary,session);assert.equal(agreement.delivery,'durably-reconciled');
    assert.equal(agreement.planId,boundary.planId);assert.equal(agreement.permissionFingerprint,evidence.records[0].fingerprint);
    assert.equal(agreement.proofBoundary,'actual-crash-journal-and-parent-review-intent-only');
    assert.deepEqual(session.evidence(),evidence);assert.equal(session.evidence().status,'pending');
    assert.equal(session.evidence().records[0].acknowledged,false);
  `);
});

test('a later attached and reviewed technical session cannot attribute an older child crash decision to itself', async () => {
  await native(`
    const f=await setup();const child=await worker(f,undefined,{fault:'offline-auto-approval'});
    assert.equal(child.outcome.reason,'exited');assert.equal(child.outcome.actualExitCode,23);
    const boundary=await captureLiveCrashBoundary({fixture:f.fixture,profile:f.profile,outcome:child.outcome,conversationId:f.conversationId,
      expectedEntrySha256:child.expectedEntrySha256,expectedExecSha256:child.expectedExecSha256});
    // Read only the selected synthetic conversation. No service constructor may recover the raw receipt yet.
    const db=new DatabaseSync(f.profile.databasePath,{readOnly:true});let original;
    try{const row=db.prepare('SELECT payload FROM conversations WHERE id=?').get(f.conversationId);
      const conversation=JSON.parse(row.payload);original=conversation.timeline.find(item=>item.decision==='allow-once'&&item.request?.preview.plan?.id===boundary.planId).request;
    }finally{db.close();}
    const foreign={...f,binding:{...f.binding,runId:'later-offline-replay',generationId:randomUUID()}};
    let reviewed=0;const replay=parentSession(foreign,async({request,fingerprint})=>{
      reviewed++;assert.deepEqual(request,original);assert.equal(fingerprint,livePermissionFingerprint(original));return 'allow-once';
    });
    // This actual attachment is a pure technical replay, deliberately not an owned ChildProcess.
    let channel;let resolveDecision;const decisionSent=new Promise(resolve=>{resolveDecision=resolve;});
    channel=attachLiveParentPermissionSession(replay,async(message)=>{
      if(message.type==='permission-session')queueMicrotask(()=>channel.receive({version:1,type:'permission-snapshot',binding:foreign.binding,
        nonce:message.nonce,challengeId:null,request:original}));
      if(message.type==='permission-refresh')queueMicrotask(()=>channel.receive({version:1,type:'permission-snapshot',binding:foreign.binding,
        nonce:message.nonce,challengeId:message.challengeId,request:original}));
      if(message.type==='permission-decision')queueMicrotask(()=>resolveDecision());
    },()=>{throw new Error('Unexpected synthetic replay rejection');},new AbortController().signal);
    try{channel.receive({version:1,type:'permission-ready',binding:foreign.binding});await decisionSent;
      assert.equal(reviewed,1);assert.equal(replay.evidence().records.length,1);assert.equal(replay.evidence().records[0].decision,'allow-once');
      assert.equal(replay.evidence().records[0].requestId,original.requestId);assert.equal(replay.evidence().records[0].fingerprint,livePermissionFingerprint(original));
      assert.throws(()=>reconcileLiveCrashParentDecision(boundary,replay));
    }finally{channel.finish();}
    assert.equal(readFileSync(file(f,'first.txt'),'utf8'),'first.txt approved content');
    assert.equal(readFileSync(file(f,'second.txt'),'utf8'),'second.txt approved content');assert(!existsSync(file(f,'third.txt')));
  `);
});

test('an early ACK with matching nonce and fingerprint stops a hanging review before any decision', async () => {
  await native(`
    const f=await setup();let release;let reviewed=0;
    const session=parentSession(f,async()=>{reviewed++;noEffects(f);
      writeFileSync(join(f.profile.isolatedRoot,'offline-review-entered'),'synthetic offline review is waiting',{mode:0o600});
      return await new Promise(resolve=>{release=resolve;});
    });
    const child=await worker(f,session,{fault:'early-ack'});assert.equal(child.outcome.reason,'protocol');
    assert.equal(reviewed,1);assert.equal(typeof release,'function');noEffects(f);
    assert.equal(session.evidence().records.length,0);assert.equal(session.evidence().status,'pending');
    release('allow-once');await new Promise(resolve=>setTimeout(resolve,30));noEffects(f);
    assert.equal(session.evidence().records.length,0);
  `);
});

test('a burst of duplicate frames stops immediately while review is hanging and late allow stays inert', async () => {
  await native(`
    const f=await setup();let release;let reviewed=0;
    const session=parentSession(f,async()=>{reviewed++;noEffects(f);
      writeFileSync(join(f.profile.isolatedRoot,'offline-review-entered'),'synthetic offline review is waiting',{mode:0o600});
      return await new Promise(resolve=>{release=resolve;});
    });
    const child=await worker(f,session,{fault:'review-flood'});assert.equal(child.outcome.reason,'protocol');
    assert.equal(reviewed,1);assert.equal(typeof release,'function');noEffects(f);
    assert.equal(session.evidence().records.length,0);assert(session.evidence().receivedBytes<=262144);
    release('allow-once');await new Promise(resolve=>setTimeout(resolve,30));noEffects(f);
    assert.equal(session.evidence().records.length,0);
  `);
});

test('actual child IPC disconnect cancels its pending service while parent review hangs and late allow stays inert', async () => {
  await native(`
    const f=await setup();let release;let reviewed=0;
    const session=parentSession(f,async()=>{reviewed++;noEffects(f);
      writeFileSync(join(f.profile.isolatedRoot,'offline-review-entered'),'synthetic offline review is waiting',{mode:0o600});
      return await new Promise(resolve=>{release=resolve;});
    });
    const child=await worker(f,session,{fault:'disconnect-review'});assert.notEqual(child.outcome.actualExitCode,23);
    assert.equal(reviewed,1);assert.equal(typeof release,'function');noEffects(f);
    assert.equal(session.evidence().records.length,0);
    // A persisted cancellation distinguishes the child's immediate stopTask from only killing its process.
    const db=new DatabaseSync(f.profile.databasePath,{readOnly:true});
    try{const row=db.prepare('SELECT payload FROM conversations WHERE id=?').get(f.conversationId);
      assert.equal(JSON.parse(row.payload).state,'cancelled');
    }finally{db.close();}
    release('allow-once');await new Promise(resolve=>setTimeout(resolve,30));noEffects(f);
    assert.equal(session.evidence().records.length,0);
  `);
});

test('a foreign worker generation cannot obtain review or replay authority', async () => {
  await native(`
    const f=await setup();let reviewed=0;const session=parentSession(f,async()=>{reviewed++;return 'allow-once';});
    const child=await worker(f,session,{binding:{...f.binding,generationId:randomUUID()}});
    assert.notEqual(child.outcome.actualExitCode,23);noEffects(f);assert.equal(reviewed,0);
    assert(!session.evidence().records.some(row=>row.decision==='allow-once'&&row.acknowledged));
  `);
});

test('Stop while parent review hangs rejects a late allow and awaits the actual worker exit', async () => {
  await native(`
    const f=await setup();const controller=new AbortController();let release;let reviewed=0;
    const session=parentSession(f,async()=>{reviewed++;noEffects(f);return await new Promise(resolve=>{release=resolve;queueMicrotask(()=>controller.abort());});});
    const child=await worker(f,session,{signal:controller.signal});assert.equal(child.outcome.reason,'aborted');assert.equal(reviewed,1);noEffects(f);
    release('allow-once');await new Promise(resolve=>setTimeout(resolve,30));noEffects(f);
    assert(!session.evidence().records.some(row=>row.decision==='allow-once'&&row.acknowledged));
  `);
});
