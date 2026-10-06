import type { SourceRecord } from '@prospero/core';
import type { ActionPlanRecord, ResearchPlanRecord, TimelineItem } from '../bridge';

const LIMIT = 20;
export const RECOVERY_CONTEXT_BYTES = 24 * 1024;
const actionNames: Record<string, string> = {
  copy_file: 'Copy file',
  move_file: 'Move file',
  rename_file: 'Rename file',
  create_directory: 'Create folder',
  write_text: 'Write text',
  trash_file: 'Move file to Trash',
  reveal_in_finder: 'Reveal in Finder',
  copy_path: 'Copy path',
};

function actionFacts(record: ActionPlanRecord) {
  return {
    id: record.plan.id,
    title: record.plan.title,
    digest: record.plan.digest,
    createdAt: record.plan.createdAt,
    executionId: record.executionId,
    status: record.status,
    actions: record.plan.actions.map((action) => {
      const entries = record.journal.filter((event) => event.actionId === action.id);
      const latest = entries.at(-1);
      const mayHaveOccurred =
        latest?.status !== 'succeeded' &&
        (latest?.status === 'running' ||
          entries.some((entry) => entry.detail?.startsWith('partial_effect')) ||
          (latest?.status === 'interrupted' &&
            entries.some((entry) => entry.status === 'running')));
      return {
        id: action.id,
        kind: action.kind,
        source: action.source,
        target: action.target,
        beforeHash: action.beforeHash,
        afterHash: action.afterHash,
        status: latest?.status ?? 'prepared',
        outcome:
          latest?.status === 'succeeded'
            ? 'confirmed'
            : mayHaveOccurred
              ? 'needs-inspection'
              : 'not-completed',
        currentFileState: 'not-rechecked',
      };
    }),
  };
}

/** Saved facts only: no opaque reservations, credentials, excerpts, page body or restored grant. */
export function recoveryFacts(
  plans: readonly ActionPlanRecord[],
  research: readonly ResearchPlanRecord[],
  sources: readonly SourceRecord[],
) {
  const sourceMetadata = new Map(sources.map((source) => [source.id, source]));
  return {
    trust: 'untrusted',
    approvalRestored: false,
    automaticReplay: false,
    sourceBodyRestored: false,
    omittedEarlierPlans: Math.max(0, plans.length - LIMIT),
    omittedEarlierResearchScopes: Math.max(0, research.length - LIMIT),
    filePlans: plans.slice(-LIMIT).map(actionFacts),
    research: research.slice(-LIMIT).map(({ snapshot, events }) => ({
      id: snapshot.id,
      digest: snapshot.digest,
      createdAt: snapshot.createdAt,
      title: snapshot.title,
      executionId: snapshot.executionId,
      queries: snapshot.queries.map(({ query, maxResults }) => ({ query, maxResults })),
      status: events.at(-1)?.status ?? 'prepared',
      requests: events
        .filter((event) => event.type === 'reserved')
        .map((reserved) => {
          const receipt = events.findLast(
            (event) =>
              event.reservationId === reserved.reservationId &&
              ['completed', 'failed'].includes(event.type),
          );
          return {
            kind: reserved.kind,
            status:
              receipt?.type === 'completed'
                ? 'response-received'
                : receipt?.type === 'failed'
                  ? 'not-completed'
                  : 'unknown',
            responseBytes: receipt?.responseBytes,
            discoveredSourceIds: reserved.kind === 'fetch' ? (receipt?.sourceIds ?? []) : undefined,
            sources: (receipt?.type === 'completed' && reserved.kind === 'search'
              ? (receipt.sourceIds ?? [])
              : []
            ).map((id) => {
              const source = sourceMetadata.get(id);
              return {
                id,
                retained: !!source,
                ...(source
                  ? {
                      url: source.url,
                      title: source.title,
                      kind: source.kind,
                      retrievedAt: source.retrievedAt,
                      contentHash: source.contentHash,
                    }
                  : {}),
              };
            }),
          };
        }),
    })),
  };
}

/** A separate bounded model projection. Full SQLite/UI records remain unchanged. */
export function recoveryContextForModel(
  plans: readonly ActionPlanRecord[],
  research: readonly ResearchPlanRecord[],
  sources: readonly SourceRecord[],
) {
  const facts = recoveryFacts(plans, research, sources);
  const context: {
    trust: 'untrusted';
    approvalRestored: false;
    automaticReplay: false;
    sourceBodyRestored: false;
    omittedEarlierPlans: number;
    omittedEarlierResearchScopes: number;
    filePlans: Record<string, unknown>[];
    research: Record<string, unknown>[];
  } = {
    trust: 'untrusted',
    approvalRestored: false,
    automaticReplay: false,
    sourceBodyRestored: false,
    omittedEarlierPlans: plans.length,
    omittedEarlierResearchScopes: research.length,
    filePlans: [],
    research: [],
  };
  const include = (kind: 'file' | 'research', record: Record<string, unknown>) => {
    const target = kind === 'file' ? context.filePlans : context.research;
    const count = kind === 'file' ? 'omittedEarlierPlans' : 'omittedEarlierResearchScopes';
    target.push(record);
    context[count]--;
    if (new TextEncoder().encode(JSON.stringify(context)).byteLength <= RECOVERY_CONTEXT_BYTES)
      return true;
    target.pop();
    context[count]++;
    return false;
  };
  const candidates = [
    ...facts.filePlans.map((record) => ({
      kind: 'file' as const,
      record,
      compact: {
        id: record.id,
        digest: record.digest,
        status: record.status,
        omittedActions: record.actions.length,
        needInspect: true,
        currentFileState: 'not-rechecked',
      },
    })),
    ...facts.research.map((record) => ({
      kind: 'research' as const,
      record,
      compact: {
        id: record.id,
        digest: record.digest,
        status: record.status,
        omittedQueries: record.queries.length,
        omittedRequests: record.requests.length,
        sourceBodyRestored: false,
        approvalRestored: false,
      },
    })),
  ].sort((first, second) => second.record.createdAt - first.record.createdAt);
  for (const candidate of candidates)
    if (!include(candidate.kind, candidate.record)) include(candidate.kind, candidate.compact);
  return context;
}

/** Deterministic user-visible inventory, independent of another model request after Stop. */
export function stoppedTaskReport(
  plans: readonly ActionPlanRecord[],
  research: readonly ResearchPlanRecord[],
  timeline: readonly TimelineItem[],
  sources: readonly SourceRecord[],
  interrupted = false,
): string | undefined {
  if (!plans.length && !research.length) return undefined;
  const lines = [interrupted ? 'Task interrupted. Saved results:' : 'Task stopped. Saved results:'];
  const facts = recoveryFacts(plans, research, sources);
  for (const plan of facts.filePlans) {
    lines.push(`File plan: ${plan.title}`);
    for (const action of plan.actions) {
      const status =
        action.outcome === 'confirmed'
          ? 'Completed'
          : action.outcome === 'needs-inspection'
            ? 'Needs inspection; effect may have occurred'
            : 'Not completed';
      lines.push(
        `- ${status}: ${actionNames[action.kind] ?? 'File action'} — ${action.source ? `${action.source} → ` : ''}${action.target}`,
      );
    }
  }
  for (const record of research.slice(-LIMIT)) {
    lines.push(`Research: ${record.snapshot.title}`);
    const scopeIndex = timeline.findIndex(
      (item) => item.preview?.research?.id === record.snapshot.id,
    );
    const scopeTimeline = scopeIndex < 0 ? [] : timeline.slice(scopeIndex);
    const nextScope = scopeTimeline.findIndex(
      (item, index) => index > 0 && !!item.preview?.research,
    );
    const scoped = nextScope < 0 ? scopeTimeline : scopeTimeline.slice(0, nextScope);
    for (const { query } of record.snapshot.queries) {
      const item = scoped.findLast(
        (entry) => entry.call?.name === 'web_search' && entry.preview?.query === query,
      );
      const received = !!item?.result && !item.result.isError;
      const sourceCount = item?.result?.sources?.length;
      lines.push(
        `- ${received ? `Search completed${sourceCount === undefined ? '' : ` (${sourceCount} sources)`}` : item ? 'Search not completed' : 'Search not started'}: ${query}`,
      );
    }
    const searchIds = new Set(
      record.events
        .filter((event) => event.type === 'completed' && event.kind === 'search')
        .flatMap((event) => event.sourceIds ?? []),
    );
    const pageIds = new Set(
      scoped.flatMap((item) =>
        ['fetch_source', 'fetch_page'].includes(item.call?.name ?? '') && !item.result?.isError
          ? (item.result?.sources ?? [])
              .filter((source) => source.kind === 'page')
              .map((source) => source.id)
          : [],
      ),
    );
    for (const source of sources.filter(
      (entry) => searchIds.has(entry.id) && entry.kind === 'search',
    ))
      lines.push(`- Saved search source: ${source.title} [source:${source.id}]`);
    for (const source of sources.filter((entry) => pageIds.has(entry.id) && entry.kind === 'page'))
      lines.push(`- Saved page source: ${source.title} [source:${source.id}]`);
    const unfinishedPages =
      facts.research
        .find((entry) => entry.id === record.snapshot.id)
        ?.requests.filter((entry) => entry.kind === 'fetch' && entry.status !== 'response-received')
        .length ?? 0;
    if (unfinishedPages) lines.push(`- Page requests not completed: ${unfinishedPages}`);
    lines.push(
      'A completed search or saved source does not mean the whole research task completed.',
    );
  }
  if (facts.omittedEarlierPlans || facts.omittedEarlierResearchScopes)
    lines.push('Older saved results are available in the task history.');
  lines.push(
    'No actions will resume automatically. Inspect current files before a new plan; new actions need new approval.',
  );
  return lines.join('\n');
}
