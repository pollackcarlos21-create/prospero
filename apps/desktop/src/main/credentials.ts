import { safeStorage } from 'electron';
import type { ProsperoStore } from '@prospero/persistence';
import { SignalCredentialVault } from './credential-storage';
export class SecureCredentialVault extends SignalCredentialVault {
  constructor(store: ProsperoStore) {
    super(store, safeStorage, process.platform);
  }
}
