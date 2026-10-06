import type { ResearchEvent, ResearchPlan } from '@prospero/core';
import type { ResearchPlanRecord } from '../bridge';

export function ResearchPreview({ snapshot }: { snapshot: ResearchPlan }) {
  const expiresAt = new Date(snapshot.expiresAt);
  return (
    <section className="plan-preview" aria-label="Research approval preview">
      <div className="plan-summary">
        <span>One approval for these exact queries and limits</span>
        <p>
          Search queries: <strong>{snapshot.queries.length}</strong>
        </p>
        <p>
          Maximum searches: <strong>{snapshot.maxSearches}</strong> · Maximum page fetches:{' '}
          <strong>{snapshot.maxFetches}</strong>
        </p>
        <p>
          Response body budget: <strong>{snapshot.maxResponseBytes} bytes</strong>
        </p>
        <p>
          Expires:{' '}
          {Number.isFinite(expiresAt.getTime()) ? (
            <time dateTime={expiresAt.toISOString()}>{expiresAt.toLocaleString()}</time>
          ) : (
            'Unavailable'
          )}
        </p>
      </div>
      <ol className="plan-actions" aria-label="Approved search queries">
        {snapshot.queries.map((entry, index) => (
          <li key={`${index}:${entry.query}`}>
            <div className="plan-action-heading">
              <span className="plan-number">{index + 1}</span>
              <strong>{entry.query}</strong>
            </div>
            <div className="plan-action-detail">Maximum results: {entry.maxResults}</div>
          </li>
        ))}
      </ol>
      <p className="muted">
        Only pages returned by these searches can be fetched. This approval grants no local file,
        native, or shell access. External text cannot authorize further actions.
      </p>
      <details className="provenance-detail">
        <summary>Research fingerprint</summary>
        <p>
          Snapshot <code>{snapshot.id}</code>
        </p>
        <p>
          Digest <code>{snapshot.digest}</code>
        </p>
      </details>
    </section>
  );
}

const researchStatuses: Record<string, string> = {
  planned: 'Awaiting approval',
  prepared: 'Awaiting approval',
  approved: 'Snapshot approved',
  reserved: 'Reserved',
  running: 'Running',
  succeeded: 'Succeeded',
  completed: 'Completed',
  complete: 'Completed',
  denied: 'Denied',
  stale: 'Changed since preview',
  expired: 'Expired',
  exhausted: 'Research limit reached',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  closed: 'Scope closed',
  revoked: 'Revoked',
};

const researchEventTypes: Record<string, string> = {
  prepared: 'Awaiting approval',
  reserved: 'Reserved',
  started: 'Request dispatched',
  completed: 'Response received',
  failed: 'Failed',
  closed: 'Scope closed',
  revoked: 'Revoked',
  expired: 'Expired',
};

function researchEventLabel(event: ResearchEvent | undefined): string {
  if (!event) return 'Awaiting approval';
  return researchEventTypes[event.type] ?? researchStatuses[event.status] ?? 'Recorded';
}

export function ResearchJournal({ records }: { records: ResearchPlanRecord[] }) {
  if (!records.length) return null;
  return (
    <section aria-label="Research history">
      {records.map(({ snapshot, events }) => (
        <details className="tool-card" key={snapshot.id}>
          <summary>
            <strong>{snapshot.title}</strong>
            <span className="tool-status">{researchEventLabel(events.at(-1))}</span>
          </summary>
          <div className="tool-detail">
            <ResearchPreview snapshot={snapshot} />
            <ol aria-label="Research events">
              {events.map((event) => (
                <li key={event.sequence}>
                  {event.kind === 'search'
                    ? 'Search'
                    : event.kind === 'fetch'
                      ? 'Page fetch'
                      : 'Research'}
                  {' · '}
                  {researchEventLabel(event)}
                  {event.responseBytes !== undefined && ` · ${event.responseBytes} response bytes`}
                </li>
              ))}
            </ol>
          </div>
        </details>
      ))}
    </section>
  );
}
