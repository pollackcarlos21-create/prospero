import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dot, DotCheckpoint, DotRun } from '@prospero/dots';
import type { DesktopBridge, DotControl, DotsBridge, DotView, ProviderConfig } from '../bridge';
import { elapsedLabel, statusTone } from './task-presentation';
import { statusLabel } from './conversation-store';
import { friendlyError } from './friendly-error';
import { DotRequestRecord } from './DotRequestRecord';
import { DotContextInspector } from './DotContextInspector';
import type { DotRequestHistoryView } from '../bridge';

function runLabel(run: DotRun): string {
  return {
    pending: 'Preparing',
    running: 'Working',
    succeeded: 'Step completed',
    failed: 'Step incomplete',
    cancelled: 'Stopped',
    interrupted: 'Interrupted — inspect results',
  }[run.status];
}
function Notes({ items }: { items: readonly string[] }) {
  const seen = new Map<string, number>();
  return (
    <ul>
      {items.map((note) => {
        const occurrence = (seen.get(note) ?? 0) + 1;
        seen.set(note, occurrence);
        return <li key={`${note}:${occurrence}`}>{note}</li>;
      })}
    </ul>
  );
}
export function dotLabel(
  view: Pick<DotView, 'dot' | 'live' | 'runs' | 'approvals' | 'wakes'>,
): string {
  if (view.dot.lifecycle !== 'active')
    return {
      paused: 'Paused',
      completed: 'Goal completed',
      cancelled: 'Goal cancelled',
      archived: 'Archived',
    }[view.dot.lifecycle];
  if (view.dot.inFlightRunId)
    if (
      !view.live &&
      view.approvals?.some((intent) => intent.status === 'pending' || intent.status === 'approved')
    )
      return 'Waiting for approval';
  if (view.dot.inFlightRunId)
    return view.live
      ? view.live.state === 'completed'
        ? 'Saving progress'
        : statusLabel(view.live.state)
      : 'Needs inspection';
  const wake = view.wakes?.find((wake) => wake.status === 'scheduled');
  if (wake) return `Sleeping until ${new Date(wake.dueAt).toLocaleString()}`;
  if (view.approvals?.some((intent) => intent.status === 'unknown' && !intent.review))
    return 'Outcome needs review';
  if (view.approvals?.some((intent) => intent.status === 'unknown' && intent.review))
    return 'Ready for a new step';
  return view.runs[0]?.status === 'failed' || view.runs[0]?.status === 'interrupted'
    ? 'Needs attention'
    : 'Ready for next step';
}

export function DotsPanel({
  api,
  bridge,
  active,
  selected,
  createVersion,
  onSelect,
  onList,
  providers,
  defaultProviderId,
  onSettings,
  webSearchReady = false,
  supervision,
}: {
  api: DotsBridge;
  bridge: DesktopBridge;
  active: boolean;
  selected?: string;
  createVersion: number;
  onSelect: (id: string | undefined) => void;
  onList: (dots: readonly Dot[]) => void;
  providers: ProviderConfig[];
  defaultProviderId?: string;
  onSettings: () => void;
  webSearchReady?: boolean;
  supervision?: import('../bridge').DotSupervisionSnapshot;
}) {
  const [data, setData] = useState<DotView>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [runFirst, setRunFirst] = useState(true);
  const [policyQueries, setPolicyQueries] = useState('');
  const [policyRuns, setPolicyRuns] = useState(3);
  const [policySearches, setPolicySearches] = useState(6);
  const [policyFetches, setPolicyFetches] = useState(6);
  const [policyMiB, setPolicyMiB] = useState(8);
  const [policyHours, setPolicyHours] = useState(24);
  const [allowPages, setAllowPages] = useState(true);
  const [wakeTime, setWakeTime] = useState('');
  const [providerId, setProviderId] = useState(defaultProviderId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<readonly DotRun[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [progress, setProgress] = useState<readonly DotCheckpoint[]>([]);
  const [progressOffset, setProgressOffset] = useState(0);
  const [showRequests, setShowRequests] = useState(false);
  const [requestPage, setRequestPage] = useState<DotRequestHistoryView>();
  const requestRead = useRef(0);
  const [now, setNow] = useState(Date.now);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const known = useRef(new Map<string, Dot>());
  const offset = useRef(0);
  const nameInput = useRef<HTMLInputElement>(null);
  const merge = useCallback(
    (rows: readonly Dot[]) => {
      let changed = false;
      for (const dot of rows) {
        const previous = known.current.get(dot.id);
        if (!previous || dot.revision > previous.revision) {
          known.current.set(dot.id, dot);
          changed = true;
        }
      }
      if (changed)
        onList(
          [...known.current.values()].sort(
            (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
          ),
        );
    },
    [onList],
  );
  const accept = useCallback(
    (snapshot: DotView) => {
      merge([snapshot.dot]);
      if (selectedRef.current !== snapshot.dot.id) return;
      setData((previous) =>
        previous?.dot.id === snapshot.dot.id &&
        (previous.dot.revision > snapshot.dot.revision ||
          (previous.dot.revision === snapshot.dot.revision &&
            previous.sequence > snapshot.sequence))
          ? previous
          : snapshot,
      );
    },
    [merge],
  );
  useEffect(() => {
    let live = true;
    api
      .list({ limit: 50, includeArchived: true })
      .then((rows) => {
        if (!live) return;
        offset.current = rows.length;
        merge(rows);
        setHasMore(rows.length === 50);
        setLoading(false);
      })
      .catch(() => {
        if (live) {
          setLoading(false);
          setError('Could not load saved Dots. Your existing data has been preserved.');
        }
      });
    return () => {
      live = false;
    };
  }, [api, merge]);
  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event.type === 'dot') accept(event.snapshot);
        else if (event.type === 'dot-error' && event.dotId === selectedRef.current)
          setError(
            'This Dot’s saved state is unavailable. Refresh to inspect it before continuing.',
          );
      }),
    [bridge, accept],
  );
  useEffect(() => {
    setError('');
    setShowHistory(false);
    setHistory([]);
    setProgress([]);
    setShowRequests(false);
    setRequestPage(undefined);
    requestRead.current++;
    if (!selected) {
      setData(undefined);
      return;
    }
    let live = true;
    api
      .get(selected)
      .then((value) => {
        if (live) accept(value);
      })
      .catch(() => {
        if (live) setError('Could not open this Dot. Refresh and try again.');
      });
    return () => {
      live = false;
    };
  }, [api, selected, accept]);
  useEffect(() => {
    if (!createVersion) return;
    setCreating(true);
    setError('');
    nameInput.current?.focus();
  }, [createVersion]);
  useEffect(() => {
    if (active && creating && !document.querySelector('[aria-modal="true"]'))
      nameInput.current?.focus();
  }, [active, creating]);
  useEffect(() => {
    if (selected) setCreating(false);
  }, [selected]);
  useEffect(() => {
    const supported = providers.filter((provider) => provider.supportsTools);
    if (!supported.some((provider) => provider.id === providerId))
      setProviderId(
        supported.find((provider) => provider.id === defaultProviderId)?.id ??
          supported[0]?.id ??
          '',
      );
  }, [providers, providerId, defaultProviderId]);
  const current = data?.dot.id === selected ? data : undefined;
  const unresolved =
    current?.approvals?.some((intent) => intent.status === 'unknown' && !intent.review) ?? false;
  const waitingApproval =
    current?.approvals?.some((intent) => ['pending', 'approved'].includes(intent.status)) ?? false;
  const timingPolicy = current?.policy?.policy.status === 'active';
  useEffect(() => {
    if (!active || (!current?.live && !waitingApproval && !timingPolicy)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, current?.live?.runId, waitingApproval, timingPolicy]);
  const operate = useCallback(
    async (operation: () => Promise<DotView>) => {
      setBusy(true);
      setError('');
      try {
        accept(await operation());
      } catch (failure) {
        setError(
          friendlyError(
            failure,
            'This action could not be completed. Refresh the Dot and try again.',
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [accept],
  );
  const stop = useCallback(async () => {
    if (!selected) return;
    await operate(() => api.stop(selected));
  }, [api, selected, operate]);
  useEffect(() => {
    if (!active || !current?.live) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        event.preventDefault();
        void stop();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [active, current?.live?.runId, stop]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !goal.trim() || (runFirst && !providerId)) return;
    setBusy(true);
    setError('');
    try {
      const value = await api.create({ name, goal });
      merge([value.dot]);
      onSelect(value.dot.id);
      setName('');
      setGoal('');
      setCreating(false);
      if (runFirst) accept(await api.run(value.dot.id, value.dot.revision, providerId));
    } catch (failure) {
      setError(
        friendlyError(failure, 'Could not create or start this Dot. Check your model connection.'),
      );
    } finally {
      setBusy(false);
    }
  }
  async function loadMore() {
    try {
      const rows = await api.list({ limit: 50, offset: offset.current, includeArchived: true });
      offset.current += rows.length;
      merge(rows);
      setHasMore(rows.length === 50);
    } catch {
      setError('Could not load the next page of Dots.');
    }
  }
  async function loadHistory(nextOffset = 0) {
    if (!selected) return;
    const id = selected;
    try {
      const rows = await api.history(id, { limit: 20, offset: nextOffset });
      if (selectedRef.current === id) {
        setHistory(rows);
        setHistoryOffset(nextOffset);
        setShowHistory(true);
      }
    } catch {
      setError('Could not read this Run history.');
    }
  }
  async function loadRequests(nextOffset = 0) {
    if (!selected) return;
    const id = selected;
    const read = ++requestRead.current;
    try {
      const page = await api.requests(id, { limit: 20, offset: nextOffset });
      if (selectedRef.current === id && read === requestRead.current) setRequestPage(page);
    } catch {
      if (selectedRef.current === id && read === requestRead.current)
        setError('Could not read this request history.');
    }
  }
  async function loadProgress(nextOffset = 0) {
    if (!selected) return;
    const id = selected;
    try {
      const rows = await api.checkpoints(id, { limit: 20, offset: nextOffset });
      if (selectedRef.current === id) {
        setProgress(rows);
        setProgressOffset(nextOffset);
      }
    } catch {
      setError('Could not read these saved results.');
    }
  }
  const modelPicker = (
    <select
      aria-label="Dot model"
      value={providerId}
      disabled={busy || !!current?.live}
      onChange={(event) => setProviderId(event.target.value)}
    >
      <option value="" disabled>
        Choose a model
      </option>
      {providers
        .filter((provider) => provider.supportsTools)
        .map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.model} · {provider.displayName}
          </option>
        ))}
    </select>
  );
  const transition = (command: DotControl) =>
    current && operate(() => api.transition(current.dot.id, current.dot.revision, command));
  return (
    <section
      className="dots-pane"
      aria-label="Dots workspace"
      style={{ display: active ? 'flex' : 'none' }}
      inert={!active || undefined}
    >
      <header className="dots-heading">
        <div>
          <h1>{creating ? 'New Dot' : (current?.dot.name ?? 'Dots')}</h1>
          <p>Goals and progress that persist beyond a conversation.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            onSelect(undefined);
            setCreating(true);
            setError('');
          }}
          disabled={busy}
        >
          New Dot
        </button>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dots-scroll">
        {!!supervision?.items.length && (
          <details
            className="dot-result"
            aria-label="Dots needing review"
            data-supervision-sequence={supervision.sequence}
          >
            <summary>
              {supervision.items.length}
              {supervision.more ? '+' : ''}{' '}
              {supervision.items.length === 1 ? 'Dot needs' : 'Dots need'} review
            </summary>
            <p>
              Open a Dot to inspect its exact request. These reminders never approve or start work.
            </p>
            <div className="dot-inbox-actions">
              {supervision.items.map((item) => (
                <button
                  key={`${item.intentId}:${item.kind}`}
                  type="button"
                  onClick={() => onSelect(item.dotId)}
                >
                  Review Dot {known.current.get(item.dotId)?.name ?? item.dotId}:{' '}
                  {item.kind === 'uncertain' ? 'uncertain outcome' : 'approval required'}
                </button>
              ))}
            </div>
          </details>
        )}
        {creating ? (
          <form
            className="dot-create"
            aria-label="Create Dot"
            onSubmit={(event) => void create(event)}
          >
            <label>
              Name
              <input
                ref={nameInput}
                aria-label="Dot name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
                disabled={busy}
              />
            </label>
            <label>
              Long-term goal
              <textarea
                aria-label="Dot goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                maxLength={16384}
                rows={5}
                required
                disabled={busy}
                placeholder="What should this Dot work toward?"
              />
            </label>
            <label className="dot-checkbox">
              <input
                type="checkbox"
                checked={runFirst}
                onChange={(event) => setRunFirst(event.target.checked)}
                disabled={busy}
              />
              Run the first step after creating
            </label>
            {runFirst && (
              <div className="dot-model-row">
                {modelPicker}
                <button type="button" className="text-button" onClick={onSettings}>
                  Model settings
                </button>
              </div>
            )}
            <div className="dot-actions">
              <button
                type="submit"
                className="primary"
                disabled={busy || !name.trim() || !goal.trim() || (runFirst && !providerId)}
              >
                {busy ? 'Saving…' : runFirst ? 'Create and run' : 'Create Dot'}
              </button>
              <button type="button" onClick={() => setCreating(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        ) : selected ? (
          current ? (
            <>
              <section className="dot-goal">
                <div className="dot-status">
                  <span
                    className={`status-light ${current.dot.lifecycle === 'active' && unresolved ? 'incomplete' : current.dot.inFlightRunId ? (current.live ? 'working' : 'incomplete') : statusTone(current.dot.lifecycle)}`}
                    aria-hidden="true"
                  />
                  <span role="status" data-testid="dot-status">
                    {dotLabel(current)}
                  </span>
                </div>
                <h2>Goal</h2>
                <p>{current.dot.goal.text}</p>
              </section>
              <div className="dot-actions">
                {modelPicker}
                <button
                  type="button"
                  className="primary"
                  disabled={
                    unresolved ||
                    busy ||
                    !!current.dot.inFlightRunId ||
                    current.dot.lifecycle !== 'active' ||
                    !providerId
                  }
                  onClick={() =>
                    void operate(() => api.run(current.dot.id, current.dot.revision, providerId))
                  }
                >
                  Run next step
                </button>
                {(current.live ||
                  (current.dot.inFlightRunId &&
                    current.approvals?.some((intent) =>
                      ['pending', 'approved'].includes(intent.status),
                    ))) && (
                  <button type="button" disabled={busy} onClick={() => void stop()}>
                    Stop step
                  </button>
                )}
                {['active', 'paused'].includes(current.dot.lifecycle) && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void transition(current.dot.lifecycle === 'paused' ? 'resume' : 'pause')
                      }
                    >
                      {current.dot.lifecycle === 'paused' ? 'Resume Dot' : 'Pause Dot'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void transition('complete')}
                    >
                      Complete goal
                    </button>
                    <button type="button" disabled={busy} onClick={() => void transition('cancel')}>
                      Cancel goal
                    </button>
                  </>
                )}
                {current.dot.lifecycle !== 'archived' && (
                  <button type="button" disabled={busy} onClick={() => void transition('archive')}>
                    Archive Dot
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void operate(() => api.get(current.dot.id))}
                >
                  Refresh Dot
                </button>
              </div>
              <section className="dot-result" aria-label="Repeat research authorization">
                <details>
                  <summary>
                    Repeat research authorization
                    {current.policy && (
                      <span className="badge">
                        {current.policy.policy.status === 'revoked'
                          ? 'Revoked'
                          : now >= current.policy.policy.expiresAt
                            ? 'Expired'
                            : 'Active'}
                      </span>
                    )}
                  </summary>
                  {current.policy && (
                    <>
                      <p>
                        {current.policy.policy.status === 'revoked'
                          ? 'Revoked'
                          : now >= current.policy.policy.expiresAt
                            ? 'Expired'
                            : 'Authorized'}{' '}
                        · expires {new Date(current.policy.policy.expiresAt).toLocaleString()}
                      </p>
                      <Notes
                        items={current.policy.policy.queries.map(
                          (entry) => `${entry.query} · up to ${entry.maxResults} results`,
                        )}
                      />
                      <p>
                        Model: {current.policy.policy.provider.model}.{' '}
                        {current.policy.policy.allowDiscoveredPages
                          ? 'Page access is limited to addresses actually returned by these authorized searches.'
                          : 'Search only; no page-reading budget is authorized.'}
                      </p>
                      <p>
                        {current.policy.usage.runs} / {current.policy.policy.limits.maxRuns} Runs ·{' '}
                        {current.policy.usage.searches} / {current.policy.policy.limits.maxSearches}{' '}
                        searches · {current.policy.usage.fetches} /{' '}
                        {current.policy.policy.limits.maxFetches} pages
                      </p>
                      <p>
                        {(current.policy.usage.reservedResponseBytes / (1024 * 1024)).toFixed(2)} /{' '}
                        {(current.policy.policy.limits.maxResponseBytes / (1024 * 1024)).toFixed(2)}{' '}
                        MiB body reserved · {current.policy.usage.reservedModelTurns} /{' '}
                        {current.policy.policy.limits.maxModelTurns} model turns reserved
                      </p>
                      {current.policy.policy.status === 'active' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void operate(() =>
                              api.revokeResearch(
                                current.dot.id,
                                current.policy?.policy.id ?? '',
                                current.policy?.policy.revision ?? -1,
                              ),
                            )
                          }
                        >
                          Revoke research authorization
                        </button>
                      )}
                    </>
                  )}
                  {(!current.policy || current.policy.policy.status === 'revoked') && (
                    <form
                      className="dot-policy-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void operate(() =>
                          api.authorizeResearch(current.dot.id, current.dot.revision, providerId, {
                            queries: policyQueries
                              .split('\n')
                              .map((query) => query.trim())
                              .filter(Boolean)
                              .map((query) => ({ query, maxResults: 5 })),
                            allowDiscoveredPages: allowPages,
                            expiresAt: Date.now() + policyHours * 60 * 60 * 1000,
                            limits: {
                              maxRuns: policyRuns,
                              maxSearches: policySearches,
                              maxFetches: allowPages ? policyFetches : 0,
                              maxResponseBytes: policyMiB * 1024 * 1024,
                              maxModelTurns: policyRuns * 8,
                              maxModelRequestBytes: policyRuns * 8 * 96 * 1024,
                            },
                          }),
                        );
                      }}
                    >
                      <label>
                        Exact queries, one per line
                        <textarea
                          aria-label="Authorized research queries"
                          value={policyQueries}
                          onChange={(event) => setPolicyQueries(event.target.value)}
                          maxLength={6100}
                          required
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={allowPages}
                          onChange={(event) => setAllowPages(event.target.checked)}
                        />
                        Read pages actually discovered by these searches
                      </label>
                      <label>
                        Maximum Runs
                        <input
                          aria-label="Authorized Runs"
                          type="number"
                          min={1}
                          max={100}
                          value={policyRuns}
                          onChange={(event) => setPolicyRuns(Number(event.target.value))}
                          required
                        />
                      </label>
                      <label>
                        Maximum searches
                        <input
                          aria-label="Authorized searches"
                          type="number"
                          min={1}
                          max={400}
                          value={policySearches}
                          onChange={(event) => setPolicySearches(Number(event.target.value))}
                          required
                        />
                      </label>
                      <label>
                        Maximum pages
                        <input
                          aria-label="Authorized pages"
                          type="number"
                          min={0}
                          max={400}
                          value={policyFetches}
                          onChange={(event) => setPolicyFetches(Number(event.target.value))}
                          disabled={!allowPages}
                          required
                        />
                      </label>
                      <label>
                        Total response body budget (MiB)
                        <input
                          aria-label="Authorized response MiB"
                          type="number"
                          min={1}
                          max={512}
                          value={policyMiB}
                          onChange={(event) => setPolicyMiB(Number(event.target.value))}
                          required
                        />
                      </label>
                      <label>
                        Expires after hours
                        <input
                          aria-label="Research authorization hours"
                          type="number"
                          min={1}
                          max={168}
                          value={policyHours}
                          onChange={(event) => setPolicyHours(Number(event.target.value))}
                          required
                        />
                      </label>
                      <p>
                        This authorizes up to five results per exact query and only the discovered
                        pages above. Each Run reserves eight model turns and 768 KiB of core input;
                        a search reserves 256 KiB and a page 1 MiB. Reservations are not refunded
                        after cancellation or restart. File and shell actions are excluded.
                      </p>
                      <button
                        type="submit"
                        className="primary"
                        disabled={
                          busy ||
                          !!current.dot.inFlightRunId ||
                          !webSearchReady ||
                          !providerId ||
                          current.dot.lifecycle !== 'active'
                        }
                      >
                        Authorize bounded research
                      </button>
                    </form>
                  )}
                </details>
              </section>
              <section className="dot-result" aria-label="Dot wake schedule">
                <h2>Next wake</h2>
                <p>
                  Schedule one bounded step using the current authorization and remaining budget.
                  Keep Prospero open to run on time. After Quit, a valid overdue wake can run once
                  when you reopen the app.
                </p>
                {current.wakes?.some((wake) => wake.status === 'scheduled') ? (
                  current.wakes
                    .filter((wake) => wake.status === 'scheduled')
                    .map((wake) => (
                      <div key={wake.id}>
                        <p>
                          Scheduled for{' '}
                          <time dateTime={new Date(wake.dueAt).toISOString()}>
                            {new Date(wake.dueAt).toLocaleString()}
                          </time>
                          . It waits while another task is working or this Dot needs approval.
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void operate(() =>
                              api.cancelWake(current.dot.id, wake.id, wake.revision),
                            )
                          }
                        >
                          Cancel wake
                        </button>
                      </div>
                    ))
                ) : current.dot.lifecycle === 'active' &&
                  current.policy?.policy.status === 'active' &&
                  now < current.policy.policy.expiresAt ? (
                  <form
                    className="dot-policy-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const policy = current.policy?.policy;
                      if (policy)
                        void operate(() =>
                          api.scheduleWake(
                            current.dot.id,
                            current.dot.revision,
                            policy.id,
                            new Date(wakeTime).getTime(),
                          ),
                        );
                    }}
                  >
                    <label>
                      Wake at (local time)
                      <input
                        aria-label="Dot wake time"
                        type="datetime-local"
                        step="1"
                        value={wakeTime}
                        onChange={(event) => setWakeTime(event.target.value)}
                        required
                      />
                    </label>
                    <button type="submit" className="primary" disabled={busy || !wakeTime}>
                      Schedule one wake
                    </button>
                  </form>
                ) : (
                  <p className="muted">Authorize bounded research to schedule the next step.</p>
                )}
                {!!current.wakes?.some((wake) => wake.status !== 'scheduled') && (
                  <details>
                    <summary>Wake history</summary>
                    {current.wakes
                      .filter((wake) => wake.status !== 'scheduled')
                      .map((wake) => (
                        <p key={wake.id}>
                          {new Date(wake.dueAt).toLocaleString()} · {wake.status}
                          {wake.reason ? ` (${wake.reason})` : ''}
                          {wake.runId ? ` · Run ${wake.runId.slice(0, 8)}` : ''}
                        </p>
                      ))}
                  </details>
                )}
              </section>
              {current.approvals?.map((intent) => (
                <DotRequestRecord
                  key={intent.id}
                  intent={intent}
                  dot={current.dot}
                  live={current.live}
                  busy={busy}
                  now={now}
                  api={api}
                  operate={operate}
                  setError={setError}
                />
              ))}
              {current.live && (
                <section className="dot-result" aria-label="Current Dot work">
                  <h2>{elapsedLabel(current.live.startedAt, now, current.live.worked)}</h2>
                  <p>{current.live.streamingText || 'Preparing this bounded step…'}</p>
                </section>
              )}
              {current.attention && (
                <p className="inline-error" role="alert">
                  {current.attention === 'persistence'
                    ? 'The Run could not be saved safely. Inspect its state before starting more work.'
                    : current.attention === 'uncertain'
                      ? 'A research request has an uncertain outcome. Inspect it before continuing; it has not been retried.'
                      : current.attention === 'initialization'
                        ? 'The model or research connection could not be prepared. Review this step before continuing.'
                        : 'The model ended without saving a continuation. No new progress was committed.'}
                </p>
              )}
              {current.checkpoint && (
                <section className="dot-result" aria-label="Latest Dot result">
                  <h2>Latest result</h2>
                  <p>{current.checkpoint.summary}</p>
                  <h3>Completed notes</h3>
                  <Notes items={current.checkpoint.completed} />
                  <h3>Next steps</h3>
                  <Notes items={current.checkpoint.next} />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void bridge
                        .copyText(current.checkpoint?.summary ?? '')
                        .catch(() => setError('Could not copy this result.'))
                    }
                  >
                    Copy result
                  </button>
                </section>
              )}
              <details
                className="dot-history"
                aria-label="Dot request history"
                onToggle={(event) => {
                  setShowRequests(event.currentTarget.open);
                  if (event.currentTarget.open) void loadRequests();
                  else requestRead.current++;
                }}
              >
                <summary>All request history</summary>
                {showRequests && requestPage && (
                  <>
                    <p>
                      {requestPage.total} requests across all Runs. Historical requests are
                      read-only.
                    </p>
                    {requestPage.requests.map((intent) => (
                      <DotRequestRecord
                        key={intent.id}
                        intent={intent}
                        dot={current.dot}
                        busy={busy}
                        now={now}
                        api={api}
                        operate={operate}
                        setError={setError}
                        readOnly
                      />
                    ))}
                    <div className="dot-actions">
                      <button
                        type="button"
                        disabled={requestPage.offset === 0}
                        onClick={() => void loadRequests(Math.max(0, requestPage.offset - 20))}
                      >
                        Previous requests
                      </button>
                      <button
                        type="button"
                        disabled={
                          requestPage.offset + requestPage.requests.length >= requestPage.total
                        }
                        onClick={() => void loadRequests(requestPage.offset + 20)}
                      >
                        Next requests
                      </button>
                      <button type="button" onClick={() => void loadRequests(requestPage.offset)}>
                        Refresh request history
                      </button>
                    </div>
                  </>
                )}
              </details>
              <DotContextInspector
                key={current.dot.id}
                api={api}
                dotId={current.dot.id}
                revision={current.dot.revision}
              />
              <section className="dot-history" aria-label="Dot Run history">
                <h2>
                  Run history <span className="muted">{current.runCount} total</span>
                </h2>
                {(showHistory ? history : current.runs).map((run) => (
                  <div className="dot-run-row" key={run.id}>
                    <span className={`status-light ${statusTone(run.status)}`} aria-hidden="true" />
                    <span>{runLabel(run)}</span>
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                    </time>
                    <code>{run.id.slice(0, 8)}</code>
                  </div>
                ))}
                {!current.runCount && <p className="muted">No steps have run yet.</p>}
                {!showHistory && current.runCount > 10 && (
                  <button type="button" onClick={() => void loadHistory()}>
                    View full Run history
                  </button>
                )}
                {showHistory && (
                  <div className="dot-actions">
                    <button
                      type="button"
                      disabled={historyOffset === 0}
                      onClick={() => void loadHistory(Math.max(0, historyOffset - 20))}
                    >
                      Previous Runs
                    </button>
                    <button
                      type="button"
                      disabled={history.length < 20}
                      onClick={() => void loadHistory(historyOffset + 20)}
                    >
                      Next Runs
                    </button>
                    <button type="button" onClick={() => setShowHistory(false)}>
                      Latest Runs
                    </button>
                  </div>
                )}
              </section>
              <details
                className="dot-history"
                onToggle={(event) => {
                  if (event.currentTarget.open) void loadProgress();
                }}
              >
                <summary>Saved progress history</summary>
                {progress.map((record) => (
                  <details className="dot-progress-record" key={record.runId}>
                    <summary>
                      Step {record.revision} · {new Date(record.updatedAt).toLocaleString()}
                    </summary>
                    <p>{record.summary}</p>
                    <Notes items={record.next} />
                  </details>
                ))}
                <div className="dot-actions">
                  <button
                    type="button"
                    disabled={progressOffset === 0}
                    onClick={() => void loadProgress(Math.max(0, progressOffset - 20))}
                  >
                    Previous results
                  </button>
                  <button
                    type="button"
                    disabled={progress.length < 20}
                    onClick={() => void loadProgress(progressOffset + 20)}
                  >
                    Next results
                  </button>
                </div>
              </details>
            </>
          ) : (
            <p role="status">Restoring Dot…</p>
          )
        ) : (
          <section className="dot-welcome">
            <h2>Give a Dot a long-term goal.</h2>
            <p>
              Each bounded step saves its result and next steps, so the next Run can continue from
              durable progress.
            </p>
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              Create a Dot
            </button>
            {loading && <p role="status">Loading Dots…</p>}
            {hasMore && (
              <button type="button" onClick={() => void loadMore()}>
                Load more Dots
              </button>
            )}
          </section>
        )}
        <p className="dot-capability-note">
          {webSearchReady
            ? current?.policy?.policy.status === 'active'
              ? now >= current.policy.policy.expiresAt
                ? 'The research authorization has expired. Revoke or replace it before continuing.'
                : 'Bounded research is authorized. Matching requests can run automatically within its remaining limits; other requests need approval.'
              : 'Web research is enabled. Each request appears for approval.'
            : 'Web research is off. Steps can draft notes only; configure Web Search in Settings to read public sources.'}{' '}
          One-shot wakes retain their authorization and budget across restarts. Pausing or stopping
          a Dot cancels its pending wake.
        </p>
      </div>
    </section>
  );
}
