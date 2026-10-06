/** Ephemeral UI drafts stay separate from saved conversations and model context. */
export class ComposerDrafts {
  private values = new Map<string, string>();
  private listeners = new Map<string, Set<() => void>>();
  get(key: string): string {
    return this.values.get(key) ?? '';
  }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  set(key: string, text: string) {
    if (this.get(key) === text) return;
    if (text) this.values.set(key, text);
    else this.values.delete(key);
    this.listeners.get(key)?.forEach((listener) => {
      listener();
    });
  }
  transferWelcome(key: string) {
    this.set(key, this.get('welcome'));
    this.set('welcome', '');
  }
  clearSubmitted(key: string, submitted: string) {
    // A late acknowledgement must not discard text typed while the send was pending.
    if (this.get(key) === submitted) this.set(key, '');
  }
}
