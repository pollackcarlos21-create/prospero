import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DesktopService } from '../../apps/desktop/src/main/service';
import { ProsperoStore } from '../../packages/persistence/src';
import { createLiveBudgetManifest, LiveBudgetLedger } from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import {
  captureLiveFixtureCheckpoint,
  type LiveControlledObservation,
  type LiveFixtureCheckpoint,
} from '../acceptance/live-fixtures';
import { reconcileLiveBudget } from '../acceptance/live-reconcile';
import { LIVE_SAFETY_GATES, type LiveRunIdentity } from '../acceptance/live-report';
import {
  LiveRunController,
  type LiveControllerOptions,
  type LiveRunReview,
  type LiveCaseRuntime,
} from '../acceptance/live-runner';
import {
  createBudgetedProviderFetch,
  type LiveTransportReceipt,
} from '../acceptance/live-transport';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const baseUrl = 'https://offline-runner.invalid/v1';
const dummyKey = 'DUMMY_OFFLINE_RUNNER_KEY_DO_NOT_EXPORT';
const sse = (content: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
const tool = (name: string, args: unknown) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
async function fixture(
  run: (ctx: {
    controller: LiveRunController;
    options: LiveControllerOptions;
    ledger: LiveBudgetLedger;
    identity: LiveRunIdentity;
    receipts: () => readonly LiveTransportReceipt[];
    counts: { opened: number; raw: number; disposed: number; reviews: number };
    current: () => { service: DesktopService; id: string; root: string };
  }) => Promise<void>,
  config: {
    caseId?: string;
    authorize?: boolean;
    providerLimit?: number;
    caseMs?: number;
    change?: (
      options: { -readonly [Key in keyof LiveControllerOptions]: LiveControllerOptions[Key] },
    ) => void;
  } = {},
) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'prospero-runner-unit-')));
  const journalPath = join(temp, 'budget.sqlite');
  const journal = new SqliteLiveBudgetJournal(journalPath, { mode: 'create' });
  const identity = {
    runId: `offline_${randomUUID()}`,
    sourceSha256: hash('current-source'),
    buildSha256: hash('current-build'),
    standardSha256: hash('standard'),
    fixtureSha256: hash('catalog-inputs'),
  };
  const now = Date.now();
  const caseId = config.caseId ?? 'F02';
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_${randomUUID()}`,
    sourceSha256: identity.sourceSha256,
    buildSha256: identity.buildSha256,
    journalSha256: journal.identitySha256,
    caseIds: [caseId],
    createdAt: now,
    expiresAt: now + 60_000,
    limits: {
      provider: 10,
      search: 5,
      page: 5,
      redirects: 3,
      responseBodyBytes: 64 * 1024 * 1024,
      wallClockMs: 60_000,
    },
  });
  const ledger = new LiveBudgetLedger(manifest, {
    humanConfirmed: true,
    executionIdentity: identity,
    journal,
  });
  const counts = { opened: 0, raw: 0, disposed: 0, reviews: 0 };
  let meter: ReturnType<typeof createBudgetedProviderFetch> | undefined;
  let actual: { service: DesktopService; id: string; root: string } | undefined;
  const receipts = () => meter?.receipts() ?? [];
  const options: { -readonly [Key in keyof LiveControllerOptions]: LiveControllerOptions[Key] } = {
    identity,
    ledger,
    caseLimits: {
      ...manifest.limits,
      provider: config.providerLimit ?? 10,
      wallClockMs: config.caseMs ?? 10_000,
    },
    pollMs: 1,
    inspectIdentity: async () => ({ ...identity }),
    inspectGates: async () => LIVE_SAFETY_GATES.map((id) => ({ id, status: 'pass' })),
    reconcile: async () =>
      reconcileLiveBudget({ databasePath: journalPath, manifest, receipts: receipts() }),
    reviewRun:
      config.authorize === false
        ? undefined
        : async (review: LiveRunReview) => ({
            authorizationId: manifest.authorizationId,
            budgetDigest: manifest.digest,
            reviewSha256: hash(JSON.stringify(review)),
            expiresAt: manifest.expiresAt,
            reference: 'OFFLINE_UNIT_REVIEW_ONLY',
          }),
    authorizationCurrent: async () => true,
    reviewPermission: async () => {
      counts.reviews++;
      return 'allow-once';
    },
    openRuntime: async ({ fixture: files, beforeDispatch }): Promise<LiveCaseRuntime> => {
      counts.opened++;
      const store = new ProsperoStore(join(dirname(files.root), 'app.sqlite'));
      let turns = 0;
      let scopeId = '';
      let service!: DesktopService;
      const observations: LiveControlledObservation[] = [];
      const checkpoints: LiveFixtureCheckpoint[] = [];
      meter = createBudgetedProviderFetch({
        ledger,
        caseId: () => caseId,
        baseUrl,
        beforeDispatch,
        fetchImpl: (async () => {
          counts.raw++;
          const turn = turns++;
          if (caseId === 'F02')
            return turn === 0
              ? tool('execute_plan', {
                  title: 'Actual offline copy plan',
                  actions: [
                    {
                      kind: 'copy_file',
                      source: { scopeId, path: 'source.bin' },
                      target: { scopeId, path: 'copy.bin' },
                    },
                  ],
                })
              : sse('The approved binary copy is complete.');
          if (caseId === 'C10') {
            if (turn === 0)
              return tool('execute_plan', {
                title: 'First proposal to deny',
                actions: [
                  {
                    kind: 'copy_file',
                    source: { scopeId, path: 'input.txt' },
                    target: { scopeId, path: 'denied.txt' },
                  },
                ],
              });
            if (turn === 2)
              return tool('execute_plan', {
                title: 'Fresh authorized move',
                actions: [
                  {
                    kind: 'move_file',
                    source: { scopeId, path: 'input.txt' },
                    target: { scopeId, path: 'allowed.txt' },
                  },
                ],
              });
            return sse(
              turn === 1
                ? 'The first proposal was denied; no copy occurred.'
                : 'The separately approved move is complete.',
            );
          }
          return sse('Synthetic model response, no actual research evidence.');
        }) as unknown as typeof fetch,
      });
      service = new DesktopService(
        store,
        {
          put: async (id) => {
            store.saveEncryptedCredential(id, new Uint8Array([1]));
          },
          get: async () => dummyKey,
        },
        { folder: async () => files.root, files: async () => [] },
        () => {},
        '0.2.0',
        undefined,
        undefined,
        undefined,
        30_000,
        meter.fetch,
      );
      const provider = await service.saveProvider({
        displayName: 'Offline controller model',
        baseUrl,
        model: 'offline-model',
        apiKey: dummyKey,
      });
      let conversation = service.createConversation();
      service.selectProvider(conversation.id, provider.id);
      conversation = await service.addScope(conversation.id, 'write');
      scopeId = conversation.scopes?.[0]?.id ?? '';
      actual = { service, id: conversation.id, root: files.root };
      return {
        mode: 'offline-injected',
        service,
        conversationId: conversation.id,
        scopeIds: [scopeId],
        receipts,
        evidence: () => ({ observations, checkpoints }),
        async prepareFollowUp(boundary) {
          if (boundary === 'deny-first-plan') {
            const state = service.getConversation(conversation.id);
            if (state.actionPlans?.[0]?.status !== 'denied')
              throw new Error('No actual denied plan');
            observations.push({
              boundaryId: boundary,
              phaseId: 'initial',
              at: Date.now(),
              planId: state.actionPlans[0].plan.id,
            });
            checkpoints.push(await captureLiveFixtureCheckpoint(files, 'after-denial'));
          }
        },
        async dispose() {
          counts.disposed++;
          await service.shutdown();
          store.close();
        },
      };
    },
  };
  config.change?.(options);
  const controller = new LiveRunController(options);
  try {
    await run({
      controller,
      options,
      ledger,
      identity,
      receipts,
      counts,
      current: () => {
        if (!actual) throw new Error('Runtime has not opened');
        return actual;
      },
    });
  } finally {
    controller.stop();
    try {
      ledger.abort();
    } catch {}
    journal.close();
    await rm(temp, { recursive: true, force: true });
  }
}
async function authorize(controller: LiveRunController) {
  await controller.review(new AbortController().signal);
}

test('default denial precedes fixture/runtime/credential construction and dispatch', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await expect(authorize(controller)).rejects.toThrow('authorization');
      expect(await controller.executeCase('F02')).toMatchObject({
        mode: 'not-started',
        controllerStatus: 'pending',
        pendingReason: 'authorization',
        machine: null,
      });
      expect(counts).toEqual({ opened: 0, raw: 0, disposed: 0, reviews: 0 });
    },
    { authorize: false },
  );
});
test('actual main service plus durable meter and file/hash oracle execute a reviewed offline copy, without counting live success', async () => {
  await fixture(async ({ controller, counts, receipts }) => {
    await authorize(controller);
    const result = await controller.executeCase('F02');
    expect(result).toMatchObject({
      mode: 'offline-injected',
      controllerStatus: 'executed',
      machine: { objective: 'verified', requiresHumanReview: true },
      humanSemanticReviewRequired: true,
      proofBoundary: 'trusted-controller-consistency-only',
    });
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].receiptIds).toHaveLength(2);
    expect(result.phases[0].approvals).toHaveLength(1);
    expect(counts).toEqual({ opened: 1, raw: 2, disposed: 1, reviews: 1 });
    expect(receipts().every((receipt) => receipt.ledgerSettled)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(dummyKey);
    expect(JSON.stringify(result)).not.toContain('approved binary');
    await expect(controller.executeCase('F02')).rejects.toThrow('phase');
  });
});
test('each actual phase has separate metered model evidence; denial requires an observed barrier and fresh approval', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('C10');
      expect(result.controllerStatus).toBe('executed');
      expect(result.machine?.objective).toBe('verified');
      expect(result.phases.map((phase) => phase.phaseId)).toEqual([
        'initial',
        'new-authorized-task',
      ]);
      expect(result.phases.every((phase) => phase.receiptIds.length === 2)).toBe(true);
      expect(result.phases[0].approvals[0].decision).toBe('deny');
      expect(result.phases[1].approvals[0].decision).toBe('allow-once');
      expect(result.phases[0].approvals[0].fingerprint).not.toBe(
        result.phases[1].approvals[0].fingerprint,
      );
      expect(counts.raw).toBe(4);
    },
    {
      caseId: 'C10',
      change: (options) => {
        let reviews = 0;
        options.reviewPermission = async () => (++reviews === 1 ? 'deny' : 'allow-once');
      },
    },
  );
});
test('completed Agent state and two actual offline model calls cannot invent missing Web sources', async () => {
  await fixture(
    async ({ controller }) => {
      await authorize(controller);
      const result = await controller.executeCase('W09');
      expect(result.controllerStatus).toBe('executed');
      expect(result.phases).toHaveLength(2);
      expect(result.machine?.objective).toBe('failed');
      expect(result.mode).toBe('offline-injected');
    },
    { caseId: 'W09' },
  );
});
test('unsupported actual crash barrier stays pending and never sends a recovery followup', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('C07');
      expect(result).toMatchObject({
        controllerStatus: 'pending',
        pendingReason: 'phase',
        machine: null,
      });
      expect(result.phases).toHaveLength(1);
      expect(counts.raw).toBe(1);
    },
    { caseId: 'C07' },
  );
});
test('stale source identity blocks runtime after review, and no transport is entered', async () => {
  let changed = false;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      changed = true;
      expect(await controller.executeCase('F02')).toMatchObject({
        controllerStatus: 'pending',
        pendingReason: 'identity',
      });
      expect(counts.opened).toBe(0);
      expect(counts.raw).toBe(0);
    },
    {
      change: (options) => {
        const original = options.inspectIdentity;
        options.inspectIdentity = async () =>
          changed ? { ...(await original()), sourceSha256: 'c'.repeat(64) } : original();
      },
    },
  );
});
test('pending native readiness is a gate failure before credential or client construction', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await expect(authorize(controller)).rejects.toThrow('gate');
      expect(counts.opened).toBe(0);
    },
    {
      change: (options) => {
        options.inspectGates = async () =>
          LIVE_SAFETY_GATES.map((id) => ({
            id,
            status: id === 'native-readiness' ? 'pending' : 'pass',
          }));
      },
    },
  );
});
test('per-case durable request cap denies second raw entry despite a larger global budget', async () => {
  await fixture(
    async ({ controller, counts, ledger, receipts }) => {
      await authorize(controller);
      expect((await controller.executeCase('F02')).controllerStatus).toBe('pending');
      expect(counts.raw).toBe(1);
      expect(ledger.usage().provider).toBe(2);
      expect(receipts()[1]).toMatchObject({
        transportAttempted: false,
        bytesKnown: true,
        observedBytes: 0,
        ledgerSettled: true,
      });
    },
    { providerLimit: 1 },
  );
});
test('current request changed during trusted review cannot consume approval or perform the copy', async () => {
  let current: (() => { service: DesktopService; id: string; root: string }) | undefined;
  await fixture(
    async (ctx) => {
      current = ctx.current;
      await authorize(ctx.controller);
      const result = await ctx.controller.executeCase('F02');
      expect(result).toMatchObject({ controllerStatus: 'pending', pendingReason: 'snapshot' });
      expect(result.phases).toHaveLength(0);
    },
    {
      change: (options) => {
        options.reviewPermission = async (input) => {
          expect(Object.isFrozen(input.request)).toBe(true);
          expect(Object.isFrozen(input.request.preview.plan?.actions)).toBe(true);
          const runtime = current?.();
          if (!runtime) throw new Error('Not opened');
          runtime.service.decideActionPlan(
            runtime.id,
            input.request.requestId,
            input.request.preview.plan?.digest ?? '',
            'deny',
          );
          return 'allow-once';
        };
      },
    },
  );
});
test('approval callback returning late after deadline never writes and all service operations settle', async () => {
  let release: ((value: 'allow-once') => void) | undefined;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('F02');
      expect(result.controllerStatus).toBe('pending');
      expect(counts.raw).toBe(1);
      expect(counts.disposed).toBe(1);
      release?.('allow-once');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(counts.raw).toBe(1);
    },
    {
      caseMs: 150,
      change: (options) => {
        options.reviewPermission = () =>
          new Promise((resolve) => {
            release = resolve;
          });
      },
    },
  );
});
test('permissions default to deny when there is no trusted review callback', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('F02');
      expect(result.machine?.objective).toBe('failed');
      expect(result.phases[0].approvals[0].decision).toBe('deny');
      expect(counts.reviews).toBe(0);
    },
    {
      change: (options) => {
        options.reviewPermission = undefined;
      },
    },
  );
});

test('late runtime factory is disposed before fixture removal and cannot reopen a closed controller', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const running = controller.executeCase('F02');
      await gate;
      const result = await running;
      expect(result).toMatchObject({
        controllerStatus: 'pending',
        cleanup: 'pending',
        pendingReason: 'runtime',
      });
      expect(counts.opened).toBe(0);
      release?.();
      for (let index = 0; index < 100 && counts.disposed === 0; index++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(counts.disposed).toBe(1);
      expect(counts.raw).toBe(0);
      await expect(controller.executeCase('F02')).rejects.toThrow('phase');
    },
    {
      caseMs: 30,
      change: (options) => {
        const open = options.openRuntime;
        options.cleanupGraceMs = 10;
        options.openRuntime = async (input) => {
          entered?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return open(input);
        };
      },
    },
  );
});

test('uncooperative cleanup is bounded, retains the aborted lease and refuses another case', async () => {
  let release: (() => void) | undefined;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const started = Date.now();
      const result = await controller.executeCase('F02');
      expect(Date.now() - started).toBeLessThan(500);
      expect(result).toMatchObject({
        cleanup: 'pending',
        controllerStatus: 'pending',
        pendingReason: 'runtime',
      });
      expect(counts.disposed).toBe(0);
      await expect(controller.executeCase('F02')).rejects.toThrow('phase');
      release?.();
      for (let index = 0; index < 100 && counts.disposed === 0; index++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(counts.disposed).toBe(1);
    },
    {
      change: (options) => {
        const open = options.openRuntime;
        options.cleanupGraceMs = 20;
        options.openRuntime = async (input) => {
          const runtime = await open(input);
          const stop = runtime.service.stopTask.bind(runtime.service);
          const wrappedService = {
            ...runtime.service,
            sendTask: runtime.service.sendTask.bind(runtime.service),
            getConversation: runtime.service.getConversation.bind(runtime.service),
            decidePermission: runtime.service.decidePermission.bind(runtime.service),
            decideActionPlan: runtime.service.decideActionPlan.bind(runtime.service),
            decideResearch: runtime.service.decideResearch.bind(runtime.service),
            stopTask: async (id: string) => {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              await stop(id);
            },
          };
          return { ...runtime, service: wrappedService };
        };
      },
    },
  );
});

test('stop while dispatch authorization awaits cannot enter the raw transport after late consent', async () => {
  let release: ((value: boolean) => void) | undefined;
  let enter: (() => void) | undefined;
  let inDispatch = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const execution = controller.executeCase('F02');
      await entered;
      controller.stop();
      release?.(true);
      const result = await execution;
      expect(result.controllerStatus).toBe('pending');
      expect(counts.raw).toBe(0);
      expect(counts.disposed).toBe(1);
    },
    {
      change: (options) => {
        const open = options.openRuntime;
        options.authorizationCurrent = async () => {
          if (!inDispatch) return true;
          enter?.();
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        };
        options.openRuntime = (input) =>
          open({
            ...input,
            beforeDispatch: async (boundary, signal) => {
              inDispatch = true;
              try {
                await input.beforeDispatch(boundary, signal);
              } finally {
                inDispatch = false;
              }
            },
          });
      },
    },
  );
});

test('a resolve boundary cannot exceed the case redirect or response-byte cap before DNS', async () => {
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      expect(await controller.executeCase('F02')).toMatchObject({ controllerStatus: 'pending' });
      expect(counts.opened).toBe(0);
      expect(counts.raw).toBe(0);
    },
    {
      change: (options) => {
        options.caseLimits = { ...options.caseLimits, redirects: 0 };
        options.openRuntime = async (input) => {
          const reservation = options.ledger.reserve({
            caseId: 'F02',
            kind: 'provider',
            responseBytes: 1,
          });
          options.ledger.dispatch(reservation);
          options.ledger.complete(reservation, { outcome: 'failed', responseBytes: 0 });
          await input.beforeDispatch(
            { caseId: 'F02', kind: 'page', stage: 'resolve', redirect: true, reservedBytes: 0 },
            input.signal,
          );
          throw new Error('Unexpected zero-budget redirect guard success');
        };
      },
    },
  );
});

test('async service snapshots and permission acknowledgments execute one reviewed plan once', async () => {
  let decisions = 0;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('F02');
      expect(result.controllerStatus).toBe('executed');
      expect(result.machine?.objective).toBe('verified');
      expect(result.phases[0].approvals).toHaveLength(1);
      expect(decisions).toBe(1);
      expect(counts.reviews).toBe(1);
      expect(counts.disposed).toBe(1);
    },
    {
      change(options) {
        const open = options.openRuntime;
        options.openRuntime = async (input) => {
          const runtime = await open(input);
          const actual = runtime.service;
          return {
            ...runtime,
            service: {
              ...actual,
              sendTask: actual.sendTask.bind(actual),
              stopTask: actual.stopTask.bind(actual),
              getConversation: async (id) => {
                await new Promise((resolve) => setTimeout(resolve, 2));
                return actual.getConversation(id);
              },
              decidePermission: actual.decidePermission.bind(actual),
              decideResearch: actual.decideResearch.bind(actual),
              decideActionPlan: async (...args) => {
                decisions++;
                await new Promise((resolve) => setTimeout(resolve, 10));
                await actual.decideActionPlan(...args);
              },
            },
          };
        };
      },
    },
  );
});

test('a changed asynchronous snapshot after review is rejected before permission dispatch', async () => {
  let reads = 0;
  let decisions = 0;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('F02');
      expect(result.controllerStatus).toBe('pending');
      expect(result.pendingReason).toBe('snapshot');
      expect(result.machine).toBeNull();
      expect(decisions).toBe(0);
      expect(counts.raw).toBe(1);
      expect(counts.disposed).toBe(1);
    },
    {
      change(options) {
        const open = options.openRuntime;
        options.openRuntime = async (input) => {
          const runtime = await open(input);
          const actual = runtime.service;
          return {
            ...runtime,
            service: {
              sendTask: actual.sendTask.bind(actual),
              stopTask: actual.stopTask.bind(actual),
              decidePermission: actual.decidePermission.bind(actual),
              decideResearch: actual.decideResearch.bind(actual),
              decideActionPlan: async (...args) => {
                decisions++;
                await actual.decideActionPlan(...args);
              },
              getConversation: async (id) => {
                const value = await actual.getConversation(id);
                if (value.pendingPermission && ++reads >= 2)
                  value.pendingPermission.preview.title += ' changed worker response';
                return value;
              },
            },
          };
        };
      },
    },
  );
});

test('missing worker approval acknowledgment cannot advance the phase after deadline', async () => {
  let decisions = 0;
  await fixture(
    async ({ controller, counts }) => {
      await authorize(controller);
      const result = await controller.executeCase('F02');
      expect(result.controllerStatus).toBe('pending');
      expect(result.pendingReason).toBe('budget');
      expect(result.phases).toHaveLength(0);
      expect(result.cleanup).toBe('settled');
      expect(decisions).toBe(1);
      expect(counts.raw).toBe(1);
      expect(counts.disposed).toBe(1);
    },
    {
      caseMs: 250,
      change(options) {
        const open = options.openRuntime;
        options.openRuntime = async (input) => {
          const runtime = await open(input);
          const actual = runtime.service;
          return {
            ...runtime,
            service: {
              sendTask: actual.sendTask.bind(actual),
              stopTask: actual.stopTask.bind(actual),
              getConversation: async (id) => actual.getConversation(id),
              decidePermission: actual.decidePermission.bind(actual),
              decideResearch: actual.decideResearch.bind(actual),
              decideActionPlan: async () => {
                decisions++;
                await new Promise<void>(() => {});
              },
            },
          };
        };
      },
    },
  );
});
