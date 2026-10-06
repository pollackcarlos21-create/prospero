import {
  CredentialBindingError,
  SignalCredentialVault,
  type CredentialCrypto,
} from '../../apps/desktop/src/main/credential-storage';
import type { CredentialVault } from '../../apps/desktop/src/main/service';
import { UserError } from '../../apps/desktop/src/main/validation';
import type { ProsperoStore } from '../../packages/persistence/src';
import { normalizeBaseUrl } from '../../packages/providers/src';
import { BRAVE_SEARCH_ENDPOINT } from '../../packages/web/src';
import type { LiveCredentialSelectionDescriptor } from './live-credential-selection';

const prefix = 'prospero-credential:v1:';
const envelopeKeys = ['version', 'id', 'endpoint', 'apiKey'];
const descriptorKeys = [
  'providerId',
  'baseUrl',
  'model',
  'hasBrave',
  'selectionSha256',
  'expiresAt',
  'binding',
];
function invalidReference(): never {
  throw new UserError('The reviewed credential reference is invalid.');
}
function reference(value: LiveCredentialSelectionDescriptor) {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== descriptorKeys.length ||
      Object.keys(value).some((key) => !descriptorKeys.includes(key)) ||
      typeof value.providerId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(value.providerId) ||
      value.providerId === 'brave-search' ||
      typeof value.baseUrl !== 'string' ||
      value.baseUrl.length > 2048 ||
      normalizeBaseUrl(value.baseUrl) !== value.baseUrl ||
      typeof value.model !== 'string' ||
      !value.model.trim() ||
      value.model.length > 200 ||
      typeof value.hasBrave !== 'boolean' ||
      !/^[a-f0-9]{64}$/.test(value.selectionSha256) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 ||
      value.binding !== 'native-envelope-check-required'
    )
      invalidReference();
    return Object.freeze({ ...value });
  } catch {
    return invalidReference();
  }
}
function strictEnvelope(value: unknown, id: string, endpoint: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !['result', 'shouldReEncrypt'].includes(key))
  )
    throw new CredentialBindingError();
  const decrypted = value as { result: string; shouldReEncrypt: boolean };
  if (
    typeof decrypted.result !== 'string' ||
    Buffer.byteLength(decrypted.result) > 65536 ||
    !decrypted.result.startsWith(prefix) ||
    typeof decrypted.shouldReEncrypt !== 'boolean'
  )
    throw new CredentialBindingError();
  try {
    const binding = JSON.parse(decrypted.result.slice(prefix.length)) as Record<string, unknown>;
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      Object.keys(binding).length !== envelopeKeys.length ||
      Object.keys(binding).some((key) => !envelopeKeys.includes(key)) ||
      binding.version !== 1 ||
      binding.id !== id ||
      binding.endpoint !== endpoint ||
      typeof binding.apiKey !== 'string' ||
      !binding.apiKey ||
      binding.apiKey.length > 8192 ||
      /[\r\n\0]/.test(binding.apiKey)
    )
      throw new CredentialBindingError();
  } catch {
    throw new CredentialBindingError();
  }
  // Only the existing main-owned vault receives this native result. No separate key is exported.
  return decrypted;
}
async function nativeResult<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await operation();
  } catch {
    signal?.throwIfAborted();
    throw new UserError('The secure credential operation failed.');
  }
}

/** Acceptance-only strict reference reader. Real native ports must be bound by an Electron main
 * owner; providing this interface or a descriptor does not prove OS identity or human consent.
 * The service still owns logical timeout, cancellation and actual native settlement reservations.
 */
export function createLiveCredentialReferenceVault(options: {
  store: ProsperoStore;
  descriptor: LiveCredentialSelectionDescriptor;
  crypto: CredentialCrypto;
  platform: string;
}): CredentialVault {
  const selected = reference(options.descriptor);
  const store = options.store;
  const platform = options.platform;
  const crypto = options.crypto;
  if (
    !crypto ||
    !['darwin', 'linux', 'win32'].includes(platform) ||
    [
      'getSelectedStorageBackend',
      'isAsyncEncryptionAvailable',
      'encryptStringAsync',
      'decryptStringAsync',
    ].some((key) => typeof crypto[key as keyof CredentialCrypto] !== 'function')
  )
    invalidReference();
  // Capture the reviewed native port methods so changing the options cannot replace them later.
  const backend = crypto.getSelectedStorageBackend.bind(crypto);
  const available = crypto.isAsyncEncryptionAvailable.bind(crypto);
  const encrypt = crypto.encryptStringAsync.bind(crypto);
  const decrypt = crypto.decryptStringAsync.bind(crypto);
  return Object.freeze({
    async put() {
      throw new UserError('Reviewed live credential references are read-only.');
    },
    async get(id: string, signal?: AbortSignal, endpoint?: string) {
      signal?.throwIfAborted();
      const expected =
        id === selected.providerId
          ? selected.baseUrl
          : id === 'brave-search' && selected.hasBrave
            ? BRAVE_SEARCH_ENDPOINT
            : undefined;
      if (!expected || endpoint !== expected) throw new CredentialBindingError();
      const guarded: CredentialCrypto = {
        getSelectedStorageBackend() {
          try {
            return backend();
          } catch {
            throw new UserError('The secure credential operation failed.');
          }
        },
        isAsyncEncryptionAvailable: () => nativeResult(available, signal),
        encryptStringAsync: (plaintext) => nativeResult(() => encrypt(plaintext), signal),
        async decryptStringAsync(bytes) {
          const decrypted = await nativeResult(() => decrypt(bytes), signal);
          signal?.throwIfAborted();
          try {
            return strictEnvelope(decrypted, id, expected);
          } catch {
            throw new CredentialBindingError();
          }
        },
      };
      return new SignalCredentialVault(store, guarded, platform).get(id, signal, expected);
    },
  });
}
