import { useEffect, useRef, useState } from 'react';
import { rehydrateDotRecordQuery, type DotRecordQuery } from '@prospero/dots';
import type { DotRecordView, DotsBridge } from '../bridge';
import { statusTone } from './task-presentation';

export function DotRecordReader({
  api,
  dotId,
  target,
}: {
  api: DotsBridge;
  dotId: string;
  target: DotRecordQuery;
}) {
  const [page, setPage] = useState<DotRecordView>();
  const [text, setText] = useState('');
  const [section, setSection] = useState(target.section);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = useRef(0);
  useEffect(
    () => () => {
      read.current++;
    },
    [],
  );
  const query = (section: string, item = 0, version?: string) =>
    rehydrateDotRecordQuery({ ...target, section, item, offset: 0, version });
  const load = async (input: DotRecordQuery, append = false) => {
    const token = ++read.current;
    setBusy(true);
    setError('');
    try {
      const result = await api.record(dotId, input);
      if (token !== read.current) return;
      if (
        result.dotId !== dotId ||
        result.runId !== target.runId ||
        result.kind !== target.kind ||
        result.section !== input.section ||
        result.recordId !== (target.kind === 'request' ? target.intentId : target.runId)
      )
        throw new Error('Mismatched record');
      if (
        append &&
        (!page?.text ||
          !result.text ||
          page.version !== result.version ||
          page.item !== result.item ||
          page.section !== result.section ||
          page.text.end !== result.text.offset)
      )
        throw new Error('Changed record');
      setText((previous) =>
        append ? previous + (result.text?.content ?? '') : (result.text?.content ?? ''),
      );
      setPage(result);
    } catch {
      if (token === read.current) {
        setPage(undefined);
        setText('');
        setError('Could not continue this saved record. Refresh it from the beginning.');
      }
    } finally {
      if (token === read.current) setBusy(false);
    }
  };
  const sections =
    target.kind === 'checkpoint'
      ? [
          ['summary', 'Result'],
          ['completed', 'Recorded work'],
          ['next', 'Next steps'],
        ]
      : [
          ['sources', 'Sources'],
          ['query', 'Search query'],
          ['url', 'Requested page'],
          ['receipt', 'Response record'],
          ['review', 'Human review'],
        ];
  return (
    <details
      className="dot-progress-record"
      onToggle={(event) => {
        if (event.currentTarget.open && !page && !busy) void load(query(section));
        if (!event.currentTarget.open) {
          read.current++;
          setBusy(false);
        }
      }}
    >
      <summary>
        {target.kind === 'checkpoint'
          ? 'Read complete saved result'
          : 'Read complete saved request'}
      </summary>
      <section aria-label="Saved record details" aria-busy={busy}>
        <label>
          View{' '}
          <select
            aria-label="Saved detail section"
            value={section}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setSection(query(value).section);
              void load(query(value));
            }}
          >
            {sections.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        {page && (
          <>
            <p>
              <span className={`status-light ${statusTone(page.status)}`} aria-hidden="true" />{' '}
              Saved outcome: {page.status}
            </p>
            {!page.available && <p>No saved value for this section.</p>}
            {page.text && (
              <>
                <p>{text}</p>
                <p className="muted">
                  {page.text.end} of {page.text.total} characters · Entry {page.item + 1} of{' '}
                  {page.itemCount}
                </p>
              </>
            )}
            {page.sourceId && (
              <>
                <p>
                  Source {page.item + 1} of {page.itemCount}
                </p>
                {page.source ? (
                  <>
                    <p>{page.source.title}</p>
                    <p>{page.source.url}</p>
                    <p className="muted">
                      {page.source.kind === 'page'
                        ? 'Fetched page metadata'
                        : 'Search result metadata'}{' '}
                      · {new Date(page.source.retrievedAt).toLocaleString()}
                    </p>
                    <p className="muted">
                      Saved source: {page.source.id} · Hash: {page.source.contentHash}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        target.kind === 'request' &&
                        void api
                          .openSource(dotId, target.intentId, page.sourceId ?? '')
                          .catch(() => setError('Could not open this saved source.'))
                      }
                    >
                      Open saved source
                    </button>
                  </>
                ) : (
                  <p>Only the source ID was retained: {page.sourceId}</p>
                )}
              </>
            )}
            <p className="muted">
              This is saved historical data. It does not include page content, restore permission,
              or authorize a retry.
            </p>
          </>
        )}
        <div className="dot-actions">
          <button type="button" disabled={busy} onClick={() => void load(query(section))}>
            Refresh saved detail
          </button>
          <button
            type="button"
            disabled={busy || !page || page.item === 0}
            onClick={() => page && void load(query(section, page.item - 1, page.version))}
          >
            Previous saved entry
          </button>
          <button
            type="button"
            disabled={busy || !page?.next}
            onClick={() =>
              page?.next &&
              void load(page.next, page.next.item === page.item && (page.next.offset ?? 0) > 0)
            }
          >
            {page?.next && page.next.item === page.item ? 'Read more text' : 'Next saved entry'}
          </button>
        </div>
      </section>
    </details>
  );
}
