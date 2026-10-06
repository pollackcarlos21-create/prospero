import type { ReactNode } from 'react';
import type { ActionPlan, ActionStatus, PlanStatus, SourceRecord } from '@prospero/core';
import type { ActionPlanRecord } from '../bridge';
import { DiffPreview } from './DiffPreview';

export const actionLabels: Record<string, string> = {
  copy_file: 'Copy file',
  move_file: 'Move file',
  rename_file: 'Rename file',
  create_directory: 'Create folder',
  write_text: 'Write text',
  trash_file: 'Move file to Trash',
  reveal_in_finder: 'Reveal in Finder',
  copy_path: 'Copy path',
};
const effectLabels: Record<string, string> = {
  'file.read': 'Read file',
  'file.write': 'Write file',
  'file.remove': 'Remove file',
  'process.execute': 'Run command',
  'network.search': 'Web search',
  'network.fetch': 'Read web page',
  'native.reveal': 'Reveal in Finder',
  'native.clipboard': 'Write clipboard',
};
const statuses: Record<PlanStatus | ActionStatus, string> = {
  prepared: 'Awaiting approval',
  approved: 'Approved',
  running: 'Running',
  succeeded: 'Succeeded',
  completed: 'Completed',
  denied: 'Denied',
  stale: 'Changed since preview',
  partial: 'Partially completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  skipped: 'Not executed',
  interrupted: 'Interrupted',
};

export function planStatusLabel(status: PlanStatus): string {
  return statuses[status];
}

function Path({
  label,
  path,
  onFileMenu,
}: {
  label: string;
  path: string;
  onFileMenu?: (path: string) => void;
}) {
  return (
    <div className="plan-path">
      <span>{label}</span>
      <button
        type="button"
        className="surface-context-button path-action"
        disabled={!onFileMenu}
        title={path}
        aria-label={`${label} file actions: ${path}`}
        onClick={() => onFileMenu?.(path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onFileMenu?.(path);
        }}
      >
        <code>{path}</code>
      </button>
    </div>
  );
}

export function PlanPreview({
  plan,
  onFileMenu,
}: {
  plan: ActionPlan;
  onFileMenu?: (path: string) => void;
}) {
  return (
    <section className="plan-preview" aria-label="Action Plan preview">
      <div className="plan-summary">
        <span>{plan.actions.length} actions · One approval for this exact plan</span>
        <p>Review every action. A changed file or scope requires a new preview.</p>
      </div>
      <ol className="plan-actions">
        {plan.actions.map((action, index) => (
          <li key={action.id}>
            <div className="plan-action-heading">
              <span className="plan-number">{index + 1}</span>
              <strong>{actionLabels[action.kind] ?? action.kind}</strong>
              {action.bytes !== undefined && <span>{action.bytes.toLocaleString()} bytes</span>}
            </div>
            <div className="plan-action-detail">
              {action.source && <Path label="From" path={action.source} onFileMenu={onFileMenu} />}
              <Path label="To" path={action.target} onFileMenu={onFileMenu} />
              <ul className="plan-effects" aria-label="Action effects">
                {action.effects.map((effect) => (
                  <li key={effect}>{effectLabels[effect] ?? effect}</li>
                ))}
              </ul>
              {(action.beforeHash || action.afterHash) && (
                <details className="provenance-detail">
                  <summary>Content fingerprints</summary>
                  {action.beforeHash && (
                    <p>
                      Before <code>{action.beforeHash}</code>
                    </p>
                  )}
                  {action.afterHash && (
                    <p>
                      After <code>{action.afterHash}</code>
                    </p>
                  )}
                </details>
              )}
              {action.diff && <DiffPreview diff={action.diff} />}
            </div>
          </li>
        ))}
      </ol>
      <details className="provenance-detail plan-fingerprint">
        <summary>Plan fingerprint</summary>
        <code>{plan.digest}</code>
        <p>Prepared {new Date(plan.createdAt).toLocaleString()}</p>
      </details>
    </section>
  );
}

export function PlanJournal({ records }: { records: ActionPlanRecord[] }) {
  if (!records.length) return null;
  return (
    <section className="plan-journals" aria-label="Action Plan history">
      {records.map(({ plan, status, journal }) => (
        <details className={`plan-journal ${status}`} key={plan.id} data-testid="plan-journal">
          <summary>
            <span aria-hidden="true">{status === 'completed' ? '✓' : '◷'}</span>
            <strong>{plan.title}</strong>
            <span className={`plan-status ${status}`}>{statuses[status]}</span>
          </summary>
          <p className="journal-note">
            {status === 'partial'
              ? 'Some actions completed before the plan stopped. Completed actions were not rolled back.'
              : status === 'interrupted'
                ? 'The app stopped during this plan. Actions will not run again automatically.'
                : status === 'stale'
                  ? 'A file or scope changed after preview. Request a new plan before continuing.'
                  : 'Saved action history. Approval is separate from successful execution.'}
          </p>
          <ol className="journal-actions">
            {plan.actions.map((action) => {
              const entries = journal
                .filter((entry) => entry.actionId === action.id)
                .sort((a, b) => a.sequence - b.sequence);
              const latest = entries.at(-1);
              const actionStatus = latest?.status ?? 'prepared';
              return (
                <li key={action.id}>
                  <span className={`journal-marker ${actionStatus}`} aria-hidden="true">
                    {actionStatus === 'succeeded' ? '✓' : '○'}
                  </span>
                  <div>
                    <div className="journal-heading">
                      <strong>{actionLabels[action.kind] ?? action.kind}</strong>
                      <span>{statuses[actionStatus]}</span>
                    </div>
                    <code className="journal-path">{action.target}</code>
                    {latest?.detail && <p>{latest.detail}</p>}
                    {!!entries.length && (
                      <details className="provenance-detail">
                        <summary>Saved transitions</summary>
                        {entries.map((entry) => (
                          <p key={entry.sequence}>
                            {statuses[entry.status]} · {new Date(entry.at).toLocaleTimeString()}
                            {entry.detail ? ` · ${entry.detail}` : ''}
                          </p>
                        ))}
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      ))}
    </section>
  );
}

export function CitationText({
  text,
  sources,
  onOpen,
}: {
  text: string;
  sources: SourceRecord[];
  onOpen?: (id: string) => void;
}) {
  const parts: ReactNode[] = [];
  const citation = /\[source:([^\]\s]{1,128})\]/g;
  let offset = 0;
  for (const match of text.matchAll(citation)) {
    const index = match.index ?? 0;
    parts.push(text.slice(offset, index));
    const matches = sources.filter((source) => source.id === match[1]);
    const source = matches.length === 1 ? matches[0] : undefined;
    parts.push(
      source ? (
        <button
          type="button"
          className="citation-button"
          key={`citation-${index}`}
          title={source.url}
          aria-label={`Open source: ${source.title}`}
          disabled={!onOpen}
          onClick={() => onOpen?.(source.id)}
        >
          [{sources.indexOf(source) + 1}]
        </button>
      ) : (
        <span className="unverified-citation" key={`citation-${index}`}>
          {match[0]} <span>(Unverified source)</span>
        </span>
      ),
    );
    offset = index + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

export function Sources({
  sources,
  onOpen,
}: {
  sources: SourceRecord[];
  onOpen?: (id: string) => void;
}) {
  if (!sources.length) return null;
  return (
    <details className="sources-panel">
      <summary>
        Sources <span>{sources.length}</span>
      </summary>
      <ol className="sources-list">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className="source-title text-button"
              disabled={!onOpen}
              onClick={() => onOpen?.(source.id)}
              aria-label={`Open source: ${source.title}`}
            >
              {source.title}
            </button>
            <p className="source-url">{source.url}</p>
            <div className="source-metadata">
              <span>{source.kind === 'search' ? 'Search snippet' : 'Page text'}</span>
              <time dateTime={new Date(source.retrievedAt).toISOString()}>
                {new Date(source.retrievedAt).toLocaleString()}
              </time>
              <span>External evidence</span>
            </div>
            <p className="source-excerpt">{source.excerpt}</p>
            <details className="provenance-detail">
              <summary>Source fingerprint</summary>
              <code>{source.contentHash}</code>
              <p>{source.id}</p>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
