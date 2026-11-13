import { randomUUID } from 'node:crypto';
import { DotRepositoryError, type DotRepository, type DotIntent } from '@prospero/persistence';
import type {
  DotControl,
  DotPage,
  DotView,
  DotsBridge,
  ProviderConfig,
  DotPolicyTerms,
  DotReviewInput,
  DotApprovalView,
  DotSupervisionSnapshot,
} from '../bridge';
import type { ExecutionAdmission } from './execution-admission';
import type { DotExecutionService, DotRuntimeEvent } from './dot-execution';
import { UserError } from './validation';
import { canonicalPublicUrl } from '@prospero/web';
import type { DotIntentReview } from '@prospero/dots';
import type { DotContextQuery } from '@prospero/dots';
import { readDotContext } from './dot-context';
import { readDotRecord } from './dot-record';

export interface DotSchedulerClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const systemClock: DotSchedulerClock = {
  now: Date.now,
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

function requestView(intent: DotIntent, review?: DotIntentReview): DotApprovalView {
  return {
    id: intent.id,
    runId: intent.runId,
    revision: intent.revision,
    digest: intent.digest,
    status: intent.status,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    preview: intent.request.preview,
    receipt: intent.receipt,
    dispatchedAt: intent.dispatchedAt,
    review,
  };
}
/** Main-owned application facade. No SQL, credentials or arbitrary tool dispatch crosses IPC. */
export class DotApplication implements DotsBridge {
  private sequence = new Map<string, number>();
  private signatures = new Map<string, string>();
  private supervisionSequence = 0;
  private attention = new Map<string, DotView['attention']>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private pumpTimer?: () => void;
  private wakeTimer?: () => void;
  private schedulerFault = false;
  private controlling = 0;
  private unsubscribe?: () => void;
  private attempted = new Set<string>();
  private assertOpen() {
    if (this.closed) throw new UserError('The application is shutting down.');
  }
  constructor(
    private repository: DotRepository,
    private runner: DotExecutionService,
    private providers: () => ProviderConfig[],
    private emit: (snapshot: DotView) => void,
    private failed: (id: string) => void = () => {},
    private openExternal: (url: string) => void | Promise<void> = () => {
      throw new UserError('Opening sources is unavailable.');
    },
    private admission?: ExecutionAdmission,
    private clock: DotSchedulerClock = systemClock,
    private changed: () => void = () => {},
  ) {
    this.unsubscribe = admission?.subscribeFree(() => this.schedulePump());
    this.schedulePump();
  }
  refreshScheduler() {
    if (!this.closed) this.schedulePump();
  }
  private schedulePump() {
    if (this.closed || !this.admission || this.pumpTimer || this.schedulerFault || this.controlling)
      return;
    this.pumpTimer = this.clock.schedule(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, 0);
  }
  private armWake() {
    this.wakeTimer?.();
    this.wakeTimer = undefined;
    if (this.closed || !this.admission || this.schedulerFault || this.controlling) return;
    const next = this.repository.nextWakeAt();
    if (next === undefined || (next <= this.clock.now() && this.admission.owner)) return;
    this.wakeTimer = this.clock.schedule(
      () => {
        this.wakeTimer = undefined;
        this.schedulePump();
      },
      Math.min(30_000, Math.max(0, next - this.clock.now())),
    );
  }
  private pump() {
    if (this.closed || !this.admission || this.schedulerFault || this.controlling) return;
    let inspecting: string | undefined;
    try {
      if (this.admission.owner) {
        return;
      }
      for (const id of this.repository.policyCandidates(this.clock.now())) {
        if (this.attempted.has(id)) continue;
        const intent = this.repository.approveByPolicy(id, this.clock.now());
        if (!intent) continue;
        const dot = this.repository.get(intent.dotId);
        if (!dot) continue;
        inspecting = dot.id;
        this.attempted.add(id);
        try {
          this.runner.resumeApproved(dot.id, dot.revision, intent.id);
        } catch {
          this.attention.set(dot.id, 'initialization');
        }
        this.publish(dot.id);
        return;
      }
      for (const wake of this.repository.dueWakes(this.clock.now())) {
        inspecting = wake.dotId;
        const result = this.runner.runWake(wake.id, wake.revision);
        this.publish(wake.dotId);
        if (result.pair) break;
      }
    } catch {
      this.schedulerFault = true;
      if (inspecting) {
        this.attention.set(inspecting, 'persistence');
        this.publish(inspecting);
      }
    } finally {
      try {
        this.armWake();
      } catch {
        this.schedulerFault = true;
      }
    }
  }
  private async control<T>(body: () => Promise<T>): Promise<T> {
    this.controlling++;
    try {
      return await body();
    } finally {
      this.controlling--;
      this.schedulePump();
    }
  }
  private view(id: string): DotView {
    const snapshot = this.repository.snapshot(id);
    return {
      dot: snapshot.dot,
      checkpoint: snapshot.checkpoint,
      runs: snapshot.runs,
      runCount: snapshot.runCount,
      policy: snapshot.policy,
      wakes: snapshot.wakes,
      approvals: snapshot.intents.map((intent) =>
        requestView(
          intent,
          snapshot.intentReviews.find((review) => review.intentId === intent.id),
        ),
      ),
      sequence: this.sequence.get(id) ?? 0,
      live: this.runner.live(id),
      attention: this.attention.get(id),
    };
  }
  private publish(id: string) {
    if (this.closed) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.sequence.set(id, (this.sequence.get(id) ?? 0) + 1);
    try {
      const view = this.view(id);
      const signature = JSON.stringify({
        lifecycle: view.dot.lifecycle,
        run: view.dot.inFlightRunId,
        live: !!view.live,
        attention: view.attention,
        requests: view.approvals?.map((item) => [item.id, item.revision, !!item.review]),
        policy: view.policy?.policy.status,
      });
      if (this.signatures.get(id) !== signature) {
        this.signatures.set(id, signature);
        this.changed();
      }
      this.emit(view);
    } catch {
      this.failed(id);
    }
  }
  notify(event: DotRuntimeEvent) {
    if (this.closed) return;
    if (event.type === 'settled') this.schedulePump();
    if (event.type === 'attention') this.attention.set(event.dotId, event.reason);
    if (event.type === 'agent' && event.event.type === 'text') {
      if (!this.timers.has(event.dotId))
        this.timers.set(
          event.dotId,
          setTimeout(() => this.publish(event.dotId), 32),
        );
    } else this.publish(event.dotId);
  }
  async supervision(): Promise<DotSupervisionSnapshot> {
    const items: DotSupervisionSnapshot['items'][number][] = [];
    let cursor: string | undefined;
    let more = false;
    let recheckAt: number | undefined;
    const at = this.clock.now();
    do {
      const page = this.repository.supervisionPage(cursor, 50);
      for (const entry of page.items) {
        if (this.runner.isRunning(entry.dotId)) continue;
        if (
          entry.kind === 'approval' &&
          !this.attempted.has(entry.intentId) &&
          this.repository.canApproveByPolicy(entry.intentId, at)
        ) {
          const intent = this.repository.intent(entry.intentId);
          const policy = this.repository.runPolicy(entry.runId)?.policy;
          let matches = false;
          if (intent && policy) {
            try {
              const current = this.runner.researchBinding(entry.dotId, intent.provider.id);
              matches =
                current.configurationRevision === intent.policyRevision &&
                current.provider.id === intent.provider.id &&
                current.provider.baseUrl === intent.provider.baseUrl &&
                current.provider.model === intent.provider.model;
            } catch (error) {
              if (!(error instanceof UserError)) throw error;
            }
          }
          if (matches && intent && policy) {
            recheckAt = Math.min(recheckAt ?? Infinity, intent.expiresAt, policy.expiresAt);
            continue;
          }
        }
        if (items.length === 50) {
          more = true;
          break;
        }
        items.push({
          dotId: entry.dotId,
          runId: entry.runId,
          intentId: entry.intentId,
          intentRevision: entry.intentRevision,
          intentDigest: entry.intentDigest,
          kind: entry.kind,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });
      }
      if (more) break;
      cursor = page.nextCursor;
    } while (cursor);
    return { sequence: ++this.supervisionSequence, items, more, recheckAt };
  }
  async list(options: DotPage & { includeArchived?: boolean } = {}) {
    return this.repository.list(options);
  }
  async get(id: string) {
    return this.view(id);
  }
  async create(input: { name: string; goal: string }) {
    this.assertOpen();
    const dot = this.repository.create({
      id: randomUUID(),
      name: input.name,
      goal: { text: input.goal },
      createdAt: this.clock.now(),
    });
    this.publish(dot.id);
    return this.view(dot.id);
  }
  async run(id: string, expectedRevision: number, providerId: string) {
    this.assertOpen();
    const provider = this.providers().find((entry) => entry.id === providerId);
    if (!provider || provider.supportsTools === false)
      throw new UserError('Choose a model with tool calling for this Dot.');
    this.attention.delete(id);
    this.runner.runNow(id, expectedRevision, providerId);
    this.publish(id);
    return this.view(id);
  }
  async stop(id: string) {
    return this.control(async () => {
      this.assertOpen();
      this.repository.cancelDotWakes(id, this.clock.now());
      await this.runner.stop(id);
      this.assertOpen();
      this.repository.cancelDotWakes(id, this.clock.now());
      this.publish(id);
      return this.view(id);
    });
  }
  async authorizeResearch(id: string, revision: number, providerId: string, input: DotPolicyTerms) {
    this.assertOpen();
    const binding = this.runner.researchBinding(id, providerId);
    this.repository.createPolicy(
      { ...input, ...binding, id: randomUUID(), dotId: id, createdAt: this.clock.now() },
      revision,
    );
    this.publish(id);
    return this.view(id);
  }
  async revokeResearch(id: string, policyId: string, revision: number) {
    return this.control(async () => {
      this.assertOpen();
      this.repository.revokePolicy(id, policyId, revision, this.clock.now());
      this.publish(id);
      await this.runner.stop(id);
      this.assertOpen();
      this.publish(id);
      return this.view(id);
    });
  }
  async scheduleWake(id: string, revision: number, policyId: string, dueAt: number) {
    this.assertOpen();
    const policy = this.repository.currentPolicy(id)?.policy;
    if (!policy || policy.id !== policyId) throw new DotRepositoryError('not-found');
    const binding = this.runner.researchBinding(id, policy.provider.id);
    this.repository.scheduleWake(
      { id: randomUUID(), dotId: id, policyId, createdAt: this.clock.now(), dueAt },
      revision,
      binding.provider,
      binding.configurationRevision,
    );
    this.publish(id);
    this.schedulePump();
    return this.view(id);
  }
  async cancelWake(id: string, wakeId: string, revision: number) {
    this.assertOpen();
    this.repository.cancelWake(id, wakeId, revision, this.clock.now());
    this.publish(id);
    this.schedulePump();
    return this.view(id);
  }
  async decide(
    id: string,
    revision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    decision: 'approve' | 'deny',
  ) {
    this.assertOpen();
    if (decision !== 'approve' && decision !== 'deny')
      throw new UserError('Invalid Dot approval decision.');
    const dot = this.repository.get(id);
    const intent = this.repository.intent(intentId);
    if (!dot || !intent || intent.dotId !== id || intent.runId !== dot.inFlightRunId)
      throw new DotRepositoryError('not-found');
    if (dot.revision !== revision) throw new DotRepositoryError('conflict');
    if (this.runner.isRunning(id))
      throw new UserError('Wait for this Dot to finish preparing its request.');
    this.attention.delete(id);
    try {
      if (decision === 'deny')
        this.repository.denySuspendedRun(
          id,
          revision,
          intentId,
          intentRevision,
          digest,
          Math.max(this.clock.now(), intent.updatedAt),
        );
      else {
        this.repository.decideIntent(
          intentId,
          intentRevision,
          digest,
          'approve',
          Math.max(this.clock.now(), intent.updatedAt),
        );
        this.publish(id);
        this.runner.resumeApproved(id, revision, intentId);
      }
    } finally {
      this.publish(id);
    }
    return this.view(id);
  }
  async resumeApproval(id: string, revision: number, intentId: string) {
    this.assertOpen();
    this.attention.delete(id);
    try {
      this.runner.resumeApproved(id, revision, intentId);
    } finally {
      this.publish(id);
    }
    return this.view(id);
  }
  async openSource(id: string, intentId: string, sourceId: string) {
    this.assertOpen();
    const intent = this.repository.intent(intentId);
    if (!intent || intent.dotId !== id || intent.status !== 'succeeded')
      throw new DotRepositoryError('not-found');
    const source = intent.receipt?.sources?.find((source) => source.id === sourceId);
    if (!source) throw new DotRepositoryError('not-found');
    await this.openExternal(canonicalPublicUrl(source.url));
  }
  async transition(id: string, expectedRevision: number, command: DotControl) {
    return this.control(async () => {
      this.assertOpen();
      const before = this.repository.get(id);
      if (!before) throw new DotRepositoryError('not-found');
      if (before.revision !== expectedRevision) throw new DotRepositoryError('conflict');
      if (before.inFlightRunId) {
        const pending = this.repository.currentIntent(before.inFlightRunId);
        if (
          !this.runner.isRunning(id) &&
          (!pending || !['pending', 'approved'].includes(pending.status))
        )
          throw new UserError(
            'This Run needs inspection after an interrupted save. Reopen the app before continuing.',
          );
        if (command === 'resume') throw new UserError('This Dot is already active.');
        await this.runner.stop(id);
        this.assertOpen();
        expectedRevision++;
      }
      const current = this.repository.get(id);
      if (!current) throw new DotRepositoryError('not-found');
      this.repository.transition(
        id,
        expectedRevision,
        command,
        Math.max(this.clock.now(), current.updatedAt),
      );
      this.publish(id);
      return this.view(id);
    });
  }
  async requests(id: string, options: DotPage = {}) {
    const history = this.repository.requestHistory(id, options);
    return {
      requests: history.entries.map((entry) => requestView(entry.intent, entry.review)),
      total: history.total,
      offset: history.offset,
      limit: history.limit,
    };
  }
  async reviewUnknown(
    id: string,
    dotRevision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    input: DotReviewInput,
  ) {
    this.assertOpen();
    if (input?.acknowledge !== true)
      throw new UserError('Confirm that the request may already have happened.');
    if (
      this.runner.isRunning(id) ||
      (this.admission?.owner?.kind === 'dot' && this.admission.owner.id === id)
    )
      throw new UserError('Wait for this Dot to finish settling before reviewing its outcome.');
    const dot = this.repository.get(id);
    const intent = this.repository.intent(intentId);
    if (!dot || !intent || intent.dotId !== id) throw new DotRepositoryError('not-found');
    this.repository.acknowledgeUnknown(
      id,
      dotRevision,
      intentId,
      intentRevision,
      digest,
      input.note,
      Math.max(this.clock.now(), dot.updatedAt, intent.updatedAt),
    );
    this.attention.delete(id);
    this.publish(id);
    return this.view(id);
  }
  async history(id: string, options: DotPage = {}) {
    return this.repository.runs(id, options);
  }
  async checkpoints(id: string, options: DotPage = {}) {
    return this.repository.checkpoints(id, options);
  }
  async context(id: string, query: DotContextQuery = {}) {
    return readDotContext(this.repository, id, query);
  }
  async record(id: string, query: import('@prospero/dots').DotRecordQuery) {
    return readDotRecord(this.repository, id, query);
  }
  dispose() {
    this.closed = true;
    this.pumpTimer?.();
    this.wakeTimer?.();
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
