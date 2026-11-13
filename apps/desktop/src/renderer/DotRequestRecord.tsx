import { useState } from 'react';
import type { Dot } from '@prospero/dots';
import type { DotApprovalView, DotLiveRun, DotsBridge, DotView } from '../bridge';
import { statusTone } from './task-presentation';
export function DotRequestRecord({
  intent,
  dot,
  live,
  busy,
  now,
  api,
  operate,
  setError,
  readOnly = false,
}: {
  intent: DotApprovalView;
  dot: Dot;
  live?: DotLiveRun;
  busy: boolean;
  now: number;
  api: DotsBridge;
  operate: (operation: () => Promise<DotView>) => Promise<void>;
  setError: (message: string) => void;
  readOnly?: boolean;
}) {
  const [note, setNote] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  return (
    <section className="dot-result" aria-label={`Dot request ${intent.status}`}>
      <details
        className="dot-request-record"
        open={!readOnly && ['pending', 'approved', 'unknown'].includes(intent.status)}
      >
        <summary>
          <h2>
            <span className={`status-light ${statusTone(intent.status)}`} aria-hidden="true" />
            {intent.status === 'pending'
              ? 'Approval required'
              : intent.status === 'approved'
                ? 'Approved request'
                : intent.status === 'unknown'
                  ? intent.review
                    ? 'Uncertain outcome accepted'
                    : 'Outcome needs inspection'
                  : intent.status === 'succeeded'
                    ? 'Research receipt'
                    : `Request ${intent.status}`}
          </h2>
        </summary>
        <p>{intent.preview.title}</p>
        <p className="muted">
          Run {intent.runId} · {new Date(intent.createdAt).toLocaleString()}
          {intent.dispatchedAt === undefined
            ? ''
            : ` · Dispatch claimed ${new Date(intent.dispatchedAt).toLocaleString()}`}
        </p>
        {intent.preview.query && <pre className="dot-request-text">{intent.preview.query}</pre>}
        {intent.preview.url && <pre className="dot-request-text">{intent.preview.url}</pre>}
        {!readOnly && ['pending', 'approved'].includes(intent.status) && (
          <>
            <p>
              {now >= intent.expiresAt
                ? 'This approval has expired. Stop this step before starting a fresh request.'
                : `Expires ${new Date(intent.expiresAt).toLocaleString()}. Only this exact request is covered.`}
            </p>
            <div className="dot-actions">
              {intent.status === 'pending' ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !!live || now >= intent.expiresAt}
                    onClick={() =>
                      void operate(() =>
                        api.decide(
                          dot.id,
                          dot.revision,
                          intent.id,
                          intent.revision,
                          intent.digest,
                          'approve',
                        ),
                      )
                    }
                  >
                    Approve and continue
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!live || now >= intent.expiresAt}
                    onClick={() =>
                      void operate(() =>
                        api.decide(
                          dot.id,
                          dot.revision,
                          intent.id,
                          intent.revision,
                          intent.digest,
                          'deny',
                        ),
                      )
                    }
                  >
                    Deny request
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !!live || now >= intent.expiresAt}
                  onClick={() =>
                    void operate(() => api.resumeApproval(dot.id, dot.revision, intent.id))
                  }
                >
                  Continue approved request
                </button>
              )}
            </div>
          </>
        )}
        {intent.status === 'unknown' && (
          <div>
            <p className="inline-error">
              The request may have reached the service. Its result is still uncertain. It has not
              been retried.
            </p>
            {intent.review ? (
              <>
                <p>
                  Uncertainty accepted {new Date(intent.review.reviewedAt).toLocaleString()}. This
                  is not a success receipt. Old authorizations and wakes remain inactive.
                </p>
                <p className="dot-request-text">{intent.review.note}</p>
              </>
            ) : !readOnly ? (
              <form
                className="dot-policy-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (acknowledge && note.trim())
                    void operate(() =>
                      api.reviewUnknown(
                        dot.id,
                        dot.revision,
                        intent.id,
                        intent.revision,
                        intent.digest,
                        { acknowledge: true, note },
                      ),
                    );
                }}
              >
                <label>
                  What did you inspect?
                  <textarea
                    aria-label="Uncertain outcome review note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    maxLength={4096}
                    required
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                    required
                  />
                  I accept that this request may already have happened
                </label>
                <p>
                  This records your review only. It does not retry this request, resume its Run,
                  restore permission or start new work.
                </p>
                <button type="submit" disabled={busy || !!live || !acknowledge || !note.trim()}>
                  Accept uncertainty without retry
                </button>
              </form>
            ) : (
              <p>Review the current uncertain request before starting new work.</p>
            )}
          </div>
        )}
        {intent.receipt && (
          <>
            <p>
              {intent.receipt.summary}
              {intent.receipt.responseBytes === undefined
                ? ''
                : ` · ${intent.receipt.responseBytes} response bytes`}
            </p>
            <ul>
              {intent.receipt.sources?.map((source) => (
                <li key={source.id}>
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .openSource(dot.id, intent.id, source.id)
                        .catch(() => setError('Could not open this research source.'))
                    }
                  >
                    Open source: {source.title}
                  </button>
                  <p>
                    {source.kind === 'page' ? 'Page read' : 'Search snippet'} · {source.url}
                  </p>
                  <code>[source:{source.id}]</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </section>
  );
}
