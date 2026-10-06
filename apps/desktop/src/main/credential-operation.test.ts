import { expect, test } from 'bun:test';
import { CredentialOperationTimeout, startCredentialOperation } from './credential-operation';

test('deadline ends the logical wait while the uncancellable native reservation remains held', async () => {
  let release: (value: string) => void = () => {};
  let inner: AbortSignal | undefined;
  const pending = startCredentialOperation(
    (signal) => {
      inner = signal;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
    new AbortController().signal,
    5,
  );
  let settled = false;
  void pending.settled.then(() => {
    settled = true;
  });
  await expect(pending.result).rejects.toBeInstanceOf(CredentialOperationTimeout);
  expect(inner?.aborted).toBe(true);
  expect(settled).toBe(false);
  release('late native result');
  await pending.settled;
  expect(settled).toBe(true);
});

test('shutdown abort observes a late native rejection and does not release its reservation early', async () => {
  const parent = new AbortController();
  let reject: (error: unknown) => void = () => {};
  const pending = startCredentialOperation(
    () =>
      new Promise<string>((_resolve, failed) => {
        reject = failed;
      }),
    parent.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  let settled = false;
  void pending.settled.then(() => {
    settled = true;
  });
  parent.abort();
  await expect(pending.result).rejects.toMatchObject({ name: 'AbortError' });
  expect(settled).toBe(false);
  reject(new Error('late OS rejection'));
  await pending.settled;
  expect(settled).toBe(true);
});

test('already cancelled credentials invoke no native work and release their reservation', async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  const pending = startCredentialOperation(async () => ++calls, parent.signal);
  await expect(pending.result).rejects.toMatchObject({ name: 'AbortError' });
  await pending.settled;
  expect(calls).toBe(0);
  expect(await startCredentialOperation(async () => 42, new AbortController().signal).result).toBe(
    42,
  );
});
