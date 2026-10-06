import { createHash } from 'node:crypto';
import {
  DesktopService,
  defaultSettings,
  type CredentialVault,
} from '../../apps/desktop/src/main/service';
import type { Conversation, DesktopEvent, ProviderConfig } from '../../apps/desktop/src/bridge';
import type { ActionJournalPort } from '../../packages/core/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { validateToolArguments } from '../../packages/tools/src';
import type { WebDependencies } from '../../packages/web/src';
import { createLiveActionBoundaries, type LiveActionBoundaries } from './live-action-boundaries';
import type { LiveBudgetLedger } from './live-budget';
import { getLiveCase } from './live-cases';
import {
  assertLiveCredentialProfile,
  type LiveCredentialProfile,
} from './live-credential-selection';
import type {
  LiveCaseFixture,
  LiveControlledObservation,
  LiveNativeTrashReceipt,
  LivePageToolObservation,
} from './live-fixtures';
import type { LiveCaseRuntime } from './live-runner';
import {
  createBudgetedProviderFetch,
  createBudgetedWebClient,
  type LiveDispatchGuard,
} from './live-transport';
import { createLiveWebObserver, type LiveWebObservationSnapshot } from './live-web-observer';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stopped = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
export interface LiveDesktopRuntimeOptions {
  readonly runId: string;
  readonly fixture: LiveCaseFixture;
  readonly ledger: LiveBudgetLedger;
  readonly beforeDispatch: LiveDispatchGuard;
  readonly signal: AbortSignal;
  readonly mode: 'production-default' | 'offline-injected';
  /** Called after controller approval. Must return the opaque, selectively copied profile. */
  createProfile(fixture: LiveCaseFixture, signal: AbortSignal): Promise<LiveCredentialProfile>;
  /** Production caller is an Electron main owner using SecureCredentialVault, never a renderer. */
  createVault(store: ProsperoStore): CredentialVault;
  readonly nativeTrash?: {
    readonly adapter: LiveNativeTrashReceipt['adapter'];
    trash(path: string): Promise<void>;
  };
  /** Explicit offline ports; rejected in production-default mode. */
  readonly fetchImpl?: typeof fetch;
  readonly webDependencies?: Partial<WebDependencies>;
  readonly beforeCrashCommit?: Parameters<
    typeof createLiveActionBoundaries
  >[0]['beforeCrashCommit'];
  /** Authorized transient review only. Summary text is never part of the exported snapshot. */
  reviewSummary?(
    input: { caseId: string; phaseId: string; text: string },
    signal: AbortSignal,
  ): Promise<void>;
}
export interface LiveDesktopRuntime extends LiveCaseRuntime {
  webEvidence(): Readonly<LiveWebObservationSnapshot>;
  summaryEvidence(): readonly { phaseId: string; receiptId: string; summarySha256: string }[];
}
function invalid(): never {
  throw new Error('Live desktop composition is unavailable or inconsistent.');
}
function required<T>(value: T | undefined): T {
  if (value === undefined) invalid();
  return value;
}

/** Acceptance-only composition of actual service/store/tool contracts. No UI or real-service
 * authorization is established by constructing this runtime. Native crypto and Trash bindings
 * must come from a trusted Electron main entry, separately reviewed before any real run.
 */
export async function createLiveDesktopRuntime(
  input: LiveDesktopRuntimeOptions,
): Promise<LiveDesktopRuntime> {
  const options = { ...input, nativeTrash: input.nativeTrash && { ...input.nativeTrash } };
  const { fixture, signal } = options;
  const definition = getLiveCase(fixture.caseId);
  signal.throwIfAborted();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.runId) ||
    !['production-default', 'offline-injected'].includes(options.mode) ||
    (options.mode === 'offline-injected' && typeof options.fetchImpl !== 'function') ||
    !options.ledger.manifest.caseIds.includes(fixture.caseId) ||
    (options.mode === 'production-default' &&
      (options.fetchImpl !== undefined ||
        options.webDependencies !== undefined ||
        options.nativeTrash?.adapter === 'offline-injected')) ||
    (fixture.caseId === 'C07' && !options.beforeCrashCommit) ||
    (['F08', 'C06'].includes(fixture.caseId) && !options.nativeTrash)
  )
    invalid();
  const profile = await options.createProfile(fixture, signal);
  let store: ProsperoStore | undefined;
  let service: DesktopService | undefined;
  let boundaries: LiveActionBoundaries | undefined;
  let phaseId = 'initial';
  let conversationId = '';
  let closed = false;
  let closing: Promise<void> | undefined;
  let providerMeter: ReturnType<typeof createBudgetedProviderFetch>;
  const pageReturns = new Map<string, { callId: string; phaseId: string; receiptId: string }>();
  let stopPromise: Promise<void> | undefined;
  let stopFailed = false;
  let pageStop: LiveControlledObservation | undefined;
  let webMeter: ReturnType<typeof createBudgetedWebClient> | undefined;
  let observer: ReturnType<typeof createLiveWebObserver> | undefined;
  let webKeySha256: string | undefined;
  const observations: LiveControlledObservation[] = [];
  const pageToolResults: LivePageToolObservation[] = [];
  const summaryMetadata: { phaseId: string; receiptId: string; summarySha256: string }[] = [];
  let summaryCandidate:
    | { phaseId: string; receiptId: string; requestCountBefore: number }
    | undefined;
  let wrapJournal: ((delegate: ActionJournalPort) => ActionJournalPort) | undefined;
  class BoundaryStore extends ProsperoStore {
    override actionJournal(id: string, executionId: string): ActionJournalPort {
      const journal = super.actionJournal(id, executionId);
      return wrapJournal ? wrapJournal(journal) : journal;
    }
  }
  const assertOpen = () => {
    if (closed || !service || !store) invalid();
  };
  const attempts = () =>
    [...providerMeter.receipts(), ...(webMeter?.receipts() ?? [])].filter(
      (receipt) => receipt.transportAttempted,
    ).length;
  const observeRequest: NonNullable<
    Parameters<typeof createBudgetedProviderFetch>[0]['observeRequest']
  > = async (event, currentSignal) => {
    if (fixture.caseId !== 'C02') return;
    if (event.summaryRequest) {
      summaryCandidate = {
        phaseId,
        receiptId: event.reservationId,
        requestCountBefore: attempts(),
      };
    } else if (summaryCandidate?.phaseId === phaseId && event.continuitySummary) {
      const prior = providerMeter
        .receipts()
        .find((receipt) => receipt.reservationId === summaryCandidate?.receiptId);
      if (
        prior?.status === 200 &&
        prior.transportAttempted &&
        prior.ledgerSettled &&
        ['completed', 'cancelled'].includes(prior.outcome)
      ) {
        const text = event.continuitySummary;
        if (options.reviewSummary)
          await options.reviewSummary({ caseId: fixture.caseId, phaseId, text }, currentSignal);
        currentSignal.throwIfAborted();
        summaryMetadata.push(
          Object.freeze({ phaseId, receiptId: prior.reservationId, summarySha256: sha(text) }),
        );
        observations.push(
          Object.freeze({
            boundaryId: 'summary-observed',
            phaseId,
            at: Date.now(),
            requestCountBefore: summaryCandidate.requestCountBefore,
            requestCountAfter: attempts(),
          }),
        );
        summaryCandidate = undefined;
      }
    }
  };
  const abortRuntime = () => {
    if (closed || !service || !conversationId) return;
    stopPromise = service.stopTask(conversationId);
    void stopPromise.catch(() => {
      stopFailed = true;
    });
  };
  const emit = (event: DesktopEvent) => {
    if (
      closed ||
      event.type !== 'conversation' ||
      event.conversation.id !== conversationId ||
      !observer ||
      !store ||
      !service
    )
      return;
    const conversation = event.conversation;
    const saved = store.getConversation<Conversation>(conversationId);
    const durableSources = store.sources(conversationId);
    for (const page of observer
      .snapshot()
      .sourceObservations.filter((entry) => entry.kind === 'page')) {
      const returned = pageReturns.get(page.id);
      if (!returned || returned.phaseId !== phaseId || returned.receiptId !== page.receiptId)
        continue;
      const tool = conversation.timeline.find(
        (item) =>
          item.call?.id === returned.callId &&
          item.call.name === 'fetch_source' &&
          item.result &&
          !item.result.isError,
      );
      const durableTool = saved?.timeline.find(
        (item) => item.id === tool?.id && item.call?.id === tool?.call?.id,
      );
      const source = conversation.sources?.find((entry) => entry.id === page.id);
      const durableSource = durableSources.find((entry) => entry.id === page.id);
      if (
        !tool?.call ||
        !durableTool?.result ||
        durableTool.result.isError ||
        !source ||
        !durableSource ||
        [source, durableSource].some(
          (entry) =>
            entry.kind !== 'page' ||
            entry.url !== page.url ||
            entry.contentHash !== page.contentHash ||
            entry.retrievedAt !== page.retrievedAt,
        )
      )
        continue;
      if (
        !pageToolResults.some(
          (entry) => entry.toolCallId === returned.callId && entry.sourceId === page.id,
        )
      ) {
        pageToolResults.push(
          Object.freeze({
            phaseId,
            toolCallId: returned.callId,
            sourceId: page.id,
            url: page.url,
            contentHash: page.contentHash,
            retrievedAt: page.retrievedAt,
            at: Date.now(),
            fetchReceiptId: returned.receiptId,
          }),
        );
      }
      if (fixture.caseId === 'C04' && !pageStop) {
        pageStop = Object.freeze({
          boundaryId: 'request-stop-after-page',
          phaseId,
          at: Date.now(),
          sourceId: page.id,
          requestCountBefore: attempts(),
        });
        // The successful tool result and independent SQLite metadata exist before actual abort.
        stopPromise = service.stopTask(conversationId);
        void stopPromise.catch(() => {
          stopFailed = true;
        });
      }
    }
  };
  const compose = () => {
    if (!store) invalid();
    const currentStore = store;
    return new DesktopService(
      currentStore,
      options.createVault(currentStore),
      { folder: async () => scopeQueue.shift(), files: async () => [] },
      emit,
      '0.2.0',
      undefined,
      {
        appearance: () => ({ dark: false, reducedMotion: false }),
        ready() {},
        contextMenu() {},
        copy() {
          invalid();
        },
        reveal() {
          invalid();
        },
        taskFinished() {},
        trash: (path) =>
          boundaries
            ? boundaries.trash(path)
            : Promise.reject(new Error('Native action unavailable.')),
        openSource: async () => {
          invalid();
        },
      },
      (key) => {
        if (!webMeter) {
          webKeySha256 = sha(key);
          webMeter = createBudgetedWebClient({
            ledger: options.ledger,
            caseId: () => fixture.caseId,
            apiKey: key,
            dependencies: options.webDependencies,
            beforeDispatch: options.beforeDispatch,
          });
          observer = createLiveWebObserver({
            runId: options.runId,
            caseId: fixture.caseId,
            meter: webMeter,
            phaseId: () => phaseId,
            beforeDispatch: options.beforeDispatch,
            onReturn: (event) => {
              if (event.kind !== 'page' || !service) return;
              const call = service
                .getConversation(conversationId)
                .timeline.findLast(
                  (item) => item.call?.name === 'fetch_source' && !item.result,
                )?.call;
              if (!call) invalid();
              for (const sourceId of event.sourceIds)
                pageReturns.set(sourceId, {
                  callId: call.id,
                  phaseId: event.phaseId,
                  receiptId: event.receiptId,
                });
            },
            selectSearchSource: ({ requestedUrl, candidates }) => {
              if (!service) return undefined;
              const pending = service
                .getConversation(conversationId)
                .timeline.findLast((item) => item.call?.name === 'fetch_source' && !item.result);
              if (
                !pending?.call ||
                pending.preview?.kind !== 'web' ||
                pending.preview.url !== requestedUrl
              )
                return undefined;
              const args = validateToolArguments('fetch_source', pending.call.arguments);
              const candidate = candidates.findLast((item) => item.sourceId === args.sourceId);
              return (
                candidate && {
                  sourceId: candidate.sourceId,
                  searchReceiptId: candidate.searchReceiptId,
                }
              );
            },
          });
        } else if (webKeySha256 !== sha(key)) invalid();
        if (!observer) invalid();
        return observer.client;
      },
      30_000,
      providerMeter.fetch,
    );
  };
  const scopeQueue = definition.scopes.map((name) => fixture.roots[name]);
  try {
    await assertLiveCredentialProfile(profile);
    signal.throwIfAborted();
    providerMeter = createBudgetedProviderFetch({
      ledger: options.ledger,
      caseId: () => fixture.caseId,
      baseUrl: profile.descriptor.baseUrl,
      fetchImpl: options.fetchImpl,
      beforeDispatch: options.beforeDispatch,
      observeRequest: fixture.caseId === 'C02' ? observeRequest : undefined,
    });
    if (definition.minimumPages > 0 && !profile.descriptor.hasBrave) invalid();
    if (
      options.mode === 'offline-injected' &&
      profile.descriptor.hasBrave &&
      (typeof options.webDependencies?.resolve !== 'function' ||
        typeof options.webDependencies?.transport !== 'function')
    )
      invalid();
    store = new BoundaryStore(profile.databasePath);
    const selected = store.providers<ProviderConfig>();
    if (
      selected.length !== 1 ||
      selected[0].id !== profile.descriptor.providerId ||
      selected[0].baseUrl !== profile.descriptor.baseUrl ||
      selected[0].model !== profile.descriptor.model
    )
      invalid();
    store.setSetting('ui', {
      ...defaultSettings,
      defaultProviderId: profile.descriptor.providerId,
    });
    store.setSetting('web-search', { enabled: profile.descriptor.hasBrave, retention: 'sources' });
    service = compose();
    conversationId = service.createConversation().id;
    service.selectProvider(conversationId, profile.descriptor.providerId);
    const mode =
      fixture.caseId.startsWith('W') || fixture.caseId === 'F05' || fixture.caseId === 'C04'
        ? 'read'
        : 'write';
    for (const _scope of definition.scopes) await service.addScope(conversationId, mode);
    const scopeIds = Object.freeze(
      service.getConversation(conversationId).scopes?.map((scope) => scope.id) ?? [],
    );
    if (scopeQueue.length || scopeIds.length !== definition.scopes.length) invalid();
    boundaries = await createLiveActionBoundaries({
      fixture,
      store: () => {
        if (!store) invalid();
        return store;
      },
      conversationId,
      databasePath: profile.databasePath,
      phaseId: () => phaseId,
      getConversation: () => {
        assertOpen();
        return required(service).getConversation(conversationId);
      },
      stopTask: () => {
        assertOpen();
        return required(service).stopTask(conversationId);
      },
      nativeTrash: options.nativeTrash,
      beforeCrashCommit: options.beforeCrashCommit,
    });
    wrapJournal = (delegate) => required(boundaries).wrapJournal(delegate);
    signal.addEventListener('abort', abortRuntime, { once: true });
    if (signal.aborted) {
      abortRuntime();
      signal.throwIfAborted();
    }
    const facade: LiveCaseRuntime['service'] = {
      sendTask: (id, text) => {
        assertOpen();
        return required(service).sendTask(id, text);
      },
      getConversation: (id) => {
        assertOpen();
        return required(service).getConversation(id);
      },
      stopTask: (id) => {
        assertOpen();
        return required(service).stopTask(id);
      },
      decidePermission: (...args) => {
        assertOpen();
        return required(service).decidePermission(...args);
      },
      decideActionPlan: (...args) => {
        assertOpen();
        return required(service).decideActionPlan(...args);
      },
      decideResearch: (...args) => {
        assertOpen();
        return required(service).decideResearch(...args);
      },
    };
    return Object.freeze({
      mode: options.mode,
      service: Object.freeze(facade),
      conversationId,
      scopeIds,
      receipts: () => Object.freeze([...providerMeter.receipts(), ...(webMeter?.receipts() ?? [])]),
      enterPhase(next: string) {
        assertOpen();
        if (!['initial', ...definition.followUps.map((entry) => entry.id)].includes(next))
          invalid();
        phaseId = next;
        summaryCandidate = undefined;
      },
      beforePermissionReview: (request, id, currentSignal) =>
        required(boundaries).beforePermissionReview(request, id, currentSignal),
      async prepareFollowUp(boundary, next, currentSignal) {
        assertOpen();
        currentSignal.throwIfAborted();
        if (!definition.followUps.some((entry) => entry.id === next && entry.after === boundary))
          invalid();
        if (boundary !== 'service-restart')
          await required(boundaries).prepareFollowUp(boundary, next, currentSignal);
        if (boundary === 'service-restart' || boundary === 'sqlite-before-running') {
          if (!stopped.has(required(service).getConversation(conversationId).state)) invalid();
          await required(service).shutdown();
          required(store).close();
          store = undefined;
          await assertLiveCredentialProfile(profile);
          currentSignal.throwIfAborted();
          store = new BoundaryStore(profile.databasePath);
          service = compose();
          if (service.getConversation(conversationId).pendingPermission) invalid();
          if (boundary === 'service-restart')
            observations.push(Object.freeze({ boundaryId: boundary, phaseId, at: Date.now() }));
        }
      },
      evidence() {
        assertOpen();
        if (stopFailed || observer?.snapshot().issues.length) invalid();
        const observed = required(boundaries).evidence();
        return Object.freeze({
          ...observed,
          pageToolResults: Object.freeze([...pageToolResults]),
          observations: Object.freeze([
            ...(observed.observations ?? []),
            ...observations,
            ...(observer?.snapshot().observations ?? []),
            ...(pageStop ? [{ ...pageStop, requestCountAfter: attempts() }] : []),
          ]),
        });
      },
      webEvidence() {
        return (
          observer?.snapshot() ??
          Object.freeze({
            searches: [],
            sources: [],
            sourceObservations: [],
            observations: [],
            issues: [],
          })
        );
      },
      summaryEvidence: () => Object.freeze([...summaryMetadata]),
      async dispose() {
        if (closing) return closing;
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', abortRuntime);
        closing = (async () => {
          await service?.shutdown();
          if (stopPromise) await stopPromise;
          await boundaries?.dispose();
          store?.close();
          store = undefined;
          await profile.close();
        })();
        return closing;
      },
    } satisfies LiveDesktopRuntime);
  } catch {
    signal.removeEventListener('abort', abortRuntime);
    await service?.shutdown();
    await boundaries?.dispose();
    store?.close();
    await profile.close();
    invalid();
  }
}
