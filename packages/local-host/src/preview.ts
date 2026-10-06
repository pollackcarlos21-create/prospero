import { createTwoFilesPatch } from 'diff';
import { throwIfAborted } from './limits';

export async function previewDiff(
  target: string,
  before: string,
  after: string,
  exists: boolean,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Operation cancelled.', 'AbortError'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    createTwoFilesPatch(
      target,
      target,
      before,
      after,
      exists ? 'existing' : 'new file',
      'proposed',
      {
        context: 3,
        timeout: 500,
        maxEditLength: 4_000,
        callback(patch) {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) {
            onAbort();
            return;
          }
          if (patch === undefined)
            reject(new Error('Diff preview exceeds complexity limits. Use a smaller change.'));
          else resolve(patch);
        },
      },
    );
  });
}
