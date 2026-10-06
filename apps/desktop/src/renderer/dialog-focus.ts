import { useEffect, useRef } from 'react';

const focusSelector =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** Keep keyboard focus in the active sheet and restore its invoker when it closes. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[autofocus], input, button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  function trap(event: React.KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const focusable = [...(ref.current?.querySelectorAll<HTMLElement>(focusSelector) ?? [])].filter(
      (element) => !element.closest('[hidden], [inert]'),
    );
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return { ref, trap };
}
