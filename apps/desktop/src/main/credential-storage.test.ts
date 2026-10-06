import { expect, test } from 'bun:test';
import { ProsperoStore } from '@prospero/persistence';
import {
  CredentialBindingError,
  SignalCredentialVault,
  type CredentialCrypto,
} from './credential-storage';

const endpoint = 'https://offline.example/v1';
function storedCipher(store: ProsperoStore, id: string) {
  const ciphertext = store.encryptedCredential(id);
  if (!ciphertext) throw new Error('Missing offline credential fixture.');
  return Buffer.from(ciphertext);
}
// An offline native-port fake; these markers are not production encryption or credentials.
function cryptoPort(overrides: Partial<CredentialCrypto> = {}): CredentialCrypto {
  return {
    getSelectedStorageBackend: () => 'keychain',
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plaintext) => Buffer.from(plaintext, 'utf8'),
    decryptStringAsync: async (ciphertext) => ({
      result: ciphertext.toString('utf8'),
      shouldReEncrypt: false,
    }),
    ...overrides,
  };
}
async function turn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('saved ciphertext carries durable id/endpoint binding and legacy read binds before returning the key', async () => {
  const store = new ProsperoStore(':memory:');
  const vault = new SignalCredentialVault(store, cryptoPort(), 'darwin');
  try {
    await vault.put('model', 'OFFLINE_FIRST', undefined, endpoint);
    expect(await vault.get('model', undefined, endpoint)).toBe('OFFLINE_FIRST');
    await expect(vault.get('model', undefined, 'https://other.example/v1')).rejects.toBeInstanceOf(
      CredentialBindingError,
    );
    store.saveEncryptedCredential('other-id', storedCipher(store, 'model'));
    await expect(vault.get('other-id', undefined, endpoint)).rejects.toBeInstanceOf(
      CredentialBindingError,
    );
    store.saveEncryptedCredential('legacy', Buffer.from('OFFLINE_LEGACY'));
    expect(await vault.get('legacy', undefined, endpoint)).toBe('OFFLINE_LEGACY');
    expect(storedCipher(store, 'legacy').toString()).toContain('prospero-credential:v1:');
    await expect(vault.get('legacy', undefined, 'https://other.example/v1')).rejects.toBeInstanceOf(
      CredentialBindingError,
    );
    await expect(vault.put('unbound', 'OFFLINE', undefined)).rejects.toBeInstanceOf(
      CredentialBindingError,
    );
    store.saveEncryptedCredential(
      'invalid',
      Buffer.from('prospero-credential:v1:bad private marker'),
    );
    await expect(vault.get('invalid', undefined, endpoint)).rejects.toThrow('Re-enter the API key');
  } finally {
    store.close();
  }
});

test('cancelled availability check invokes no later encryption and cannot save a late key', async () => {
  const store = new ProsperoStore(':memory:');
  let release: (value: boolean) => void = () => {};
  let encryptions = 0;
  const vault = new SignalCredentialVault(
    store,
    cryptoPort({
      isAsyncEncryptionAvailable: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      encryptStringAsync: async () => {
        encryptions++;
        return Buffer.from('late');
      },
    }),
    'darwin',
  );
  try {
    const controller = new AbortController();
    const pending = vault.put('model', 'OFFLINE', controller.signal, endpoint);
    controller.abort();
    release(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(encryptions).toBe(0);
    expect(store.encryptedCredential('model')).toBeUndefined();
  } finally {
    store.close();
  }
});

test('late encryption after cancellation cannot overwrite the durable credential', async () => {
  const store = new ProsperoStore(':memory:');
  const original = Buffer.from('OFFLINE_ORIGINAL');
  store.saveEncryptedCredential('model', original);
  let release: (value: Buffer) => void = () => {};
  const vault = new SignalCredentialVault(
    store,
    cryptoPort({
      encryptStringAsync: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    'darwin',
  );
  try {
    const controller = new AbortController();
    const pending = vault.put('model', 'OFFLINE_NEW', controller.signal, endpoint);
    await turn();
    controller.abort();
    release(Buffer.from('OFFLINE_LATE_CIPHER'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(storedCipher(store, 'model')).toEqual(original);
  } finally {
    store.close();
  }
});

test('late decrypt cannot return a key or trigger credential migration after cancellation', async () => {
  const store = new ProsperoStore(':memory:');
  const original = Buffer.from('OFFLINE_ORIGINAL');
  store.saveEncryptedCredential('model', original);
  let release: (value: { result: string; shouldReEncrypt: boolean }) => void = () => {};
  let encryptions = 0;
  const vault = new SignalCredentialVault(
    store,
    cryptoPort({
      decryptStringAsync: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      encryptStringAsync: async () => {
        encryptions++;
        return Buffer.from('replacement');
      },
    }),
    'darwin',
  );
  try {
    const controller = new AbortController();
    const pending = vault.get('model', controller.signal, endpoint);
    await turn();
    controller.abort();
    release({ result: 'OFFLINE_LATE_KEY', shouldReEncrypt: true });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(encryptions).toBe(0);
    expect(storedCipher(store, 'model')).toEqual(original);
  } finally {
    store.close();
  }
});

test('cancelled legacy migration preserves old ciphertext and rejects the late key', async () => {
  const store = new ProsperoStore(':memory:');
  const original = Buffer.from('OFFLINE_LEGACY');
  store.saveEncryptedCredential('model', original);
  let release: (value: Buffer) => void = () => {};
  const vault = new SignalCredentialVault(
    store,
    cryptoPort({
      encryptStringAsync: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    'darwin',
  );
  try {
    const controller = new AbortController();
    const pending = vault.get('model', controller.signal, endpoint);
    await turn();
    controller.abort();
    release(Buffer.from('OFFLINE_LATE_BOUND_CIPHER'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(storedCipher(store, 'model')).toEqual(original);
  } finally {
    store.close();
  }
});

test('unavailable or plaintext native backends fail closed without writing', async () => {
  const store = new ProsperoStore(':memory:');
  try {
    await expect(
      new SignalCredentialVault(
        store,
        cryptoPort({ isAsyncEncryptionAvailable: async () => false }),
        'darwin',
      ).put('model', 'OFFLINE', undefined, endpoint),
    ).rejects.toThrow('unavailable');
    await expect(
      new SignalCredentialVault(
        store,
        cryptoPort({ getSelectedStorageBackend: () => 'basic_text' }),
        'linux',
      ).put('model', 'OFFLINE', undefined, endpoint),
    ).rejects.toThrow('secure OS');
    expect(store.encryptedCredential('model')).toBeUndefined();
  } finally {
    store.close();
  }
});
