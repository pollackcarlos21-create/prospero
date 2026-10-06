import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { LiveBudgetManifest } from '../acceptance/live-budget';
import type { LiveChildPermissionBinding } from '../acceptance/live-child-permission';

// Both generations run in actual Node, including native SQLite. All credentials,
// review callbacks and HTTP responses below are explicitly synthetic offline fixtures.
const execute = promisify(execFile);
let buildRoot: string;
let moduleUrl: string;
beforeAll(async () => {
  buildRoot = await realpath(await mkdtemp(join(tmpdir(), 'prospero-child-budget-tests-')));
  const entry = join(buildRoot, 'entry.ts');
  const modules = [
    'live-approval',
    'live-budget',
    'live-budget-journal',
    'live-child-permission',
    'live-child-permission-worker',
    'live-crash-recovery',
    'live-credential-selection',
    'live-fixtures',
    'live-reconcile',
    'live-transport',
  ];
  await writeFile(
    entry,
    modules
      .map((name) => `export * from ${JSON.stringify(resolve(`tests/acceptance/${name}.ts`))};`)
      .join('\n') +
      `\nexport { DesktopService } from ${JSON.stringify(resolve('apps/desktop/src/main/service.ts'))};` +
      `\nexport { ProsperoStore } from ${JSON.stringify(resolve('packages/persistence/src/index.ts'))};`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: buildRoot,
    target: 'node',
    format: 'esm',
  });
  if (!result.success) throw new Error('Owned child budget composition could not be compiled.');
  moduleUrl = pathToFileURL(join(buildRoot, 'entry.js')).href;
});
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

interface WorkerConfig {
  bundle: string;
  databasePath: string;
  budgetPath: string;
  manifest: LiveBudgetManifest;
  binding: LiveChildPermissionBinding;
  root: string;
  task: string;
  endpoint: string;
  expiresAt: number;
  response: string;
  lostAck: boolean;
}

// This function is serialized into a hash-pinned, owned CJS entry. It deliberately
// contains no references to the parent test's lexical scope or inherited credentials.
function offlineChild(config: WorkerConfig) {
  void (async () => {
    const assert: typeof import('node:assert/strict') = (await import('node:assert/strict'))
      .default;
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const {
      DesktopService,
      ProsperoStore,
      SqliteLiveBudgetJournal,
      LiveBudgetLedger,
      createBudgetedProviderFetch,
      reconcileLiveBudget,
      attachLiveChildPermissionWorker,
    } = await import(config.bundle);
    const journal = new SqliteLiveBudgetJournal(config.budgetPath, { mode: 'resume' });
    const ledger = new LiveBudgetLedger(config.manifest, {
      journal,
      humanConfirmed: true, // Technical offline fixture flag, never actual human consent.
      executionIdentity: {
        sourceSha256: config.manifest.sourceSha256,
        buildSha256: config.manifest.buildSha256,
      },
    });
    ledger.availableResponseBytes();
    assert.equal(ledger.usage().provider, 1);
    assert.equal(ledger.manifest.expiresAt, config.expiresAt);
    let ports = 0;
    const meter = createBudgetedProviderFetch({
      ledger,
      caseId: () => 'C07',
      baseUrl: config.endpoint,
      fetchImpl: async () => {
        ports++;
        assert.equal(ports, 1);
        // finish_reason plus actual EOF lets the real parser observe the whole body.
        return new Response(config.response, { headers: { 'content-type': 'text/event-stream' } });
      },
      beforeDispatch: async (_boundary: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        const head = reconcileLiveBudget({
          databasePath: config.budgetPath,
          manifest: config.manifest,
          receipts: [],
        });
        assert.equal(head.manifestDigest, config.manifest.digest);
        assert(head.counts.requests.provider <= config.manifest.limits.provider);
        assert.equal(head.counts.closed, false);
        assert(Date.now() < config.expiresAt);
      },
    });
    assert.equal(meter.transportMode, 'offline-injected');
    const nativeSend = process.send?.bind(process);
    assert(nativeSend);
    if (config.lostAck) {
      process.send = ((message: { type?: string }, ...rest: unknown[]) => {
        if (message.type === 'permission-ack') {
          const callback = rest.find((value) => typeof value === 'function');
          queueMicrotask(() => {
            if (typeof callback === 'function') callback(null);
          });
          return true;
        }
        return Reflect.apply(nativeSend, process, [message, ...rest]);
      }) as typeof process.send;
    }
    class CrashStore extends ProsperoStore {
      constructor(path: string) {
        super(path);
      }
      actionJournal(id: string, executionId: string) {
        const delegate = super.actionJournal(id, executionId);
        return {
          ...delegate,
          transition(planId: string, actionId: string, status: string, detail?: string) {
            if (actionId === 'action-2' && status === 'succeeded') {
              assert.equal(
                readFileSync(join(config.root, 'second.txt'), 'utf8'),
                'second.txt approved content',
              );
              assert.equal(ports, 1);
              assert.equal(meter.receipts()[0].outcome, 'completed');
              assert.equal(meter.receipts()[0].bytesKnown, true);
              assert.equal(ledger.usage().provider, 2);
              assert.equal(ledger.usage().reservedResponseBodyBytes, 0);
              process.send?.({
                version: 1,
                type: 'boundary',
                caseId: 'C07',
                phaseId: 'initial',
                boundaryId: 'process-exit-after-effect-before-journal',
                planId,
                actionId,
              });
              process.send?.({ version: 1, type: 'exit-intent', code: 23 });
              // Exit synchronously before returning to the actual host journal transition.
              process.exit(23);
            }
            delegate.transition(planId, actionId, status, detail);
          },
        };
      }
    }
    const store = new CrashStore(config.databasePath);
    const vault = {
      get: async () => 'OFFLINE_CHILD_BUDGET_FAKE_KEY',
      put: async () => {
        throw new Error('Read-only fixture');
      },
    };
    const service = new DesktopService(
      store,
      vault,
      { folder: async () => config.root, files: async () => [] },
      () => {},
      'offline-child-budget',
      undefined,
      undefined,
      undefined,
      1000,
      meter.fetch,
    );
    const worker = attachLiveChildPermissionWorker({
      service,
      binding: config.binding,
      expiresAt: config.expiresAt,
    });
    process.send?.({ version: 1, type: 'ready' });
    await service.sendTask(config.binding.conversationId, config.task);
    for (let index = 0; index < 2500; index++) {
      worker.publishPending();
      const conversation = service.getConversation(config.binding.conversationId);
      if (['completed', 'failed', 'cancelled'].includes(conversation.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await worker.close();
    await service.shutdown();
    store.close();
    journal.close();
    process.exit(6); // Reaching normal settlement would miss the required crash boundary.
  })().catch(() => process.exit(7));
}

async function composed(lostAck: boolean) {
  const program = `
    import assert from 'node:assert/strict';
    import { createHash,randomUUID } from 'node:crypto';
    import { existsSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
    import { dirname,join } from 'node:path';
    import { createLiveFixture,prepareLiveCredentialSelection,copyLiveCredentialSelection,
      superviseLiveFixtureChild,assertLiveFixtureChildOutcome,captureLiveCrashBoundary,verifyLiveCrashRecovery,
      reconcileLiveCrashParentDecision,createLiveParentPermissionSession,livePermissionFingerprint,ReviewedLivePermission,
      createLiveBudgetManifest,LiveBudgetLedger,SqliteLiveBudgetJournal,createBudgetedProviderFetch,reconcileLiveBudget,
      DesktopService,ProsperoStore,renderLiveCaseTask } from ${JSON.stringify(moduleUrl)};
    const cleanup=[];const lostAck=${JSON.stringify(lostAck)};
    const hash=value=>createHash('sha256').update(value).digest('hex');
    const endpoint='https://offline.example.test/v1';
    const provider={id:'selected',displayName:'Offline budget handoff fixture',baseUrl:endpoint,
      model:'offline-model',timeoutMs:1000,supportsTools:true,hasApiKey:true};
    const vault={get:async()=> 'OFFLINE_CHILD_BUDGET_FAKE_KEY',put:async()=>{throw new Error('Read-only fake fixture');}};
    function serviceFor(store,fixture,fetchImpl) {
      return new DesktopService(store,vault,{folder:async()=>fixture.root,files:async()=>[]},()=>{},
        'offline-parent-budget',undefined,undefined,undefined,1000,fetchImpl);
    }
    function packet(delta,finish_reason) {
      // A finite offline body with a real EOF; no artificial DONE-to-EOF accounting shortcut.
      return 'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\\n\\n';
    }
    function planPacket(scopeId,names,callId) {
      const actions=names.map(name=>({kind:'write_text',target:{scopeId,path:name},content:name+' approved content'}));
      return packet({tool_calls:[{index:0,id:callId,type:'function',function:{name:'execute_plan',
        arguments:JSON.stringify({title:'Offline reviewed fixture writes',actions})}}]},'tool_calls');
    }
    try {
      const fixture=await createLiveFixture('C07');cleanup.push(()=>fixture.close());
      const sourcePath=join(dirname(fixture.root),'source-reference.sqlite');
      const source=new ProsperoStore(sourcePath);source.saveProvider(provider);
      source.saveEncryptedCredential(provider.id,Uint8Array.from([11,9,7,5]));source.close();
      const sourceHash=hash(readFileSync(sourcePath));
      const prepared=await prepareLiveCredentialSelection({sourceDatabasePath:sourcePath,providerId:provider.id,
        expectedBaseUrl:endpoint,model:provider.model,includeBrave:false},{beforeRead:()=>true});
      const profile=await copyLiveCredentialSelection(prepared.token,{fixture,beforeRead:()=>true});cleanup.push(()=>profile.close());
      const setupStore=new ProsperoStore(profile.databasePath);
      const setupService=serviceFor(setupStore,fixture,async()=>{throw new Error('No setup HTTP');});
      const c=setupService.createConversation();setupService.selectProvider(c.id,provider.id);await setupService.addScope(c.id,'write');
      const scopeId=setupService.getConversation(c.id).scopes[0].id;await setupService.shutdown();setupStore.close();
      const budgetPath=join(dirname(fixture.root),'same-budget.sqlite');
      const firstJournal=new SqliteLiveBudgetJournal(budgetPath,{mode:'create'});cleanup.push(()=>firstJournal.close());
      const now=Date.now();
      const identity={sourceSha256:hash('owned offline source fixture'),buildSha256:hash(readFileSync(${JSON.stringify(join(buildRoot, 'entry.js'))}))};
      const manifest=createLiveBudgetManifest({authorizationId:'offline_handoff_'+randomUUID(),...identity,
        journalSha256:firstJournal.identitySha256,caseIds:['F02','C07'],createdAt:now,expiresAt:now+20000,
        limits:{provider:4,search:0,page:0,redirects:0,responseBodyBytes:16*1024*1024,wallClockMs:20000}});
      const first=new LiveBudgetLedger(manifest,{journal:firstJournal,humanConfirmed:true,executionIdentity:identity});
      const probeBody=JSON.stringify({data:[{id:provider.model}]});let probePorts=0;
      const probe=createBudgetedProviderFetch({ledger:first,caseId:()=> 'F02',baseUrl:endpoint,
        fetchImpl:async()=>{probePorts++;return new Response(probeBody,{headers:{'content-type':'application/json'}});}});
      // This prior F02 connection probe is explicitly visible and actually metered. It is
      // not an invented/dummy authorization event inserted merely to make resume work.
      assert.equal(await (await probe.fetch(endpoint+'/models')).text(),probeBody);
      assert.equal(probePorts,1);assert.equal(probe.transportMode,'offline-injected');
      assert.equal(probe.receipts()[0].outcome,'completed');assert.equal(probe.receipts()[0].bytesKnown,true);
      const priorReceipts=probe.receipts();const prior=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:priorReceipts});
      assert.equal(prior.status,'reconciled');assert.equal(prior.counts.requests.provider,1);
      assert.equal(prior.counts.chargedBytes,Buffer.byteLength(probeBody));assert.equal(prior.counts.reservedBytes,0);
      first.suspendForHandoff();const oldUsage=first.usage();firstJournal.close();
      assert.equal(oldUsage.localWriterSuspended,true);assert.equal(oldUsage.closed,false);
      let parentChecks=0;
      async function assertCurrent(signal) {
        signal.throwIfAborted();parentChecks++;
        // Independent readonly SQLite head only: never first.usage() or a resumed parent writer.
        const current=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:priorReceipts});
        assert.equal(current.authorizationId,manifest.authorizationId);assert.equal(current.manifestDigest,manifest.digest);
        assert.equal(current.journalSha256,manifest.journalSha256);assert.equal(current.counts.closed,false);
        assert(current.counts.requests.provider<=manifest.limits.provider);assert(Date.now()<manifest.expiresAt);
        signal.throwIfAborted();
      }
      const binding={runId:'offline-budget-run',generationId:randomUUID(),caseId:'C07',phaseId:'initial',conversationId:c.id};
      let reviewed=0;let oldRequest;
      const session=createLiveParentPermissionSession({binding,boundary:{roots:[fixture.root],scopeIds:[scopeId]},
        expiresAt:manifest.expiresAt,assertCurrent,reviewPermission:async({request,fingerprint},signal)=>{
          await assertCurrent(signal);reviewed++;assert(Object.isFrozen(request));assert(Object.isFrozen(request.preview.plan));
          assert.equal(fingerprint,livePermissionFingerprint(request));assert.equal(request.preview.plan.actions.length,3);
          for(const name of ['first.txt','second.txt','third.txt'])assert(!existsSync(join(fixture.root,name)));
          const current=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:priorReceipts});
          assert.equal(current.counts.requests.provider,2);assert.equal(current.counts.reservedBytes,0);
          assert.equal(current.accountingComplete,true);assert.equal(current.status,'pending');
          oldRequest=request;return 'allow-once'; // Synthetic offline review, no actual human proof.
        }});
      const childResponse=planPacket(scopeId,['first.txt','second.txt','third.txt'],'offline-child-plan');
      const config={bundle:${JSON.stringify(moduleUrl)},databasePath:profile.databasePath,budgetPath,manifest,binding,
        root:fixture.root,task:renderLiveCaseTask(fixture,'initial'),endpoint,expiresAt:manifest.expiresAt,response:childResponse,lostAck};
      const sourceCode=${JSON.stringify(`(${offlineChild.toString()})`)}+'('+JSON.stringify(config)+');';
      const entryPath=join(profile.isolatedRoot,'offline-budget-worker.cjs');writeFileSync(entryPath,sourceCode,{mode:0o600});
      const execPath=realpathSync(process.execPath);const expectedExecSha256=hash(readFileSync(execPath));
      const outcome=await superviseLiveFixtureChild(fixture,{entryPath,expectedEntrySha256:hash(sourceCode),
        cwd:profile.isolatedRoot,execPath,deadlineMs:8000,permissionSession:session});
      assertLiveFixtureChildOutcome(fixture,outcome);
      assert.equal(outcome.reason,'exited');assert.equal(outcome.actualExitCode,23);
      assert.equal(outcome.actualExitSignal,null);assert.equal(outcome.exitObserved,true);assert.equal(outcome.closeObserved,true);
      assert.equal(reviewed,1);assert(parentChecks>=4);
      assert.equal(session.evidence().records.length,1);
      assert.equal(session.evidence().records[0].fingerprint,livePermissionFingerprint(oldRequest));
      assert.equal(session.evidence().records[0].acknowledged,!lostAck);
      assert.equal(session.evidence().status,lostAck?'pending':'acknowledged');
      assert.equal(session.evidence().reason,lostAck?'ack-missing':null);
      const crashed=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:priorReceipts});
      assert.equal(crashed.counts.requests.provider,2);assert.equal(crashed.counts.dispatchIntents,2);
      assert.equal(crashed.counts.settledReservations,2);assert.equal(crashed.counts.reservedBytes,0);
      assert.equal(crashed.counts.chargedBytes,Buffer.byteLength(probeBody)+Buffer.byteLength(childResponse));
      assert.equal(crashed.counts.unknownSettlements,0);assert.equal(crashed.accountingComplete,true);
      assert.equal(crashed.status,'pending');assert.equal(crashed.transportEvidenceComplete,false);
      assert.equal(crashed.gaps.length,1);assert.equal(crashed.gaps[0].reason,'missing-receipt');
      assert.equal(crashed.facts.find(fact=>fact.caseId==='C07').transportAttempted,'unknown');
      assert.equal(crashed.counts.observedTransportAttempts,1);
      const boundary=await captureLiveCrashBoundary({fixture,profile,outcome,conversationId:c.id,
        expectedEntrySha256:hash(sourceCode),expectedExecSha256});
      const matched=reconcileLiveCrashParentDecision(boundary,session);
      assert.equal(matched.permissionFingerprint,livePermissionFingerprint(oldRequest));
      assert.equal(matched.delivery,lostAck?'durably-reconciled':'acknowledged');
      assert.equal(session.evidence().records[0].acknowledged,!lostAck); // Reconciliation cannot invent ACK.
      // Only the owned process's actual exit AND close permit the parent to resume the same writer.
      const nextJournal=new SqliteLiveBudgetJournal(budgetPath,{mode:'resume'});cleanup.push(()=>nextJournal.close());
      const next=new LiveBudgetLedger(manifest,{journal:nextJournal,humanConfirmed:true,executionIdentity:identity});
      assert.equal(next.availableResponseBytes(),manifest.limits.responseBodyBytes-crashed.counts.chargedBytes);
      assert.equal(next.usage().provider,2);assert.equal(next.usage().chargedResponseBodyBytes,crashed.counts.chargedBytes);
      assert.equal(next.manifest.createdAt,now);assert.equal(next.manifest.expiresAt,manifest.expiresAt);
      assert.equal(nextJournal.load(manifest).revision,crashed.revision);
      let remainingPorts=0;
      const remainingPlan=planPacket(scopeId,['third.txt'],'offline-new-plan');
      const completion=packet({content:'Explicit offline task completed after actual third-file result.'},'stop');
      const remaining=createBudgetedProviderFetch({ledger:next,caseId:()=> 'C07',baseUrl:endpoint,
        fetchImpl:async(_url,init)=>{remainingPorts++;assert(remainingPorts<=2);const body=JSON.parse(init.body);
          if(remainingPorts===2)assert(body.messages.some(message=>message.role==='tool'));
          return new Response(remainingPorts===1?remainingPlan:completion,{headers:{'content-type':'text/event-stream'}});},
        beforeDispatch:async(_event,signal)=>assertCurrent(signal)});
      const recoveredStore=new ProsperoStore(profile.databasePath);const recoveredService=serviceFor(recoveredStore,fixture,remaining.fetch);
      cleanup.push(async()=>{await recoveredService.shutdown();recoveredStore.close();});
      const recovered=await verifyLiveCrashRecovery(boundary,recoveredService);
      assert.equal(recoveredService.getConversation(c.id).state,'interrupted');
      assert.equal(recovered.previousApproval.request.requestId,oldRequest.requestId);
      const firstHash=hash(readFileSync(join(fixture.root,'first.txt')));const secondHash=hash(readFileSync(join(fixture.root,'second.txt')));
      assert(!existsSync(join(fixture.root,'third.txt')));assert.equal(remainingPorts,0);
      await recoveredService.sendTask(c.id,renderLiveCaseTask(fixture,'after-crash'));
      let freshReviewed=0;let freshRequest;let completed;
      for(let index=0;index<2500;index++){
        const conversation=recoveredService.getConversation(c.id);
        if(conversation.pendingPermission){
          assert.equal(freshReviewed,0);freshReviewed++;freshRequest=conversation.pendingPermission;
          assert.notEqual(freshRequest.requestId,oldRequest.requestId);assert.notEqual(freshRequest.preview.plan.id,oldRequest.preview.plan.id);
          assert.equal(freshRequest.preview.plan.actions.length,1);assert.equal(freshRequest.preview.plan.actions[0].target,join(fixture.root,'third.txt'));
          assert.equal(hash(readFileSync(join(fixture.root,'first.txt'))),firstHash);assert.equal(hash(readFileSync(join(fixture.root,'second.txt'))),secondHash);
          assert(!existsSync(join(fixture.root,'third.txt')));
          assert.throws(()=>recoveredService.decideActionPlan(c.id,oldRequest.requestId,oldRequest.preview.plan.digest,'allow-once'));
          await assertCurrent(new AbortController().signal);
          const review=new ReviewedLivePermission(freshRequest,{boundary:{roots:[fixture.root],scopeIds:[scopeId]},
            expiresAt:manifest.expiresAt,humanReviewed:true});
          const current=recoveredService.getConversation(c.id).pendingPermission;
          assert.equal(livePermissionFingerprint(current),livePermissionFingerprint(freshRequest));
          const decision=review.claim(current);recoveredService.decideActionPlan(c.id,current.requestId,current.preview.plan.digest,decision);
        } else if(['completed','failed','cancelled'].includes(conversation.state)){completed=conversation;break;}
        await new Promise(resolve=>setTimeout(resolve,2));
      }
      assert.equal(completed?.state,'completed');assert.equal(freshReviewed,1);assert.equal(remainingPorts,2);
      assert.equal(remaining.transportMode,'offline-injected');assert.equal(remaining.receipts().length,2);
      assert(remaining.receipts().every(receipt=>receipt.bytesKnown&&receipt.ledgerSettled&&receipt.outcome==='completed'));
      for(const name of ['first.txt','second.txt','third.txt'])assert.equal(readFileSync(join(fixture.root,name),'utf8'),name+' approved content');
      assert.equal(hash(readFileSync(join(fixture.root,'first.txt'))),firstHash);assert.equal(hash(readFileSync(join(fixture.root,'second.txt'))),secondHash);
      const plans=recoveredStore.actionPlans(c.id);assert.equal(plans.length,2);assert.equal(plans[0].status,'interrupted');
      assert.equal(plans[1].status,'completed');assert.equal(plans[1].plan.actions.length,1);
      const finalReceipts=[...priorReceipts,...remaining.receipts()];
      const final=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:finalReceipts});
      assert.equal(final.counts.requests.provider,4);assert.equal(final.counts.dispatchIntents,4);assert.equal(final.counts.settledReservations,4);
      assert.equal(final.counts.reservedBytes,0);assert.equal(final.counts.closed,false);assert.equal(final.counts.unknownSettlements,0);
      assert.equal(final.counts.chargedBytes,crashed.counts.chargedBytes+Buffer.byteLength(remainingPlan)+Buffer.byteLength(completion));
      assert.equal(final.accountingComplete,true);assert.equal(final.status,'pending');assert.equal(final.gaps.length,1);
      assert.equal(final.gaps[0].reservationId,crashed.gaps[0].reservationId);assert.equal(final.gaps[0].reason,'missing-receipt');
      assert.equal(final.counts.observedTransportAttempts,3);assert.equal(final.counts.unknownTransportAttempts,1);
      assert.equal(next.usage().provider,4);assert.equal(next.usage().chargedResponseBodyBytes,final.counts.chargedBytes);
      assert.equal(oldUsage.provider,1);assert.equal(oldUsage.journalRevision,prior.revision);
      assert.throws(()=>first.reserve({caseId:'C07',kind:'provider',responseBytes:1}),/suspended/);
      assert.throws(()=>first.abort(),/suspended/);
      await assert.rejects(()=>remaining.fetch(endpoint+'/models'),/budget/);assert.equal(remainingPorts,2);
      const afterRefusal=reconcileLiveBudget({databasePath:budgetPath,manifest,receipts:finalReceipts});
      assert.equal(afterRefusal.revision,final.revision);assert.equal(afterRefusal.globalHistoryHash,final.globalHistoryHash);
      assert.equal(afterRefusal.counts.requests.provider,4);assert.equal(afterRefusal.counts.chargedBytes,final.counts.chargedBytes);
      assert.equal(hash(readFileSync(sourcePath)),sourceHash);
      const exported=JSON.stringify({permission:session.evidence(),budget:final});
      assert(!exported.includes('OFFLINE_CHILD_BUDGET_FAKE_KEY'));assert(!exported.includes('approved content'));
      console.log(JSON.stringify({offline:true,provider:4,accountingComplete:true,transportEvidence:'pending',acknowledged:!lostAck}));
    } finally {for(const close of cleanup.reverse())await close();}
  `;
  try {
    const result = await execute('node', ['--input-type=module', '--eval', program], {
      timeout: 30000,
      maxBuffer: 16384,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      offline: true,
      provider: 4,
      accountingComplete: true,
      transportEvidence: 'pending',
      acknowledged: !lostAck,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? 'Owned process did not settle.';
    throw new Error(`Owned child budget composition failed:\n${stderr.slice(0, 8192)}`);
  }
}

test('actual C07 service crash transfers the same durable writer, retains prior quota and meters a newly approved remainder', async () => {
  await composed(false);
}, 30000);

test('lost child ACK is reconciled against actual crash state while missing transport receipt stays pending across writer resume', async () => {
  await composed(true);
}, 30000);
