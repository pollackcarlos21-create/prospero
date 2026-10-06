import { resolveCitation, WebError, type WebClient, type WebSource } from '../../packages/web/src';
import { canonicalPublicUrl } from '../../packages/web/src/network';
import { getLiveCase, type LiveBoundaryId } from './live-cases';
import type { LiveControlledObservation } from './live-fixtures';
import type {
  LiveReportSource,
  LiveSearchRegistration,
  LiveSourceObservation,
} from './live-report';
import type {
  createBudgetedWebClient,
  LiveDispatchGuard,
  LiveTransportReceipt,
} from './live-transport';

type MeteredWebClient = ReturnType<typeof createBudgetedWebClient>;
type WebFault = Extract<
  LiveBoundaryId,
  'empty-search-once' | 'page-failure-once' | 'network-failure-once'
>;
export interface LiveSearchCandidate {
  readonly sourceId: string;
  readonly searchReceiptId: string;
  readonly url: string;
  readonly contentHash: string;
}
export interface LiveWebReturnEvent {
  readonly kind: 'search' | 'page';
  readonly phaseId: string;
  readonly receiptId: string;
  readonly sourceIds: readonly string[];
  readonly discarded: boolean;
}
export interface LiveWebObservationIssue {
  readonly kind: 'search' | 'page';
  readonly reason: 'receipt' | 'source' | 'unbound-source' | 'ambiguous-source';
}
export interface LiveWebObservationSnapshot {
  readonly searches: readonly LiveSearchRegistration[];
  readonly sources: readonly LiveReportSource[];
  readonly sourceObservations: readonly LiveSourceObservation[];
  readonly observations: readonly LiveControlledObservation[];
  readonly issues: readonly LiveWebObservationIssue[];
}
export class LiveWebObserverError extends Error {
  constructor(readonly reason: 'identity' | 'concurrent' | 'receipt' | 'source' | 'selection') {
    super(`Live Web observation stopped: ${reason}.`);
  }
}
export interface LiveWebObserverOptions {
  readonly runId: string;
  readonly caseId: string;
  readonly meter: MeteredWebClient;
  readonly phaseId: () => string;
  /** The same trusted main-owned guard configured on both real request meters. */
  readonly beforeDispatch: LiveDispatchGuard;
  readonly now?: () => number;
  /** Receives only observed metadata, never response bodies, queries or credentials. */
  readonly onControlledBoundary?: (
    observation: Readonly<LiveControlledObservation>,
  ) => void | Promise<void>;
  readonly onReturn?: (event: Readonly<LiveWebReturnEvent>) => void | Promise<void>;
  /** Optional main-owned selection from the actual pending tool call, never model report text.
   * Missing or ambiguous matching facts remain unknown rather than guessed.
   */
  readonly selectSearchSource?: (input: {
    readonly phaseId: string;
    readonly requestedUrl: string;
    readonly candidates: readonly LiveSearchCandidate[];
  }) => Readonly<{ sourceId: string; searchReceiptId: string }> | undefined;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const metadata = (source: WebSource) => ({
  id: source.id,
  url: source.url,
  contentHash: source.contentHash,
});
function sourceTime(source: WebSource): number {
  const value = Date.parse(source.retrievedAt);
  if (
    source.trust !== 'untrusted' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !resolveCitation(source.id, [source])
  )
    throw new LiveWebObserverError('source');
  provenanceUrl(source.url);
  return value;
}
function provenanceUrl(value: string): string {
  const canonical = canonicalPublicUrl(value);
  for (const key of new URL(canonical).searchParams.keys())
    if (/^(?:api[_-]?key|key|token|access[_-]?token|secret|password|authorization)$/i.test(key))
      throw new LiveWebObserverError('source');
  return canonical;
}
function successful(receipt: LiveTransportReceipt, caseId: string, kind: 'search' | 'page') {
  return (
    receipt.caseId === caseId &&
    receipt.kind === kind &&
    receipt.transportAttempted &&
    receipt.outcome === 'completed' &&
    receipt.status === 200 &&
    receipt.bytesKnown &&
    receipt.ledgerSettled &&
    receipt.failure === null
  );
}
function notCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new WebError('cancelled');
}
async function bounded<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new WebError('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    operation.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(new WebError('cancelled'));
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Acceptance-only provenance observer. It neither replaces networking nor proves human consent.
 * Default production DNS/TLS and all actual dispatches stay inside the supplied meter. Controlled
 * failures are catalog-declared runner events; they never masquerade as remote failures.
 */
export function createLiveWebObserver(options: LiveWebObserverOptions): {
  readonly client: WebClient;
  readonly transportMode: MeteredWebClient['transportMode'];
  snapshot(): Readonly<LiveWebObservationSnapshot>;
} {
  const runId = options.runId;
  const caseId = options.caseId;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runId))
    throw new LiveWebObserverError('identity');
  const definition = getLiveCase(caseId);
  const actualSearch = options.meter.client.search.bind(options.meter.client);
  const actualFetchPage = options.meter.client.fetchPage.bind(options.meter.client);
  const receipts = options.meter.receipts.bind(options.meter);
  const transportMode = options.meter.transportMode;
  const phaseId = options.phaseId;
  const guard = options.beforeDispatch;
  const now = options.now ?? Date.now;
  const onControlledBoundary = options.onControlledBoundary;
  const onReturn = options.onReturn;
  const selectSearchSource = options.selectSearchSource;
  const declared = new Set(definition.controlledBoundaries.map((item) => item.id));
  const applied = new Set<WebFault>();
  const searches: LiveSearchRegistration[] = [];
  const sources: LiveReportSource[] = [];
  const sourceObservations: LiveSourceObservation[] = [];
  const observations: LiveControlledObservation[] = [];
  const issues: LiveWebObservationIssue[] = [];
  let active = false;

  const attempts = () =>
    receipts().filter((item) => item.caseId === caseId && item.transportAttempted).length;
  const stamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new LiveWebObserverError('identity');
    return value;
  };
  const phase = () => {
    const value = phaseId();
    if (value !== 'initial' && !definition.followUps.some((item) => item.id === value))
      throw new LiveWebObserverError('identity');
    return value;
  };
  const readyFault = (id: WebFault) => declared.has(id) && !applied.has(id);
  const boundary = async (
    id: WebFault,
    currentPhase: string,
    before: number,
    signal: AbortSignal | undefined,
    sourceId?: string,
  ) => {
    notCancelled(signal);
    const observation = frozen({
      boundaryId: id,
      phaseId: currentPhase,
      at: stamp(),
      ...(sourceId ? { sourceId } : {}),
      requestCountBefore: before,
      requestCountAfter: attempts(),
    });
    applied.add(id);
    observations.push(observation);
    if (onControlledBoundary) {
      const operation = Promise.resolve().then(() => onControlledBoundary(observation));
      if (signal) await bounded(operation, signal);
      else await operation;
    }
    notCancelled(signal);
  };
  const controlledGate = async (kind: 'search' | 'page', signal: AbortSignal | undefined) => {
    notCancelled(signal);
    const localSignal = signal ?? new AbortController().signal;
    await bounded(
      Promise.resolve().then(() =>
        guard(
          frozen({ caseId, kind, stage: 'resolve', redirect: false, reservedBytes: 0 }),
          localSignal,
        ),
      ),
      localSignal,
    );
    notCancelled(signal);
  };
  const operationReceipt = (
    before: ReadonlySet<string>,
    kind: 'search' | 'page',
  ): LiveTransportReceipt => {
    const current = receipts().filter((item) => !before.has(item.reservationId));
    if (
      current.length === 0 ||
      current.some((item) => item.caseId !== caseId || item.kind !== kind) ||
      (kind === 'search' && (current.length !== 1 || current[0].redirect)) ||
      (kind === 'page' && current.some((item, index) => item.redirect !== index > 0)) ||
      current
        .slice(0, -1)
        .some(
          (item) =>
            !item.transportAttempted ||
            item.outcome !== 'completed' ||
            !item.bytesKnown ||
            !item.ledgerSettled ||
            item.failure !== null ||
            ![301, 302, 303, 307, 308].includes(item.status ?? 0),
        ) ||
      !successful(current[current.length - 1], caseId, kind)
    ) {
      issues.push(frozen({ kind, reason: 'receipt' }));
      throw new LiveWebObserverError('receipt');
    }
    return current[current.length - 1];
  };
  const candidatesFor = (url: string): readonly LiveSearchCandidate[] =>
    frozen(
      searches.flatMap((search) =>
        search.sources
          .filter((source) => source.url === url)
          .map((source) => ({
            sourceId: source.id,
            searchReceiptId: search.receiptId,
            url: source.url,
            contentHash: source.contentHash,
          })),
      ),
    );
  const selected = (url: string, currentPhase: string): LiveSearchCandidate | undefined => {
    const candidates = candidatesFor(url);
    if (selectSearchSource) {
      const selection = selectSearchSource(
        frozen({ phaseId: currentPhase, requestedUrl: url, candidates }),
      );
      if (selection) {
        const result = candidates.find(
          (item) =>
            item.sourceId === selection.sourceId &&
            item.searchReceiptId === selection.searchReceiptId,
        );
        if (!result) throw new LiveWebObserverError('selection');
        return result;
      }
      return undefined;
    }
    if (new Set(candidates.map((item) => item.sourceId)).size === 1)
      return candidates[candidates.length - 1];
    return undefined;
  };
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active) throw new LiveWebObserverError('concurrent');
    active = true;
    try {
      return await operation();
    } finally {
      active = false;
    }
  };
  const returned = async (event: LiveWebReturnEvent, signal: AbortSignal | undefined) => {
    if (!onReturn) return;
    const operation = Promise.resolve().then(() => onReturn(frozen(event)));
    if (signal) await bounded(operation, signal);
    else await operation;
  };
  const observed: WebClient = {
    search(query, requestOptions) {
      return serialize(async () => {
        const currentPhase = phase();
        notCancelled(requestOptions?.signal);
        if (readyFault('network-failure-once')) {
          const before = attempts();
          await controlledGate('search', requestOptions?.signal);
          await boundary('network-failure-once', currentPhase, before, requestOptions?.signal);
          throw new WebError('network');
        }
        const before = new Set(receipts().map((item) => item.reservationId));
        const result = await actualSearch(query, requestOptions);
        const receipt = operationReceipt(before, 'search');
        let times: number[];
        try {
          if (result.some((source) => source.kind !== 'search'))
            throw new LiveWebObserverError('source');
          times = result.map(sourceTime);
        } catch (error) {
          issues.push(frozen({ kind: 'search', reason: 'source' }));
          throw error;
        }
        // W06 intentionally does not register discarded search IDs as user-visible authority.
        const discard = readyFault('empty-search-once');
        const presented = discard ? [] : [...result];
        searches.push(
          frozen({ receiptId: receipt.reservationId, sources: presented.map(metadata) }),
        );
        result.forEach((source, index) => {
          sourceObservations.push(
            frozen({
              runId,
              caseId,
              receiptId: receipt.reservationId,
              kind: 'search',
              ...metadata(source),
              requestedUrl: null,
              retrievedAt: times[index],
            }),
          );
        });
        if (discard) {
          const count = attempts();
          await boundary('empty-search-once', currentPhase, count, requestOptions?.signal);
        }
        await returned(
          {
            kind: 'search',
            phaseId: currentPhase,
            receiptId: receipt.reservationId,
            sourceIds: presented.map((source) => source.id),
            discarded: discard,
          },
          requestOptions?.signal,
        );
        return discard ? Object.freeze([]) : result;
      });
    },
    fetchPage(value, requestOptions) {
      return serialize(async () => {
        const currentPhase = phase();
        notCancelled(requestOptions?.signal);
        const requestedUrl = provenanceUrl(value);
        const search = selected(requestedUrl, currentPhase);
        if (search && readyFault('page-failure-once')) {
          const before = attempts();
          await controlledGate('page', requestOptions?.signal);
          await boundary(
            'page-failure-once',
            currentPhase,
            before,
            requestOptions?.signal,
            search.sourceId,
          );
          throw new WebError('http');
        }
        const before = new Set(receipts().map((item) => item.reservationId));
        const source = await actualFetchPage(value, requestOptions);
        const receipt = operationReceipt(before, 'page');
        let retrievedAt: number;
        try {
          if (source.kind !== 'page') throw new LiveWebObserverError('source');
          retrievedAt = sourceTime(source);
        } catch (error) {
          issues.push(frozen({ kind: 'page', reason: 'source' }));
          throw error;
        }
        sourceObservations.push(
          frozen({
            runId,
            caseId,
            receiptId: receipt.reservationId,
            kind: 'page',
            ...metadata(source),
            requestedUrl,
            retrievedAt,
          }),
        );
        if (search) {
          if (!sources.some((item) => item.id === source.id))
            sources.push(
              frozen({
                ...metadata(source),
                retrievedAt,
                searchSourceId: search.sourceId,
                searchReceiptId: search.searchReceiptId,
                fetchReceiptId: receipt.reservationId,
              }),
            );
        } else {
          issues.push(
            frozen({
              kind: 'page',
              reason: candidatesFor(requestedUrl).length ? 'ambiguous-source' : 'unbound-source',
            }),
          );
        }
        await returned(
          {
            kind: 'page',
            phaseId: currentPhase,
            receiptId: receipt.reservationId,
            sourceIds: [source.id],
            discarded: false,
          },
          requestOptions?.signal,
        );
        return source;
      });
    },
  };
  return Object.freeze({
    client: Object.freeze(observed),
    transportMode,
    snapshot: () =>
      frozen({
        searches: searches.map((search) => ({
          ...search,
          sources: search.sources.map((source) => ({ ...source })),
        })),
        sources: sources.map((source) => ({ ...source })),
        sourceObservations: sourceObservations.map((source) => ({ ...source })),
        observations: observations.map((observation) => ({ ...observation })),
        issues: issues.map((issue) => ({ ...issue })),
      }),
  });
}
