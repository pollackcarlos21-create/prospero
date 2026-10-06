import { expect, test } from 'bun:test';
import { InitializationTimeout, runInitialization } from './task-initialization';

test('Stop settles initialization without an OS reply, and observes a late rejection', async () => {
  const controller = new AbortController();
  let lateReject: (reason: unknown) => void = () => {};
  let nativeSignal: AbortSignal | undefined;
  const pending = runInitialization((signal) => {
    nativeSignal = signal;
    return new Promise((_, reject) => {
      lateReject = reject;
    });
  }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(nativeSignal?.aborted).toBe(true);
  lateReject(new Error('late native failure'));
  await Promise.resolve();
});

test('one finite deadline includes every initialization step and discards late results', async () => {
  let release: (value: string) => void = () => {};
  let signal: AbortSignal | undefined;
  const controller = new AbortController();
  const pending = runInitialization(
    (inner) => {
      signal = inner;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
    controller.signal,
    5,
  );
  await expect(pending).rejects.toBeInstanceOf(InitializationTimeout);
  expect(signal?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(false);
  release('discarded credential');
  await Promise.resolve();
});

test('already stopped initialization never invokes native work; successful work is unchanged', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(runInitialization(async () => ++calls, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(calls).toBe(0);
  expect(await runInitialization(async () => 42, new AbortController().signal)).toBe(42);
});
