import { InitializationTimeout, runInitialization } from './task-initialization';
import { UserError } from './validation';

export class CredentialOperationTimeout extends UserError {
  constructor() {
    super('Secure credential operation timed out. Unlock the OS credential store and try again.');
  }
}

/** The logical wait is bounded; the OS operation and its reservation settle independently. */
export function startCredentialOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs = 30_000,
): { result: Promise<T>; settled: Promise<void> } {
  let started = false;
  let finishNative = () => {};
  const settled = new Promise<void>((resolve) => {
    finishNative = resolve;
  });
  const result = runInitialization(
    (signal) => {
      started = true;
      return Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation(signal);
        })
        .then((value) => {
          signal.throwIfAborted();
          return value;
        })
        .finally(finishNative);
    },
    parent,
    timeoutMs,
  ).catch((error: unknown) => {
    if (error instanceof InitializationTimeout) throw new CredentialOperationTimeout();
    throw error;
  });
  // If cancellation wins before invocation, no native promise owns the reservation.
  void result.then(
    () => {
      if (!started) finishNative();
    },
    () => {
      if (!started) finishNative();
    },
  );
  return { result, settled };
}
