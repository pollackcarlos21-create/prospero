import type { ProsperoStore } from '@prospero/persistence';
import type { CredentialVault } from './service';
import { UserError } from './validation';

const envelopePrefix = 'prospero-credential:v1:';
export class CredentialBindingError extends UserError {
  constructor() {
    super('This saved credential does not match its provider endpoint. Re-enter the API key.');
  }
}
function envelope(id: string, endpoint: string | undefined, apiKey: string) {
  if (!endpoint) throw new CredentialBindingError();
  return envelopePrefix + JSON.stringify({ version: 1, id, endpoint, apiKey });
}
function boundKey(value: string, id: string, endpoint: string | undefined) {
  if (!endpoint) throw new CredentialBindingError();
  if (!value.startsWith(envelopePrefix)) return { apiKey: value, legacy: true };
  try {
    const parsed: unknown = JSON.parse(value.slice(envelopePrefix.length));
    if (!parsed || typeof parsed !== 'object') throw new CredentialBindingError();
    const binding = parsed as Record<string, unknown>;
    if (
      binding.version !== 1 ||
      binding.id !== id ||
      binding.endpoint !== endpoint ||
      typeof binding.apiKey !== 'string'
    )
      throw new CredentialBindingError();
    return { apiKey: binding.apiKey, legacy: false };
  } catch {
    throw new CredentialBindingError();
  }
}

/** Main-only native port. It does not imply that an OS prompt can be physically cancelled. */
export interface CredentialCrypto {
  getSelectedStorageBackend(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(key: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class SignalCredentialVault implements CredentialVault {
  constructor(
    private store: ProsperoStore,
    private crypto: CredentialCrypto,
    private platform: string,
  ) {}
  private async available(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      this.platform === 'linux' &&
      ['basic_text', 'unknown'].includes(this.crypto.getSelectedStorageBackend())
    )
      throw new UserError('A secure OS credential store is required.');
    signal?.throwIfAborted();
    const available = await this.crypto.isAsyncEncryptionAvailable();
    signal?.throwIfAborted();
    if (!available)
      throw new UserError('The OS credential store is unavailable. Unlock it and try again.');
  }
  async put(id: string, key: string, signal?: AbortSignal, endpoint?: string) {
    const plaintext = envelope(id, endpoint, key);
    await this.available(signal);
    signal?.throwIfAborted();
    const encrypted = await this.crypto.encryptStringAsync(plaintext);
    signal?.throwIfAborted();
    this.store.saveEncryptedCredential(id, encrypted);
  }
  async get(id: string, signal?: AbortSignal, endpoint?: string) {
    signal?.throwIfAborted();
    const encrypted = this.store.encryptedCredential(id);
    if (!encrypted) return undefined;
    await this.available(signal);
    signal?.throwIfAborted();
    const decrypted = await this.crypto.decryptStringAsync(Buffer.from(encrypted));
    signal?.throwIfAborted();
    const binding = boundKey(decrypted.result, id, endpoint);
    // Legacy keys become bound durably while the service still owns the provider reservation.
    if (binding.legacy || decrypted.shouldReEncrypt) {
      signal?.throwIfAborted();
      const replacement = await this.crypto.encryptStringAsync(
        envelope(id, endpoint, binding.apiKey),
      );
      signal?.throwIfAborted();
      this.store.saveEncryptedCredential(id, replacement);
    }
    signal?.throwIfAborted();
    return binding.apiKey;
  }
}
