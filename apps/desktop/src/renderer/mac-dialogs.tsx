import { useId, useState } from 'react';
import { useDialogFocus } from './dialog-focus';

export interface PaletteCommand {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  run: () => void;
}
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const { ref, trap } = useDialogFocus();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const visible = commands.filter((command) =>
    `${command.label} ${command.detail ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  function choose(command?: PaletteCommand) {
    if (!command) return;
    onClose();
    command.run();
  }
  return (
    <div className="modal-backdrop palette-backdrop">
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={ref}
        onKeyDown={trap}
      >
        <div className="command-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={visible[selected] ? `${listId}-${selected}` : undefined}
            placeholder="Search commands…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((value) =>
                  Math.max(
                    0,
                    Math.min(visible.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)),
                  ),
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(visible[selected]);
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Close command palette"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="command-list" role="listbox" aria-label="Commands and tasks" id={listId}>
          {visible.length ? (
            visible.map((command, index) => (
              <button
                type="button"
                role="option"
                aria-selected={selected === index}
                id={`${listId}-${index}`}
                key={command.id}
                className={`command-item ${selected === index ? 'selected' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(command)}
              >
                <span>
                  <span>{command.label}</span>
                  {command.detail && <small>{command.detail}</small>}
                </span>
                {command.shortcut && <kbd>{command.shortcut}</kbd>}
              </button>
            ))
          ) : (
            <p className="command-empty" role="status">
              No matching commands or tasks
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
export function ConversationSheet({
  mode,
  initialTitle = '',
  onClose,
  onSubmit,
}: {
  mode: 'rename' | 'delete';
  initialTitle?: string;
  onClose: () => void;
  onSubmit: (title: string) => Promise<boolean>;
}) {
  const { ref, trap } = useDialogFocus();
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rename = mode === 'rename';
  async function submit() {
    if (busy || (rename && !title.trim())) return;
    setBusy(true);
    if (await onSubmit(title.trim())) onClose();
    else
      setError(
        rename
          ? 'Could not rename this task. Please try again.'
          : 'Could not delete this task. Stop it and try again.',
      );
    setBusy(false);
  }
  return (
    <div className="modal-backdrop">
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={rename ? 'Rename conversation' : 'Delete conversation'}
        ref={ref}
        onKeyDown={trap}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>{rename ? 'Rename task' : 'Delete this conversation?'}</h2>
          {rename ? (
            <label className="sheet-label">
              Task name
              <input
                aria-label="Conversation title"
                value={title}
                maxLength={120}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : (
            <p>This removes the saved conversation and its task history from this computer.</p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={rename ? 'primary' : 'danger-button'}
              disabled={busy || (rename && !title.trim())}
            >
              {busy ? 'Saving…' : rename ? 'Save name' : 'Delete conversation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
