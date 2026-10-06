import { expect, test } from 'bun:test';
import {
  CredentialBindingError,
  type CredentialCrypto,
} from '../../apps/desktop/src/main/credential-storage';
import { startCredentialOperation } from '../../apps/desktop/src/main/credential-operation';
import { ProsperoStore } from '../../packages/persistence/src';
import { BRAVE_SEARCH_ENDPOINT } from '../../packages/web/src';
import { createLiveCredentialReferenceVault } from '../acceptance/live-credential-reference-vault';
import type { LiveCredentialSelectionDescriptor } from '../acceptance/live-credential-selection';

const endpoint = 'https://offline.example.test/v1';
const marker = 'OFFLINE_REFERENCE_KEY';
const original = Uint8Array.from([14, 35, 88]);
const replacement = Buffer.from([92, 28, 43]);
function envelope(id = 'selected', url = endpoint, key = marker) {
  return `prospero-credential:v1:${JSON.stringify({ version: 1, id, endpoint: url, apiKey: key })}`;
}
function descriptor(): LiveCredentialSelectionDescriptor {
  return {
    providerId: 'selected',
    baseUrl: endpoint,
    model: 'offline-model',
    hasBrave: true,
    selectionSha256: 'a'.repeat(64),
    expiresAt: Date.now() + 1000,
    binding: 'native-envelope-check-required',
  };
}
/** Fake native ports validate control flow only; these bytes are not OS encryption evidence. */
function fixture(overrides: Partial<CredentialCrypto> = {}, platform = 'darwin') {
  const store = new ProsperoStore(':memory:');
  store.saveEncryptedCredential('selected', original);
  store.saveEncryptedCredential('brave-search', Uint8Array.from([42, 11, 67]));
  const calls = { backend: 0, available: 0, decrypt: 0, encrypt: 0 };
  let result: unknown = { result: envelope(), shouldReEncrypt: false };
  const crypto: CredentialCrypto = {
    getSelectedStorageBackend() {
      calls.backend++;
      return 'keychain';
    },
    async isAsyncEncryptionAvailable() {
      calls.available++;
      return true;
    },
    async encryptStringAsync() {
      calls.encrypt++;
      return replacement;
    },
    async decryptStringAsync() {
      calls.decrypt++;
      return result as { result: string; shouldReEncrypt: boolean };
    },
    ...overrides,
  };
  const selected = { ...descriptor() };
  const options = { store, descriptor: selected, crypto, platform };
  const vault = createLiveCredentialReferenceVault(options);
  return {
    store,
    calls,
    selected,
    crypto,
    vault,
    options,
    result: (value: unknown) => {
      result = value;
    },
  };
}
async function turn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function bytes(store: ProsperoStore) {
  return [...(store.encryptedCredential('selected') ?? [])];
}

test('strict reference delegates one actual decrypt to the existing vault without a preflight get', async () => {
  const f = fixture();
  try {
    expect(Object.isFrozen(f.vault)).toBe(true);
    expect(f.calls).toEqual({ backend: 0, available: 0, decrypt: 0, encrypt: 0 });
    expect(await f.vault.get('selected', undefined, endpoint)).toBe(marker);
    expect(f.calls).toEqual({ backend: 0, available: 1, decrypt: 1, encrypt: 0 });
    expect(bytes(f.store)).toEqual([...original]);
  } finally {
    f.store.close();
  }
});

test('unreviewed identifiers, missing endpoint and endpoint aliases stop before native access', async () => {
  const f = fixture();
  try {
    for (const [id, url] of [
      ['unselected', endpoint],
      ['selected', undefined],
      ['selected', `${endpoint}/`],
      ['selected', 'https://other.example.test/v1'],
      ['brave-search', endpoint],
    ])
      await expect(f.vault.get(id as string, undefined, url)).rejects.toBeInstanceOf(
        CredentialBindingError,
      );
    f.selected.hasBrave = false;
    const withoutBrave = createLiveCredentialReferenceVault(f.options);
    await expect(
      withoutBrave.get('brave-search', undefined, BRAVE_SEARCH_ENDPOINT),
    ).rejects.toBeInstanceOf(CredentialBindingError);
    expect(f.calls).toEqual({ backend: 0, available: 0, decrypt: 0, encrypt: 0 });
    f.result({ result: envelope('brave-search', BRAVE_SEARCH_ENDPOINT), shouldReEncrypt: false });
    expect(await f.vault.get('brave-search', undefined, BRAVE_SEARCH_ENDPOINT)).toBe(marker);
    expect(f.calls.decrypt).toBe(1);
  } finally {
    f.store.close();
  }
});

test('read-only put cannot save or encrypt a replacement credential', async () => {
  const f = fixture();
  try {
    await expect(
      f.vault.put('selected', 'OFFLINE_REPLACEMENT', undefined, endpoint),
    ).rejects.toThrow('read-only');
    expect(f.calls.encrypt).toBe(0);
    expect(f.calls.available).toBe(0);
    expect(bytes(f.store)).toEqual([...original]);
  } finally {
    f.store.close();
  }
});

test('legacy plaintext is rejected before automatic rebind even when native crypto requests reencryption', async () => {
  const f = fixture();
  try {
    for (const shouldReEncrypt of [false, true]) {
      f.result({ result: 'OFFLINE_LEGACY_PRIVATE', shouldReEncrypt });
      await expect(f.vault.get('selected', undefined, endpoint)).rejects.toBeInstanceOf(
        CredentialBindingError,
      );
      expect(f.calls.encrypt).toBe(0);
      expect(bytes(f.store)).toEqual([...original]);
    }
    expect(f.calls.decrypt).toBe(2);
  } finally {
    f.store.close();
  }
});

test('mismatched, extra, malformed or oversized native envelope data cannot be forwarded', async () => {
  const f = fixture();
  try {
    const invalid = [
      { result: envelope('other'), shouldReEncrypt: false },
      { result: envelope('selected', 'https://other.example.test/v1'), shouldReEncrypt: true },
      { result: 'prospero-credential:v1:invalid private JSON', shouldReEncrypt: false },
      { result: 'prospero-credential:v1:null', shouldReEncrypt: false },
      { result: 'prospero-credential:v1:[]', shouldReEncrypt: false },
      {
        result: `prospero-credential:v1:${JSON.stringify({ version: 1, id: 'selected', endpoint, apiKey: marker, extra: 'forbidden' })}`,
        shouldReEncrypt: false,
      },
      { result: envelope('selected', endpoint, ''), shouldReEncrypt: false },
      { result: envelope('selected', endpoint, 'x'.repeat(8193)), shouldReEncrypt: false },
      { result: envelope('selected', endpoint, 'line\nbreak'), shouldReEncrypt: false },
      { result: `prospero-credential:v1:${'x'.repeat(65537)}`, shouldReEncrypt: false },
      { result: envelope(), shouldReEncrypt: 'true' },
      { result: envelope(), shouldReEncrypt: false, extra: 'forbidden' },
    ];
    for (const result of invalid) {
      f.result(result);
      try {
        await f.vault.get('selected', undefined, endpoint);
        throw new Error('accepted invalid envelope');
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialBindingError);
        expect((error as Error).message).not.toContain(marker);
      }
    }
    expect(f.calls.encrypt).toBe(0);
    expect(bytes(f.store)).toEqual([...original]);
  } finally {
    f.store.close();
  }
});

test('an already bound v1 envelope can use existing OS reencryption inside the isolated store', async () => {
  const f = fixture();
  try {
    f.result({ result: envelope(), shouldReEncrypt: true });
    expect(await f.vault.get('selected', undefined, endpoint)).toBe(marker);
    expect(f.calls.decrypt).toBe(1);
    expect(f.calls.encrypt).toBe(1);
    expect(bytes(f.store)).toEqual([...replacement]);
  } finally {
    f.store.close();
  }
});

test('descriptor and native-method mutation cannot widen the original reviewed reference', async () => {
  const f = fixture();
  try {
    f.selected.providerId = 'unselected';
    f.selected.baseUrl = 'https://other.example.test/v1';
    f.crypto.decryptStringAsync = async () => ({
      result: 'OFFLINE_UNREVIEWED',
      shouldReEncrypt: true,
    });
    f.options.crypto = { ...f.crypto, isAsyncEncryptionAvailable: async () => false };
    expect(await f.vault.get('selected', undefined, endpoint)).toBe(marker);
    await expect(f.vault.get('unselected', undefined, f.selected.baseUrl)).rejects.toBeInstanceOf(
      CredentialBindingError,
    );
    expect(f.calls.decrypt).toBe(1);
    expect(f.calls.encrypt).toBe(0);
  } finally {
    f.store.close();
  }
});

test('abort before invocation and late availability prevent subsequent decrypt or SQL activity', async () => {
  let release: (value: boolean) => void = () => {};
  let availability = 0;
  const f = fixture({
    isAsyncEncryptionAvailable: () => {
      availability++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const before = new AbortController();
    before.abort();
    await expect(f.vault.get('selected', before.signal, endpoint)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(availability).toBe(0);
    const late = new AbortController();
    const pending = f.vault.get('selected', late.signal, endpoint);
    late.abort();
    release(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls.decrypt).toBe(0);
    expect(f.calls.encrypt).toBe(0);
    expect(bytes(f.store)).toEqual([...original]);
  } finally {
    f.store.close();
  }
});

test('late decrypt after cancellation cannot forward key material or trigger native reencryption', async () => {
  let release: (value: { result: string; shouldReEncrypt: boolean }) => void = () => {};
  const f = fixture({
    decryptStringAsync: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    const controller = new AbortController();
    const pending = f.vault.get('selected', controller.signal, endpoint);
    await turn();
    controller.abort();
    release({ result: envelope(), shouldReEncrypt: true });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls.encrypt).toBe(0);
    expect(bytes(f.store)).toEqual([...original]);
  } finally {
    f.store.close();
  }
});

test('logical timeout preserves the native settlement promise and suppresses late work after store close', async () => {
  let release: (value: boolean) => void = () => {};
  const f = fixture({
    isAsyncEncryptionAvailable: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const operation = startCredentialOperation(
    (signal) => f.vault.get('selected', signal, endpoint),
    new AbortController().signal,
    10,
  );
  let settled = false;
  void operation.settled.then(() => {
    settled = true;
  });
  await expect(operation.result).rejects.toThrow('timed out');
  expect(settled).toBe(false);
  f.store.close();
  release(true);
  await operation.settled;
  expect(settled).toBe(true);
  expect(f.calls.decrypt).toBe(0);
  expect(f.calls.encrypt).toBe(0);
});

test('OS availability and plaintext backend failures remain fail-closed without crypto fallback', async () => {
  const unavailable = fixture({ isAsyncEncryptionAvailable: async () => false });
  const plaintext = fixture({ getSelectedStorageBackend: () => 'basic_text' }, 'linux');
  try {
    await expect(unavailable.vault.get('selected', undefined, endpoint)).rejects.toThrow(
      'unavailable',
    );
    await expect(plaintext.vault.get('selected', undefined, endpoint)).rejects.toThrow('secure OS');
    expect(unavailable.calls.decrypt).toBe(0);
    expect(plaintext.calls.available).toBe(0);
    expect(plaintext.calls.decrypt).toBe(0);
    expect(plaintext.calls.encrypt).toBe(0);
  } finally {
    unavailable.store.close();
    plaintext.store.close();
  }
});

test('native-port errors and malformed getters do not expose private results in public errors', async () => {
  for (const overrides of [
    {
      isAsyncEncryptionAvailable: async () => {
        throw new Error(marker);
      },
    },
    {
      decryptStringAsync: async () => {
        throw new Error(marker);
      },
    },
    {
      decryptStringAsync: async () => ({
        get result(): string {
          throw new Error(marker);
        },
        shouldReEncrypt: false,
      }),
    },
  ]) {
    const f = fixture(overrides);
    try {
      await expect(f.vault.get('selected', undefined, endpoint)).rejects.not.toThrow(marker);
      expect(f.calls.encrypt).toBe(0);
      expect(bytes(f.store)).toEqual([...original]);
    } finally {
      f.store.close();
    }
  }
});

test('missing ciphertext returns unavailable rather than native authentication success', async () => {
  const f = fixture();
  try {
    f.store.deleteCredential('selected');
    expect(await f.vault.get('selected', undefined, endpoint)).toBeUndefined();
    expect(f.calls.available).toBe(0);
    expect(f.calls.decrypt).toBe(0);
  } finally {
    f.store.close();
  }
});

test('unsupported descriptor or platform is rejected at construction with zero native invocation', () => {
  const f = fixture();
  try {
    for (const patch of [
      { binding: 'legacy' },
      { providerId: 'brave-search' },
      { selectionSha256: 'invalid' },
      { baseUrl: `${endpoint}/` },
      { model: '' },
      { hasBrave: 'yes' },
      { extra: 'forbidden' },
    ])
      expect(() =>
        createLiveCredentialReferenceVault({
          ...f.options,
          descriptor: { ...descriptor(), ...patch } as LiveCredentialSelectionDescriptor,
        }),
      ).toThrow('reference');
    expect(() => createLiveCredentialReferenceVault({ ...f.options, platform: 'unknown' })).toThrow(
      'reference',
    );
    expect(f.calls).toEqual({ backend: 0, available: 0, decrypt: 0, encrypt: 0 });
  } finally {
    f.store.close();
  }
});
