import { createHash } from 'node:crypto';
import type { DesktopService } from '../../apps/desktop/src/main/service';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { PermissionRequest } from '../../packages/core/src';
import { livePermissionFingerprint, ReviewedLivePermission } from './live-approval';
import type { LiveBudgetLedger, LiveBudgetLimits } from './live-budget';
import { getLiveCase, LIVE_CATALOG_SHA256, type LiveBoundaryId } from './live-cases';
import {
  createLiveFixture,
  renderLiveCaseTask,
  verifyLiveCaseOutcome,
  type LiveApprovalRecord,
  type LiveCaseFixture,
  type LiveMachineOutcome,
  type LiveOutcomeInput,
} from './live-fixtures';
import type { LiveBudgetReconciliation } from './live-reconcile';
import { LIVE_SAFETY_GATES, type LiveRunIdentity } from './live-report';
import {
  LiveTransportError,
  type LiveDispatchGuard,
  type LiveTransportReceipt,
} from './live-transport';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const sameIdentity = (left: LiveRunIdentity, right: LiveRunIdentity) =>
  ['runId', 'sourceSha256', 'buildSha256', 'standardSha256', 'fixtureSha256'].every(
    (key) => left[key as keyof LiveRunIdentity] === right[key as keyof LiveRunIdentity],
  );
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export class LiveRunnerError extends Error {
  constructor(
    readonly reason:
      | 'authorization'
      | 'identity'
      | 'gate'
      | 'budget'
      | 'phase'
      | 'snapshot'
      | 'runtime',
  ) {
    super(`Live acceptance controller stopped: ${reason}.`);
  }
}
export interface LiveRunReview {
  readonly identity: LiveRunIdentity;
  readonly budgetDigest: string;
  readonly catalogSha256: string;
  readonly caseLimits: Readonly<LiveBudgetLimits>;
  readonly controlledBoundaries: readonly {
    caseId: string;
    boundaryId: LiveBoundaryId;
    disclosure: string;
  }[];
}
/** Trusted workflow input, not a signature or independent proof of human identity. */
export interface LiveRunConsent {
  readonly authorizationId: string;
  readonly budgetDigest: string;
  readonly reviewSha256: string;
  readonly expiresAt: number;
  readonly reference: string;
}
type ServiceMethods = Pick<
  DesktopService,
  | 'sendTask'
  | 'getConversation'
  | 'stopTask'
  | 'decidePermission'
  | 'decideActionPlan'
  | 'decideResearch'
>;
/** Local service and a signal-bound main worker proxy share the same task-layer contract.
 * An async acknowledgment is not proof of a remote effect, human consent or process exit.
 */
export type LiveCaseService = {
  [Key in keyof ServiceMethods]: (
    ...args: Parameters<ServiceMethods[Key]>
  ) => ReturnType<ServiceMethods[Key]> | Promise<Awaited<ReturnType<ServiceMethods[Key]>>>;
};
export interface LiveCaseRuntime {
  readonly mode: 'production-default' | 'offline-injected';
  readonly service: LiveCaseService;
  readonly conversationId: string;
  readonly scopeIds: readonly string[];
  receipts(): readonly LiveTransportReceipt[];
  enterPhase?(phaseId: string): void;
  beforePermissionReview?(
    request: PermissionRequest,
    phaseId: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Main-owned adapters supply actual checkpoints/observations; no model-authored records. */
  evidence(): Omit<LiveOutcomeInput, 'conversation' | 'approvals'>;
  /** Optional actual restart/fault adapter. Absence cannot be filled by fabricated observations. */
  prepareFollowUp?(boundary: LiveBoundaryId, phaseId: string, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
export interface LivePhaseEvidence {
  readonly phaseId: string;
  readonly taskSha256: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly state: Conversation['state'];
  readonly receiptIds: readonly string[];
  readonly approvals: readonly {
    requestId: string;
    fingerprint: string;
    decision: 'allow-once' | 'deny';
  }[];
}
export interface ControlledLiveCaseResult {
  readonly caseId: string;
  readonly mode: 'production-default' | 'offline-injected' | 'not-started';
  readonly controllerStatus: 'executed' | 'pending';
  readonly machine: LiveMachineOutcome | null;
  readonly outputSha256: string | null;
  readonly phases: readonly LivePhaseEvidence[];
  readonly pendingReason: LiveRunnerError['reason'] | null;
  readonly humanSemanticReviewRequired: true;
  readonly cleanup: 'settled' | 'pending';
  readonly proofBoundary: 'trusted-controller-consistency-only';
}
export interface LiveControllerOptions {
  readonly identity: LiveRunIdentity;
  readonly ledger: LiveBudgetLedger;
  readonly caseLimits: Readonly<LiveBudgetLimits>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly pollMs?: number;
  /** A short cleanup grace, never an extension of task execution authority. */
  readonly cleanupGraceMs?: number;
  inspectIdentity(): Promise<LiveRunIdentity>;
  inspectGates(): Promise<
    readonly { id: (typeof LIVE_SAFETY_GATES)[number]; status: 'pass' | 'fail' | 'pending' }[]
  >;
  /** Reads actual durable history plus current metered snapshots. */
  reconcile(): Promise<LiveBudgetReconciliation>;
  reviewRun?(review: Readonly<LiveRunReview>, signal: AbortSignal): Promise<LiveRunConsent | null>;
  authorizationCurrent?(consent: Readonly<LiveRunConsent>): Promise<boolean>;
  reviewPermission?(
    input: Readonly<{
      caseId: string;
      phaseId: string;
      conversationId: string;
      request: PermissionRequest;
      fingerprint: string;
    }>,
    signal: AbortSignal,
  ): Promise<'allow-once' | 'deny'>;
  /** Must use the supplied guard in every provider/Web production meter. Called only after gates. */
  openRuntime(input: {
    fixture: LiveCaseFixture;
    beforeDispatch: LiveDispatchGuard;
    signal: AbortSignal;
  }): Promise<LiveCaseRuntime>;
  /** Transient authorized output for independent human review; controller persists hashes only. */
  reviewOutput?(input: {
    caseId: string;
    text: string;
    machine: LiveMachineOutcome;
  }): Promise<void>;
}
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new LiveRunnerError('budget'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    operation.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(new LiveRunnerError('budget'));
        else resolve(value);
      },
      () => {
        cleanup();
        reject(new LiveRunnerError('runtime'));
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function tick(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new LiveRunnerError('budget'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Test-layer controller, not an Electron launcher or a grant of real service access.
 * A live run additionally needs actual OS-backed credentials, adapters, trusted review
 * and production transports. Technical callbacks cannot establish those facts alone.
 */
export class LiveRunController {
  private readonly options: LiveControllerOptions;
  private readonly identity: LiveRunIdentity;
  private readonly limits: Readonly<LiveBudgetLimits>;
  private readonly now: () => number;
  private consent: Readonly<LiveRunConsent> | null = null;
  private active: { caseId: string; startedAt: number; controller: AbortController } | null = null;
  private readonly attemptedCases = new Set<string>();
  private stopped = false;
  constructor(options: LiveControllerOptions) {
    this.options = { ...options };
    this.identity = freeze(structuredClone(options.identity));
    this.limits = freeze({ ...options.caseLimits });
    this.now = options.now ?? Date.now;
    if (
      options.cleanupGraceMs !== undefined &&
      (!Number.isSafeInteger(options.cleanupGraceMs) ||
        options.cleanupGraceMs < 1 ||
        options.cleanupGraceMs > 5000)
    )
      throw new LiveRunnerError('budget');
    if (
      options.pollMs !== undefined &&
      (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1 || options.pollMs > 1000)
    )
      throw new LiveRunnerError('budget');
    const manifest = options.ledger.manifest;
    if (
      manifest.sourceSha256 !== this.identity.sourceSha256 ||
      manifest.buildSha256 !== this.identity.buildSha256
    )
      throw new LiveRunnerError('identity');
    for (const key of [
      'provider',
      'search',
      'page',
      'redirects',
      'responseBodyBytes',
      'wallClockMs',
    ] as const)
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 0 ||
        this.limits[key] > manifest.limits[key]
      )
        throw new LiveRunnerError('budget');
    if (!this.limits.wallClockMs) throw new LiveRunnerError('budget');
  }
  private async check(signal: AbortSignal) {
    if (this.stopped || signal.aborted || !this.consent || !this.options.authorizationCurrent)
      throw new LiveRunnerError('authorization');
    if (
      this.now() >= this.consent.expiresAt ||
      !(await bounded(this.options.authorizationCurrent(this.consent), signal))
    )
      throw new LiveRunnerError('authorization');
    if (!sameIdentity(this.identity, await bounded(this.options.inspectIdentity(), signal)))
      throw new LiveRunnerError('identity');
    const gates = await bounded(this.options.inspectGates(), signal);
    if (
      gates.length !== LIVE_SAFETY_GATES.length ||
      new Set(gates.map((gate) => gate.id)).size !== gates.length ||
      LIVE_SAFETY_GATES.some(
        (id) => !gates.some((gate) => gate.id === id && gate.status === 'pass'),
      )
    )
      throw new LiveRunnerError('gate');
  }
  async review(signal: AbortSignal): Promise<void> {
    if (this.consent || this.active || this.stopped || !this.options.reviewRun)
      throw new LiveRunnerError('authorization');
    const manifest = this.options.ledger.manifest;
    const review = freeze({
      identity: this.identity,
      budgetDigest: manifest.digest,
      catalogSha256: LIVE_CATALOG_SHA256,
      caseLimits: this.limits,
      controlledBoundaries: manifest.caseIds.flatMap((id) =>
        getLiveCase(id).controlledBoundaries.map((boundary) => ({
          caseId: id,
          boundaryId: boundary.id,
          disclosure: boundary.disclosure,
        })),
      ),
    });
    const consent = await bounded(this.options.reviewRun(review, signal), signal);
    if (
      !consent ||
      consent.authorizationId !== manifest.authorizationId ||
      consent.budgetDigest !== manifest.digest ||
      consent.reviewSha256 !== sha(JSON.stringify(review)) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(consent.reference) ||
      !Number.isSafeInteger(consent.expiresAt) ||
      consent.expiresAt <= this.now() ||
      consent.expiresAt > manifest.expiresAt
    )
      throw new LiveRunnerError('authorization');
    this.consent = freeze({ ...consent });
    try {
      await this.check(signal);
    } catch (error) {
      this.consent = null;
      throw error;
    }
  }
  readonly beforeDispatch: LiveDispatchGuard = async (boundary, signal) => {
    const active = this.active;
    if (!active || boundary.caseId !== active.caseId || active.controller.signal.aborted)
      throw new LiveTransportError('budget');
    const combined = AbortSignal.any([signal, active.controller.signal]);
    try {
      await this.check(combined);
      if (this.now() - active.startedAt >= this.limits.wallClockMs)
        throw new LiveRunnerError('budget');
      const ledger = this.options.ledger;
      const usage = ledger.usage();
      if (
        !usage.durableAcrossProcessRestart ||
        usage.journalCommitFailed ||
        usage.closed ||
        usage.localWriterSuspended
      )
        throw new LiveRunnerError('budget');
      const reconciliation = await bounded(this.options.reconcile(), combined);
      if (
        reconciliation.authorizationId !== ledger.manifest.authorizationId ||
        reconciliation.manifestDigest !== ledger.manifest.digest ||
        reconciliation.journalSha256 !== ledger.manifest.journalSha256
      )
        throw new LiveRunnerError('identity');
      const facts = reconciliation.facts.filter((fact) => fact.caseId === active.caseId);
      const count = facts.filter((fact) => fact.kind === boundary.kind).length;
      // Resolve precedes the new reservation; transport follows its durable reservation.
      if (
        boundary.stage === 'resolve'
          ? count >= this.limits[boundary.kind]
          : count > this.limits[boundary.kind]
      )
        throw new LiveRunnerError('budget');
      const redirects = facts.filter((fact) => fact.redirect).length;
      const caseBytes = facts.reduce((sum, fact) => sum + (fact.chargedBytes ?? fact.capBytes), 0);
      if (
        (boundary.stage === 'resolve' && boundary.redirect
          ? redirects >= this.limits.redirects
          : redirects > this.limits.redirects) ||
        (boundary.stage === 'resolve'
          ? caseBytes >= this.limits.responseBodyBytes
          : caseBytes > this.limits.responseBodyBytes)
      )
        throw new LiveRunnerError('budget');
      if (
        this.active !== active ||
        this.stopped ||
        combined.aborted ||
        this.now() - active.startedAt >= this.limits.wallClockMs
      )
        throw new LiveRunnerError('budget');
    } catch {
      active.controller.abort();
      throw new LiveTransportError('budget');
    }
  };
  private async readConversation(
    runtime: LiveCaseRuntime,
    signal: AbortSignal,
  ): Promise<Conversation> {
    return bounded(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return runtime.service.getConversation(runtime.conversationId);
      }),
      signal,
    );
  }
  private async approve(
    runtime: LiveCaseRuntime,
    caseId: string,
    phaseId: string,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<LiveApprovalRecord> {
    const snapshot = freeze(structuredClone(request));
    const fingerprint = livePermissionFingerprint(snapshot);
    if (runtime.beforePermissionReview) {
      await bounded(runtime.beforePermissionReview(snapshot, phaseId, signal), signal);
      await this.check(signal);
      const pending = (await this.readConversation(runtime, signal)).pendingPermission;
      if (!pending || livePermissionFingerprint(pending) !== fingerprint)
        throw new LiveRunnerError('snapshot');
    }
    let decision: 'allow-once' | 'deny' = 'deny';
    if (['plan', 'research'].includes(snapshot.preview.kind) && this.options.reviewPermission) {
      decision = await bounded(
        this.options.reviewPermission(
          freeze({
            caseId,
            phaseId,
            conversationId: runtime.conversationId,
            request: snapshot,
            fingerprint,
          }),
          signal,
        ),
        signal,
      );
      if (!['allow-once', 'deny'].includes(decision)) throw new LiveRunnerError('snapshot');
      await this.check(signal);
      const current = (await this.readConversation(runtime, signal)).pendingPermission;
      if (!current || livePermissionFingerprint(current) !== fingerprint)
        throw new LiveRunnerError('snapshot');
      if (decision === 'allow-once') {
        const approval = new ReviewedLivePermission(snapshot, {
          boundary: { roots: [this.activeFixtureRoot], scopeIds: runtime.scopeIds },
          humanReviewed: true,
          expiresAt: Math.min(
            this.consent?.expiresAt ?? 0,
            this.active?.startedAt ? this.active.startedAt + this.limits.wallClockMs : 0,
          ),
          now: this.now,
        });
        decision = approval.claim(current);
      }
    }
    // Raw writes, shell, clipboard and native opening never gain authority through this path.
    const current = (await this.readConversation(runtime, signal)).pendingPermission;
    if (!current || livePermissionFingerprint(current) !== fingerprint)
      throw new LiveRunnerError('snapshot');
    signal.throwIfAborted();
    await bounded(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        if (snapshot.preview.plan)
          return runtime.service.decideActionPlan(
            runtime.conversationId,
            snapshot.requestId,
            snapshot.preview.plan.digest,
            decision,
          );
        if (snapshot.preview.research)
          return runtime.service.decideResearch(
            runtime.conversationId,
            snapshot.requestId,
            snapshot.preview.research.digest,
            decision,
          );
        return runtime.service.decidePermission(runtime.conversationId, snapshot.requestId, 'deny');
      }),
      signal,
    );
    await this.check(signal);
    return freeze({ request: snapshot, decision, phaseId });
  }
  private activeFixtureRoot = '';
  async executeCase(caseId: string): Promise<ControlledLiveCaseResult> {
    if (
      this.active ||
      this.attemptedCases.has(caseId) ||
      !this.options.ledger.manifest.caseIds.includes(caseId)
    )
      throw new LiveRunnerError('phase');
    const controller = new AbortController();
    const external = this.options.signal;
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    const start = this.now();
    this.active = { caseId, startedAt: start, controller };
    const timer = setTimeout(abort, Math.min(this.limits.wallClockMs, 2_147_483_647));
    let fixture: LiveCaseFixture | undefined;
    let runtime: LiveCaseRuntime | undefined;
    let runtimePromise: Promise<LiveCaseRuntime> | undefined;
    let cleanupSettled = true;
    const phases: LivePhaseEvidence[] = [];
    const approvals: LiveApprovalRecord[] = [];
    let machine: LiveMachineOutcome | null = null;
    let outputSha256: string | null = null;
    let pendingReason: LiveRunnerError['reason'] | null = null;
    try {
      await this.check(controller.signal);
      this.attemptedCases.add(caseId);
      fixture = await createLiveFixture(caseId);
      this.activeFixtureRoot = fixture.root;
      runtimePromise = this.options.openRuntime({
        fixture,
        beforeDispatch: this.beforeDispatch,
        signal: controller.signal,
      });
      runtime = await bounded(runtimePromise, controller.signal);
      const definition = getLiveCase(caseId);
      let previous: Conversation | undefined;
      for (const phase of [
        { id: 'initial', after: 'previous-complete' as const },
        ...definition.followUps,
      ]) {
        await this.check(controller.signal);
        if (phase.id !== 'initial') {
          if (phase.after === 'previous-complete') {
            if (previous?.state !== 'completed') throw new LiveRunnerError('phase');
          } else {
            if (!definition.controlledBoundaries.some((boundary) => boundary.id === phase.after))
              throw new LiveRunnerError('phase');
            await bounded(
              runtime.prepareFollowUp?.(phase.after, phase.id, controller.signal) ??
                Promise.resolve(),
              controller.signal,
            );
            if (
              !runtime
                .evidence()
                .observations?.some(
                  (observation) =>
                    observation.boundaryId === phase.after &&
                    phases.some(
                      (done) =>
                        done.phaseId === observation.phaseId &&
                        observation.at >= done.startedAt &&
                        observation.at <= this.now(),
                    ),
                )
            )
              throw new LiveRunnerError('phase');
          }
        }
        runtime.enterPhase?.(phase.id);
        const startedAt = this.now();
        const existing = new Set(runtime.receipts().map((receipt) => receipt.reservationId));
        const phaseApprovals: LiveApprovalRecord[] = [];
        const task = renderLiveCaseTask(fixture, phase.id);
        await bounded(runtime.service.sendTask(runtime.conversationId, task), controller.signal);
        let result: Conversation;
        for (;;) {
          await this.check(controller.signal);
          result = await this.readConversation(runtime, controller.signal);
          if (result.pendingPermission) {
            const approval = await this.approve(
              runtime,
              caseId,
              phase.id,
              result.pendingPermission,
              controller.signal,
            );
            approvals.push(approval);
            phaseApprovals.push(approval);
          } else if (['completed', 'failed', 'cancelled', 'interrupted'].includes(result.state))
            break;
          await tick(this.options.pollMs ?? 20, controller.signal);
        }
        const receipts = runtime
          .receipts()
          .filter((receipt) => !existing.has(receipt.reservationId));
        if (
          !receipts.some(
            (receipt) =>
              receipt.caseId === caseId &&
              receipt.kind === 'provider' &&
              receipt.transportAttempted &&
              receipt.status === 200,
          )
        )
          throw new LiveRunnerError('phase');
        phases.push(
          freeze({
            phaseId: phase.id,
            taskSha256: sha(task),
            startedAt,
            finishedAt: this.now(),
            state: result.state,
            receiptIds: receipts.map((receipt) => receipt.reservationId),
            approvals: phaseApprovals.map((approval) => ({
              requestId: approval.request.requestId,
              fingerprint: livePermissionFingerprint(approval.request),
              decision: approval.decision,
            })),
          }),
        );
        previous = result;
      }
      if (!previous) throw new LiveRunnerError('phase');
      machine = await verifyLiveCaseOutcome(fixture, {
        conversation: previous,
        approvals,
        ...runtime.evidence(),
      });
      const text = previous.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content)
        .join('\n');
      outputSha256 = sha(text);
      if (this.options.reviewOutput)
        await bounded(this.options.reviewOutput({ caseId, text, machine }), controller.signal);
      await this.check(controller.signal);
    } catch (error) {
      pendingReason = error instanceof LiveRunnerError ? error.reason : 'runtime';
      controller.abort();
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
      // Keep the actual factory promise observed. A late runtime is stopped and
      // disposed before its fixture may be removed. Unsettled cleanup closes this
      // controller permanently and retains its aborted active lease.
      const cleanup = (async () => {
        if (!runtime && runtimePromise) runtime = await runtimePromise;
        let failed = false;
        if (runtime) {
          try {
            await runtime.service.stopTask(runtime.conversationId);
          } catch {
            failed = true;
          }
          try {
            await runtime.dispose();
          } catch {
            failed = true;
          }
        }
        if (failed) throw new LiveRunnerError('runtime');
        await fixture?.close();
      })();
      let grace: ReturnType<typeof setTimeout> | undefined;
      cleanupSettled = await Promise.race([
        cleanup.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          grace = setTimeout(() => resolve(false), this.options.cleanupGraceMs ?? 5000);
        }),
      ]);
      if (grace) clearTimeout(grace);
      if (cleanupSettled) {
        this.active = null;
        this.activeFixtureRoot = '';
      } else {
        this.stopped = true;
        pendingReason = 'runtime';
        controller.abort();
      }
    }
    return freeze({
      caseId,
      mode: runtime?.mode ?? 'not-started',
      controllerStatus: pendingReason ? 'pending' : 'executed',
      machine,
      outputSha256,
      phases,
      pendingReason,
      humanSemanticReviewRequired: true,
      cleanup: cleanupSettled ? 'settled' : 'pending',
      proofBoundary: 'trusted-controller-consistency-only',
    });
  }
  stop() {
    this.stopped = true;
    this.active?.controller.abort();
  }
}
