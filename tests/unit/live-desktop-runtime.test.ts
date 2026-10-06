import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Native Node SQLite is required for the immutable credential-copy URI. These children use
// exclusively owned files, fake ciphertext/native ports, and injected HTTP/DNS responses.
const execute = promisify(execFile);
let buildRoot: string;
let moduleUrl: string;
beforeAll(async () => {
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-runtime-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  const files = [
    'live-desktop-runtime',
    'live-credential-selection',
    'live-fixtures',
    'live-budget',
    'live-budget-journal',
  ];
  await writeFile(
    entry,
    files
      .map((file) => `export * from ${JSON.stringify(resolve(`tests/acceptance/${file}.ts`))};`)
      .join('\n') +
      `\nexport { ProsperoStore } from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!result.success) throw new Error('Owned offline runtime compilation failed.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});
async function native(caseId: string, code: string) {
  const script = `
    import assert from 'node:assert/strict';
    import { createHash, randomUUID } from 'node:crypto';
    import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { createLiveDesktopRuntime, createLiveFixture, prepareLiveCredentialSelection,
      copyLiveCredentialSelection, createLiveBudgetManifest, LiveBudgetLedger,
      SqliteLiveBudgetJournal, ProsperoStore, verifyLiveCaseOutcome, renderLiveCaseTask } from ${JSON.stringify(moduleUrl)};
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'prospero-offline-runtime-source-')));
    const fixture = await createLiveFixture(${JSON.stringify(caseId)});
    const sourcePath = join(root,'source.sqlite');
    const baseUrl = 'https://model.runtime.invalid/v1';
    const store = new ProsperoStore(sourcePath);
    store.saveProvider({ id:'selected', displayName:'Offline only', baseUrl, model:'offline-model', timeoutMs:60000, supportsTools:true, hasApiKey:true });
    store.saveEncryptedCredential('selected',Uint8Array.from([1,2,3]));
    store.saveEncryptedCredential('brave-search',Uint8Array.from([4,5,6]));
    store.close();chmodSync(sourcePath,0o600);
    const hash = value => createHash('sha256').update(value).digest('hex');
    const beforeHash = hash(readFileSync(sourcePath));
    const now = Date.now();const journalPath = join(root,'budget.sqlite');
    const journal = new SqliteLiveBudgetJournal(journalPath,{mode:'create'});
    const manifest = createLiveBudgetManifest({ authorizationId:'offline_' + randomUUID(), sourceSha256:'a'.repeat(64), buildSha256:'b'.repeat(64), journalSha256:hash(journalPath), caseIds:[fixture.caseId], createdAt:now, expiresAt:now+60000,
      limits:{provider:64,search:16,page:16,redirects:0,responseBodyBytes:256*1024*1024,wallClockMs:60000} });
    const ledger = new LiveBudgetLedger(manifest,{journal,humanConfirmed:true,executionIdentity:{sourceSha256:manifest.sourceSha256,buildSha256:manifest.buildSha256}});
    const control = new AbortController();const approvals = [];const wire = [];
    let runtime;let phase = 'initial';let profiles = 0;let ownedRoot;
    let responder = () => text('Offline completed.');
    function text(content) { return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})+'\\n\\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}}); }
    function tool(name,args) {return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});}
    function results(body) { const last = body.messages.findLastIndex(message => message.role==='user'); return body.messages.slice(last+1).filter(message=>message.role==='tool'); }
    const ref = path => ({scopeId:runtime.scopeIds[0],path});
    const options = {runId:'offline-runtime',fixture,ledger,signal:control.signal,mode:'offline-injected',
      beforeDispatch:async (_event,signal)=>signal.throwIfAborted(),
      createProfile:async (files,signal)=> {profiles++;const prepared = await prepareLiveCredentialSelection({sourceDatabasePath:sourcePath,providerId:'selected',expectedBaseUrl:baseUrl,model:'offline-model',includeBrave:true},{beforeRead:()=>true,signal});
        const profile = await copyLiveCredentialSelection(prepared.token,{beforeRead:()=>true,signal,fixture:files});ownedRoot=profile.isolatedRoot;return profile;},
      createVault:()=>({put:async()=>{throw new Error('Read only fake');},get:async()=> 'OFFLINE_RUNTIME_DUMMY_KEY'}),
      fetchImpl:async (_url,init)=>{ const body=JSON.parse(init.body);wire.push({phase,kind:'provider'});return responder(body);},
      webDependencies:{resolve:async()=>[{address:'93.184.216.34',family:4}],transport:async({url})=>{const search=url.hostname==='api.search.brave.com';wire.push({phase,kind:search?'search':'page'});return {status:200,headers:{'content-type':search?'application/json':'text/html'},body:Buffer.from(search?JSON.stringify({type:'search',web:{results:[{title:'Offline research',url:'https://public.example/paper',description:'Synthetic test metadata only'}]}}):'<html><head><title>Offline research</title></head><body><main>Explicit offline evidence used to exercise real service provenance and persistence. This is synthetic content and not a paper validation.</main></body></html>')};}}
    };
    async function drive(id='initial',decision='allow-once') {
      phase=id;runtime.enterPhase(id);await runtime.service.sendTask(runtime.conversationId,renderLiveCaseTask(fixture,id));
      for(let i=0;i<2500;i++) { const c=runtime.service.getConversation(runtime.conversationId);
        if(c.pendingPermission) {const request=c.pendingPermission;await runtime.beforePermissionReview(request,id,control.signal);approvals.push({request,decision,phaseId:id});
          if(request.preview.plan) runtime.service.decideActionPlan(c.id,request.requestId,request.preview.plan.digest,decision);
          else if(request.preview.research) runtime.service.decideResearch(c.id,request.requestId,request.preview.research.digest,decision);
          else runtime.service.decidePermission(c.id,request.requestId,decision);
        } else if(['completed','failed','cancelled','interrupted'].includes(c.state)) return c;
        await new Promise(resolve=>setTimeout(resolve,2));
      } throw new Error('Offline runtime did not settle');
    }
    try { ${code}
      assert.equal(hash(readFileSync(sourcePath)),beforeHash);
      if(runtime) {await Promise.all([runtime.dispose(),runtime.dispose()]);assert(!existsSync(ownedRoot));}
      console.log(JSON.stringify({caseId:fixture.caseId,offline:true,profiles,wire:wire.length}));
    } finally {try{await runtime?.dispose();}finally{journal.close();await fixture.close();rmSync(root,{recursive:true,force:true});}}
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', script], {
      timeout: 20000,
      maxBuffer: 32768,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ caseId, offline: true });
  } catch (error) {
    throw new Error(
      `Owned offline runtime test failed:\n${((error as { stderr?: string }).stderr ?? 'Child did not settle.').slice(0, 8192)}`,
    );
  }
}
test('production rejects injected transports and unsupported crash boundary before profile access', async () => {
  await native(
    'C07',
    `
    await assert.rejects(createLiveDesktopRuntime(options));assert.equal(profiles,0);assert.equal(wire.length,0);
    await assert.rejects(createLiveDesktopRuntime({...options,mode:'production-default',beforeCrashCommit:()=>{throw new Error('Not an exit');}}));assert.equal(profiles,0);
  `,
  );
});
test('offline runtime cannot accidentally fall back to actual provider or Web ports', async () => {
  await native(
    'F02',
    `
    await assert.rejects(createLiveDesktopRuntime({...options,fetchImpl:undefined}));assert.equal(profiles,0);assert.equal(wire.length,0);
    await assert.rejects(createLiveDesktopRuntime({...options,webDependencies:{resolve:options.webDependencies.resolve}}));
    assert.equal(profiles,1);assert.equal(wire.length,0);assert(!existsSync(ownedRoot));
  `,
  );
});
test('actual service copies bytes using one immutable approval and an isolated selected profile', async () => {
  await native(
    'F02',
    `
    responder=body=>results(body).length?text('Copied, source retained.'):tool('execute_plan',{title:'Offline binary copy',actions:[{kind:'copy_file',source:ref('source.bin'),target:ref('copy.bin')}]});
    runtime=await createLiveDesktopRuntime(options);const conversation=await drive();
    assert.equal(conversation.state,'completed');assert.deepEqual(readFileSync(join(fixture.root,'copy.bin')),readFileSync(join(fixture.root,'source.bin')));
    assert.equal(approvals.length,1);assert.equal(runtime.receipts().length,2);
    const outcome=await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()});assert.equal(outcome.objective,'verified');
  `,
  );
});
test('actual denial barrier requires a distinct follow-up plan and new approval', async () => {
  await native(
    'C10',
    `
    responder=body=>results(body).length?text('Actual result reported.'):tool('execute_plan',{title:'Offline selected move',actions:[{kind:'move_file',source:ref('input.txt'),target:ref(phase==='initial'?'denied.txt':'allowed.txt')}]});
    runtime=await createLiveDesktopRuntime(options);await drive('initial','deny');assert(!existsSync(join(fixture.root,'denied.txt')));
    await runtime.prepareFollowUp('deny-first-plan','new-authorized-task',control.signal);
    const conversation=await drive('new-authorized-task');assert.equal(approvals.length,2);
    assert.notEqual(approvals[0].request.preview.plan.id,approvals[1].request.preview.plan.id);
    assert.equal((await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()})).objective,'verified');
  `,
  );
});
test('Stop after the first actual file effect leaves later actions for a fresh plan', async () => {
  await native(
    'C05',
    `
    responder=body=>results(body).length?text('Reported exact written files.'):tool('execute_plan',{title:'Offline ordered creation',actions:(phase==='initial'?['first','second','third']:['second','third']).map(name=>({kind:'write_text',target:ref(name+'.txt'),content:name+'.txt approved content'}))});
    runtime=await createLiveDesktopRuntime(options);const first=await drive();assert.equal(first.state,'cancelled');
    assert(existsSync(join(fixture.root,'first.txt')));assert(!existsSync(join(fixture.root,'second.txt')));
    await runtime.prepareFollowUp('request-stop-after-effect','after-stop',control.signal);
    const conversation=await drive('after-stop');assert.equal((await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()})).objective,'verified');
  `,
  );
});
test('actual SQLite running-transition failure is followed by shutdown/reopen and fresh approval', async () => {
  await native(
    'C09',
    `
    responder=body=>results(body).length?text('Reported actual storage outcome.'):tool('execute_plan',{title:'Offline storage recovery',actions:[{kind:'write_text',target:ref('storage-result.txt'),content:'Recovered under fresh approval'}]});
    runtime=await createLiveDesktopRuntime(options);await drive();assert(!existsSync(join(fixture.root,'storage-result.txt')));
    await runtime.prepareFollowUp('sqlite-before-running','after-storage-failure',control.signal);
    const conversation=await drive('after-storage-failure');assert.equal(approvals.length,2);
    assert.equal((await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()})).objective,'verified');
  `,
  );
});
test('actual service search/fetch results bind exact selected sources to metered receipts', async () => {
  await native(
    'W01',
    `
    responder=body=> {const rs=results(body);if(!rs.length)return tool('authorize_research',{title:'Offline bounded research',queries:[{query:'Offline research',maxResults:1}],maxFetches:1,maxResponseBytes:2097152,lifetimeSeconds:60});
      if(rs.length===1)return tool('web_search',{query:'Offline research',maxResults:1});
      if(rs.length===2)return tool('fetch_source',{sourceId:JSON.parse(rs[1].content).sources[0].id});return text('Explicit synthetic evidence [source:'+JSON.parse(rs[2].content).sources[0].id+']');};
    runtime=await createLiveDesktopRuntime(options);const conversation=await drive();
    const web=runtime.webEvidence();assert.equal(web.sources.length,1);assert.equal(web.issues.length,0);assert.equal(web.searches.length,1);
    assert(runtime.receipts().some(receipt=>receipt.reservationId===web.sources[0].fetchReceiptId&&receipt.kind==='page'&&receipt.ledgerSettled));
    assert.equal(conversation.sources.filter(source=>source.kind==='page').length,1);assert.equal(runtime.mode,'offline-injected');
    assert.equal((await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()})).objective,'verified');
  `,
  );
});
test('C04 stops synchronously after actual source persistence with no subsequent HTTP', async () => {
  await native(
    'C04',
    `
    responder=body=> {const rs=results(body);if(!rs.length)return tool('authorize_research',{title:'Offline Stop research',queries:[{query:'Offline research',maxResults:1}],maxFetches:2,maxResponseBytes:2097152,lifetimeSeconds:60});
      if(rs.length===1)return tool('web_search',{query:'Offline research',maxResults:1});
      if(rs.length===2)return tool('fetch_source',{sourceId:JSON.parse(rs[1].content).sources[0].id});throw new Error('Stop boundary failed; later model entered');};
    runtime=await createLiveDesktopRuntime(options);const conversation=await drive();assert.equal(conversation.state,'cancelled');
    const observation=runtime.evidence().observations.find(entry=>entry.boundaryId==='request-stop-after-page');
    assert(observation);assert.equal(observation.requestCountBefore,observation.requestCountAfter);
    assert(conversation.sources.some(source=>source.id===observation.sourceId&&source.kind==='page'));
    assert.equal(runtime.webEvidence().issues.length,0);assert.equal(wire.filter(entry=>entry.kind==='provider').length,3);
  `,
  );
});
test('actual service restart preserves source metadata and requires new research authorization', async () => {
  await native(
    'W10',
    `
    responder=body=> {const rs=results(body);if(!rs.length)return tool('authorize_research',{title:'Offline restart research',queries:[{query:'Offline research',maxResults:1}],maxFetches:1,maxResponseBytes:2097152,lifetimeSeconds:60});
      if(rs.length===1)return tool('web_search',{query:'Offline research',maxResults:1});
      if(rs.length===2)return tool('fetch_source',{sourceId:JSON.parse(rs[1].content).sources[0].id});return text('Explicit synthetic research result.');};
    runtime=await createLiveDesktopRuntime(options);const before=await drive();assert.equal(before.sources.filter(source=>source.kind==='page').length,1);
    await runtime.prepareFollowUp('service-restart','after-restart',control.signal);
    const restored=runtime.service.getConversation(runtime.conversationId);assert.equal(restored.pendingPermission,undefined);
    assert(restored.timeline.every(item=>!item.result?.sources));
    const conversation=await drive('after-restart');assert.equal(approvals.length,2);
    assert.notEqual(approvals[0].request.preview.research.id,approvals[1].request.preview.research.id);
    assert.equal(runtime.evidence().pageToolResults.length,2);
    assert.equal((await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()})).objective,'verified');
  `,
  );
});
test('runtime abort synchronously stops actual pending service without a file effect', async () => {
  await native(
    'F02',
    `
    responder=()=>tool('execute_plan',{title:'Offline pending copy',actions:[{kind:'copy_file',source:ref('source.bin'),target:ref('copy.bin')}]});
    runtime=await createLiveDesktopRuntime(options);await runtime.service.sendTask(runtime.conversationId,renderLiveCaseTask(fixture));
    for(let i=0;i<1000&&!runtime.service.getConversation(runtime.conversationId).pendingPermission;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert(runtime.service.getConversation(runtime.conversationId).pendingPermission);control.abort();
    await runtime.service.stopTask(runtime.conversationId);
    assert.equal(runtime.service.getConversation(runtime.conversationId).state,'cancelled');assert(!existsSync(join(fixture.root,'copy.bin')));
  `,
  );
});
test('long dialogue observes actual summary requests and reviews accepted summary transiently', async () => {
  await native(
    'C02',
    `
    let reviewed=0;
    options.reviewSummary=async ({text},signal)=>{signal.throwIfAborted();reviewed++;assert(text.includes('only copy'));assert(text.includes(runtime.webEvidence().sources[0].id));};
    responder=body=> {
      if(body.messages[0]?.content?.startsWith('Summarize conversation data for continuity, using no tools.'))return text('Keep the original goal and source '+runtime.webEvidence().sources[0].id+'. Keep original and sentinel unchanged; only copy original.txt to SummaryCopies/original.txt after fresh approval.');
      const rs=results(body);
      if(phase==='initial') {if(!rs.length)return tool('authorize_research',{title:'Offline long research',queries:[{query:'Offline research',maxResults:1}],maxFetches:1,maxResponseBytes:2097152,lifetimeSeconds:60});
        if(rs.length===1)return tool('web_search',{query:'Offline research',maxResults:1});if(rs.length===2)return tool('fetch_source',{sourceId:JSON.parse(rs[1].content).sources[0].id});return text('Retained synthetic identity and constraints.');}
      if(phase==='finish-after-summary'&&!rs.length)return tool('execute_plan',{title:'Offline constrained final copy',actions:[{kind:'create_directory',target:ref('SummaryCopies')},{kind:'copy_file',source:ref('original.txt'),target:ref('SummaryCopies/original.txt')}]});
      return text('The source identity and original-preserving constraint remain in scope.');
    };
    runtime=await createLiveDesktopRuntime(options);await drive();for(let i=1;i<=12;i++)await drive('context-'+i);
    const conversation=await drive('finish-after-summary');assert(reviewed>0);assert(runtime.summaryEvidence().length>0);
    assert(!JSON.stringify(runtime.summaryEvidence()).includes('only copy'));
    const outcome=await verifyLiveCaseOutcome(fixture,{conversation,approvals,...runtime.evidence()});
    assert.equal(outcome.objective,'verified',JSON.stringify({checks:outcome.checks,plans:conversation.actionPlans?.map(plan=>({status:plan.status})),errors:conversation.timeline.filter(item=>item.type==='error'||item.result?.isError).map(item=>({name:item.call?.name,text:item.text,result:item.result?.content}))}));
  `,
  );
});
