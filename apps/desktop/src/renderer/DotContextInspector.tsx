import { useEffect, useRef, useState } from 'react';
import type { DotContextQuery } from '@prospero/dots';
import type { DotContextView, DotsBridge } from '../bridge';
import { statusTone } from './task-presentation';
import { DotRecordReader } from './DotRecordReader';

export function DotContextInspector({
  api,
  dotId,
  revision,
}: {
  api: DotsBridge;
  dotId: string;
  revision: number;
}) {
  const [page, setPage] = useState<DotContextView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = useRef(0);
  useEffect(
    () => () => {
      read.current++;
    },
    [],
  );
  const load = async (query: DotContextQuery = {}) => {
    const token = ++read.current;
    setBusy(true);
    setError('');
    try {
      const value = await api.context(dotId, query);
      if (token === read.current && value.dotId === dotId) setPage(value);
    } catch {
      if (token === read.current) setError('Could not read saved context. Try refreshing.');
    } finally {
      if (token === read.current) setBusy(false);
    }
  };
  return (
    <details
      className="dot-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !page && !busy) void load();
      }}
    >
      <summary>Saved context</summary>
      <section aria-label="Dot saved context" aria-busy={busy}>
        <p className="muted">
          Previous work and saved results. Opening these records does not start work.
        </p>
        {error && <p role="alert">{error}</p>}
        {page && page.dotRevision !== revision && (
          <p className="muted">
            New progress is available. Refresh to see the latest saved context.
          </p>
        )}
        {page?.run ? (
          <>
            <p>
              <span className={`status-light ${statusTone(page.run.status)}`} aria-hidden="true" />{' '}
              Step {page.run.status} · {new Date(page.run.updatedAt).toLocaleString()}
            </p>
            <code>{page.run.id}</code>
            {page.checkpoint ? (
              <>
                <p>{page.checkpoint.summary}</p>
                <h3>Recorded work</h3>
                <ul>
                  {page.checkpoint.completed.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
                <h3>Next steps</h3>
                <ul>
                  {page.checkpoint.next.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
                {page.checkpoint.truncated && (
                  <p className="muted">
                    Excerpt. The full saved text is in Saved progress history.
                  </p>
                )}
                <DotRecordReader
                  key={page.run.id}
                  api={api}
                  dotId={dotId}
                  target={{ kind: 'checkpoint', runId: page.run.id, section: 'summary' }}
                />
              </>
            ) : (
              <p className="muted">
                This step did not save a checkpoint. Its request results remain separate.
              </p>
            )}
            {page.requests.map((request) => (
              <article className="dot-progress-record" key={request.id}>
                <p>
                  <span
                    className={`status-light ${statusTone(request.status)}`}
                    aria-hidden="true"
                  />{' '}
                  {request.tool === 'web_search'
                    ? 'Search'
                    : request.tool === 'fetch_page'
                      ? 'Read page'
                      : 'Research request'}{' '}
                  · {request.status}
                </p>
                {request.query && <p>{request.query}</p>}
                {request.url && <p>{request.url}</p>}
                {request.receipt && (
                  <>
                    <p>
                      {request.receipt.summary} · {request.receipt.sourceCount}{' '}
                      {request.receipt.sourceCount === 1 ? 'source' : 'sources'}
                    </p>
                    {request.receipt.sources.map((source) => (
                      <div className="dot-actions" key={source.id}>
                        <button
                          type="button"
                          onClick={() =>
                            void api
                              .openSource(dotId, request.id, source.id)
                              .catch(() => setError('Could not open this saved source.'))
                          }
                        >
                          {source.title}
                        </button>
                        <span className="muted">
                          {source.kind === 'page'
                            ? 'Fetched page metadata'
                            : 'Search result metadata'}{' '}
                          · {new Date(source.retrievedAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </>
                )}
                {request.review && (
                  <>
                    <p>Human review: {request.review.note}</p>
                    <p className="muted">
                      The outcome remains unknown. Review does not authorize a retry.
                    </p>
                  </>
                )}
                {request.truncated && (
                  <p className="muted">Excerpt. See Request history for the full record.</p>
                )}
                <DotRecordReader
                  api={api}
                  dotId={dotId}
                  target={{
                    kind: 'request',
                    runId: page.run?.id ?? '',
                    intentId: request.id,
                    section: 'sources',
                  }}
                />
              </article>
            ))}
            <p className="muted">
              Historical source metadata does not contain the saved page body or prove that a source
              is still current.
            </p>
          </>
        ) : (
          page && <p>No previous steps have finished yet.</p>
        )}
        <div className="dot-actions">
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh saved context
          </button>
          <button
            type="button"
            disabled={busy || !page?.olderRunId}
            onClick={() => page?.olderRunId && void load({ runId: page.olderRunId })}
          >
            Older context
          </button>
          <button
            type="button"
            disabled={busy || !page?.run || page.requestOffset === 0}
            onClick={() =>
              page?.run &&
              void load({ runId: page.run.id, requestOffset: Math.max(0, page.requestOffset - 2) })
            }
          >
            Previous context requests
          </button>
          <button
            type="button"
            disabled={
              busy || !page?.run || page.requestOffset + page.requests.length >= page.requestCount
            }
            onClick={() =>
              page?.run &&
              void load({
                runId: page.run.id,
                requestOffset: page.requestOffset + page.requests.length,
              })
            }
          >
            More context requests
          </button>
        </div>
      </section>
    </details>
  );
}
