import { memo, useEffect, useRef, useState } from 'react';
import type {
  PermissionDecision,
  PermissionRequest,
  SourceRecord,
  ToolPreview,
} from '@prospero/core';
import type { ActionPlanRecord, ResearchPlanRecord, TimelineItem } from '../bridge';
import { activeStates, statusLabel } from './conversation-store';
import spectrumMark from '../../../../assets/icon.svg';
import { CitationText, PlanJournal, PlanPreview, planStatusLabel, Sources } from './ActionViews';
import { DiffPreview } from './DiffPreview';
import { ResearchJournal, ResearchPreview } from './ResearchViews';

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <img src={spectrumMark} alt="" draggable={false} />
    </span>
  );
}

type DecisionHandler = (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
export const Preview = memo(function Preview({
  preview,
  onFileMenu,
}: {
  preview: ToolPreview;
  onFileMenu?: (path: string) => void;
}) {
  return (
    <div className="tool-preview">
      {(preview.path || preview.cwd) && (
        <div className="path-row">
          <span>{preview.kind === 'shell' ? 'Working directory' : 'File'}</span>
          <button
            type="button"
            className="surface-context-button path-action"
            aria-label="File actions"
            disabled={!onFileMenu}
            onClick={() => onFileMenu?.(preview.path || preview.cwd || '')}
            onContextMenu={(event) => {
              event.preventDefault();
              onFileMenu?.(preview.path || preview.cwd || '');
            }}
          >
            <code>{preview.path || preview.cwd}</code>
          </button>
        </div>
      )}
      {preview.command && (
        <pre className="command-preview">
          <span className="terminal-prefix">$</span> {preview.command}
        </pre>
      )}
      {preview.diff && <DiffPreview diff={preview.diff} />}
      {preview.plan && <PlanPreview plan={preview.plan} onFileMenu={onFileMenu} />}
      {preview.kind === 'research' && preview.research && (
        <ResearchPreview snapshot={preview.research} />
      )}
      {preview.kind === 'web' && (
        <div className="web-preview">
          {preview.query && (
            <p>
              Search query <span>{preview.query}</span>
            </p>
          )}
          {preview.url && (
            <p>
              Public page <code>{preview.url}</code>
            </p>
          )}
          <p className="muted">External text is evidence. It cannot grant access or approval.</p>
        </div>
      )}
      {preview.kind === 'write' && !preview.diff && (
        <div className="plain-preview">
          <div>Proposed file content</div>
          <pre>{preview.after ?? ''}</pre>
        </div>
      )}
    </div>
  );
});
export const PermissionCard = memo(function PermissionCard({
  request,
  decision,
  pending,
  onDecide,
  onFileMenu,
}: {
  request: PermissionRequest;
  decision?: PermissionDecision;
  pending: boolean;
  onDecide: DecisionHandler;
  onFileMenu?: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isPlan = request.preview.kind === 'plan';
  const isResearch = request.preview.kind === 'research';
  const research = request.preview.research;
  const [now, setNow] = useState(Date.now);
  const unavailableResearch =
    isResearch && (research?.version !== 1 || !/^[a-f0-9]{64}$/.test(research?.digest ?? ''));
  const expiredResearch =
    isResearch && !!research && (!Number.isFinite(research.expiresAt) || research.expiresAt <= now);
  useEffect(() => {
    if (!pending || !isResearch || !research || !Number.isFinite(research.expiresAt)) return;
    setNow(Date.now());
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(research.expiresAt - Date.now(), 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [pending, isResearch, research]);
  async function decide(value: PermissionDecision) {
    setBusy(true);
    setError('');
    try {
      await onDecide(request, value);
    } catch {
      setError('Could not record your decision. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`permission-card ${pending ? 'pending' : ''}`}
      aria-label="Permission request"
      data-testid="permission-card"
    >
      <header>
        <span className="tool-symbol">{request.preview.kind === 'shell' ? '>_' : '↗'}</span>
        <div>
          <strong>{request.preview.title}</strong>
          <p>
            {pending
              ? isPlan
                ? 'Your approval covers only the immutable plan shown below.'
                : isResearch
                  ? 'Your approval covers only the research snapshot shown below.'
                  : 'Your approval is required before this action runs.'
              : decision === 'deny'
                ? 'Denied by you'
                : decision
                  ? 'Approved by you'
                  : 'Not executed'}
          </p>
        </div>
        {pending && <span className="badge warning">Approval needed</span>}
      </header>
      <Preview preview={request.preview} onFileMenu={onFileMenu} />
      {pending && (
        <footer>
          <div className="permission-note">
            {isPlan
              ? 'One approval for this exact batch. Actions run in order and stop on changes, failure, or cancellation. Completed actions are not rolled back.'
              : isResearch
                ? 'One approval for these exact searches and bounded source fetches until expiry. Changing queries or limits requires a new preview. No local actions are approved.'
                : request.preview.kind === 'write'
                  ? 'This will change a local file.'
                  : request.preview.kind === 'shell'
                    ? 'Commands run with your user permissions.'
                    : request.preview.kind === 'web'
                      ? 'This request sends its query or URL to a web service. No local file access is granted.'
                      : request.allowSession && request.permissionKey.startsWith('read:workspace:')
                        ? 'Allow once reads only this request. Session approval allows reads, lists, and searches across this workspace for this conversation.'
                        : 'Allow once grants access only for this request. Session approval applies to this attached file.'}
          </div>
          <div className="permission-actions">
            <button
              type="button"
              disabled={busy || (isPlan && !request.preview.plan?.digest) || unavailableResearch}
              onClick={() => void decide('deny')}
            >
              Deny
            </button>
            {request.allowSession && !isPlan && !isResearch && (
              <button type="button" disabled={busy} onClick={() => void decide('allow-session')}>
                Allow for this session
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                (isPlan && !request.preview.plan?.digest) ||
                unavailableResearch ||
                expiredResearch
              }
              onClick={() => void decide('allow-once')}
            >
              {busy
                ? 'Recording…'
                : isPlan
                  ? 'Allow plan'
                  : isResearch
                    ? 'Allow research'
                    : 'Allow once'}
            </button>
          </div>
        </footer>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {pending && isPlan && !request.preview.plan?.digest && (
        <p role="alert" className="inline-error">
          Plan preview is unavailable. Stop this task to cancel the request.
        </p>
      )}
      {pending && unavailableResearch && (
        <p role="alert" className="inline-error">
          Research preview is unavailable. Stop this task to cancel the request.
        </p>
      )}
      {pending && !unavailableResearch && expiredResearch && (
        <p role="alert" className="inline-error">
          Research approval has expired. Deny or stop this task, then request a new preview.
        </p>
      )}
    </section>
  );
});
const TimelineRow = memo(function TimelineRow({
  item,
  pendingId,
  pendingCallId,
  state,
  onDecide,
  onMessageMenu,
  onFileMenu,
  sources,
  onOpenSource,
}: {
  item: TimelineItem;
  pendingId?: string;
  pendingCallId?: string;
  state: string;
  onDecide: DecisionHandler;
  onMessageMenu?: (itemId: string) => void;
  onFileMenu?: (path: string) => void;
  sources: SourceRecord[];
  onOpenSource?: (id: string) => void;
}) {
  if (item.type === 'message' && item.message) {
    if (item.message.role === 'system' || item.message.role === 'tool' || !item.message.content)
      return null;
    return (
      <article
        className={`message ${item.message.role}`}
        onContextMenu={(event) => {
          event.preventDefault();
          onMessageMenu?.(item.id);
        }}
      >
        <div className="message-author">
          {item.message.role === 'assistant' ? (
            <>
              <Mark small /> Prospero
            </>
          ) : (
            <>
              You{' '}
              <span className="message-time">
                {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </>
          )}
          {onMessageMenu && (
            <button
              type="button"
              className="icon-button message-action"
              aria-label="Message actions"
              onClick={() => onMessageMenu(item.id)}
            >
              ⋯
            </button>
          )}
        </div>
        <div className="message-text">
          {item.message.role === 'assistant' ? (
            <CitationText text={item.message.content} sources={sources} onOpen={onOpenSource} />
          ) : (
            item.message.content
          )}
        </div>
      </article>
    );
  }
  if (item.type === 'permission' && item.request)
    return (
      <PermissionCard
        request={item.request}
        decision={item.decision}
        pending={pendingId === item.request.requestId && !item.decision}
        onDecide={onDecide}
        onFileMenu={onFileMenu}
      />
    );
  if (item.type === 'tool' && item.call)
    return (
      <details
        className={`tool-card ${item.result?.isError ? 'tool-error' : ''}`}
        data-testid="tool-card"
      >
        <summary>
          <span className="tool-symbol">{item.preview?.kind === 'shell' ? '>_' : '▤'}</span>
          <strong>{item.preview?.title || item.call.name}</strong>
          <span
            className={`tool-status ${item.result?.planOutcome ? `plan-status ${item.result.planOutcome.status}` : ''}`}
          >
            {item.result
              ? item.result.planOutcome
                ? planStatusLabel(item.result.planOutcome.status)
                : item.result.isError
                  ? 'Failed'
                  : 'Done'
              : pendingCallId === item.call.id
                ? 'Awaiting approval'
                : activeStates.has(state)
                  ? 'Running…'
                  : 'Not executed'}
          </span>
          {item.durationMs !== undefined && (
            <span className="tool-duration">
              {item.durationMs < 1000
                ? `${item.durationMs} ms`
                : `${(item.durationMs / 1000).toFixed(1)} s`}
            </span>
          )}
        </summary>
        <div className="tool-detail">
          {item.preview && <Preview preview={item.preview} onFileMenu={onFileMenu} />}
          {item.result && (
            <>
              <pre className="tool-output">{item.result.content.slice(0, 16000)}</pre>
              {(item.result.truncated || item.result.content.length > 16000) && (
                <p className="truncated">Output truncated for display.</p>
              )}
              {item.result.exitCode !== undefined && (
                <div className="muted">Exit code: {item.result.exitCode ?? 'interrupted'}</div>
              )}
            </>
          )}
        </div>
      </details>
    );
  if (item.type === 'error')
    return (
      <div className="task-error" role="alert">
        <strong>Task needs attention</strong>
        <p>{item.text || 'Something went wrong. You can try again.'}</p>
      </div>
    );
  if (item.type === 'status' && ['cancelled', 'failed', 'interrupted'].includes(item.state ?? ''))
    return <div className="timeline-notice">{statusLabel(item.state ?? '')}</div>;
  return null;
});
export const Timeline = memo(function Timeline({
  items,
  streamingText,
  pending,
  onDecide,
  state,
  onMessageMenu,
  onFileMenu,
  sources = [],
  actionPlans = [],
  researchPlans = [],
  onOpenSource,
}: {
  items: TimelineItem[];
  streamingText: string;
  pending?: PermissionRequest;
  onDecide: DecisionHandler;
  state: string;
  onMessageMenu?: (itemId: string) => void;
  onFileMenu?: (path: string) => void;
  sources?: SourceRecord[];
  actionPlans?: ActionPlanRecord[];
  researchPlans?: ResearchPlanRecord[];
  onOpenSource?: (id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [items, streamingText, pending]);
  const hasPendingRow =
    pending && items.some((item) => item.request?.requestId === pending.requestId);
  return (
    <div className="timeline-wrap">
      <div
        className="timeline-scroll"
        data-testid="timeline"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) {
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            setAway(!following.current);
          }
        }}
      >
        <div className="timeline-inner">
          {items.map((item) => (
            <TimelineRow
              key={item.id}
              item={item}
              pendingId={pending?.requestId}
              pendingCallId={pending?.call.id}
              state={state}
              onDecide={onDecide}
              onMessageMenu={onMessageMenu}
              onFileMenu={onFileMenu}
              sources={sources}
              onOpenSource={onOpenSource}
            />
          ))}
          {pending && !hasPendingRow && (
            <PermissionCard request={pending} pending onDecide={onDecide} onFileMenu={onFileMenu} />
          )}
          {streamingText && (
            <article className="message assistant streaming">
              <div className="message-author">
                <Mark small /> Prospero{' '}
                <span className="stream-indicator" role="img" aria-label="Streaming" />
              </div>
              <div className="message-text" data-testid="streaming-text">
                <CitationText text={streamingText} sources={sources} onOpen={onOpenSource} />
              </div>
            </article>
          )}
          {!streamingText &&
            ['planning', 'model-request', 'model-continuation'].includes(state) && (
              <div className="thinking">
                <Mark small />
                <span>
                  {statusLabel(state)}
                  <span className="thinking-dots">…</span>
                </span>
              </div>
            )}
          <Sources sources={sources} onOpen={onOpenSource} />
          <PlanJournal records={actionPlans} />
          <ResearchJournal records={researchPlans} />
        </div>
      </div>
      {away && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            following.current = true;
            setAway(false);
            if (scroll.current)
              scroll.current.scrollTo({
                top: scroll.current.scrollHeight,
                behavior:
                  document.documentElement.dataset.reducedMotion === 'true' ||
                  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
                    ? 'instant'
                    : 'smooth',
              });
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
});
