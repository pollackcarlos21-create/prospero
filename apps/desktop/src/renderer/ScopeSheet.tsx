import { useCallback, useState, useSyncExternalStore } from 'react';
import { activeStates, type ConversationStore } from './conversation-store';
import { useDialogFocus } from './dialog-focus';

export function ScopeSheet({
  id,
  store,
  onAdd,
  onRemove,
  onClose,
}: {
  id?: string;
  store: ConversationStore;
  onAdd: (mode: 'read' | 'write') => Promise<void>;
  onRemove: (scopeId: string) => Promise<void>;
  onClose: () => void;
}) {
  const subscribe = useCallback(
    (listener: () => void) => (id ? store.subscribe(id, listener) : () => {}),
    [id, store],
  );
  const snapshot = useCallback(() => (id ? store.get(id) : undefined), [id, store]);
  const conversation = useSyncExternalStore(subscribe, snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { ref, trap } = useDialogFocus();
  const active = activeStates.has(conversation?.state ?? '');
  async function change(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError('Could not update file access. Stop any running task and try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="scope-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="File scopes"
        ref={ref}
        onKeyDown={trap}
      >
        <header className="settings-heading">
          <h2>File access</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close file scopes"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="section-description">
          Choose exactly which folders this task can use. Read access does not allow changes.
          Writable folders still require an approved preview for every file change.
        </p>
        <div className="scope-choices">
          <button
            type="button"
            disabled={active || busy}
            onClick={() => void change(() => onAdd('read'))}
          >
            Add read folder
          </button>
          <button
            type="button"
            disabled={active || busy}
            onClick={() => void change(() => onAdd('write'))}
          >
            Add writable folder
          </button>
        </div>
        <section className="scope-list" aria-label="Selected file scopes">
          {!conversation?.scopes?.length && (
            <p className="muted">No explicit file scopes selected.</p>
          )}
          {conversation?.scopes?.map((scope) => (
            <div className="scope-row" key={scope.id}>
              <div>
                <strong>{scope.label}</strong>
                <span className="badge">
                  {scope.mode === 'write' ? 'Read & write' : 'Read only'}
                </span>
                <p>
                  <code>{scope.path}</code>
                </p>
                <span className="muted">
                  {scope.kind === 'directory' ? 'Folder' : 'Attached file'}
                </span>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={active || busy}
                aria-label={`Remove scope ${scope.label}`}
                onClick={() => void change(() => onRemove(scope.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </section>
        {active && <p className="muted">Stop this task before changing its file access.</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <p className="field-hint">
          Folders are selected with the macOS file picker. Access stays within each selected root.
        </p>
      </div>
    </div>
  );
}
