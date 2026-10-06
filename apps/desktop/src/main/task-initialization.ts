export class InitializationTimeout extends Error {
  constructor() {
    super('Task initialization timed out. Unlock secure credential storage and try again.');
  }
}

/** Stop waiting on native work that cannot itself be cancelled; ignore all late results. */
export function runInitialization<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30_000) : 30_000;
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', stopped);
    };
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const stopped = () => {
      controller.abort();
      finish({ error: new DOMException('Task stopped.', 'AbortError') });
    };
    parent.addEventListener('abort', stopped, { once: true });
    if (parent.aborted) return stopped();
    timer = setTimeout(() => {
      controller.abort();
      finish({ error: new InitializationTimeout() });
    }, timeout);
    // Observe both branches if an OS operation resolves/rejects after cancellation.
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
  });
}
