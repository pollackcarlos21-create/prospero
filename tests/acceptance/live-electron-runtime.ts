import { app, safeStorage, shell } from 'electron';
import { createLiveDesktopRuntime, type LiveDesktopRuntimeOptions } from './live-desktop-runtime';
import {
  copyLiveCredentialSelection,
  prepareLiveCredentialSelection,
  type LiveCredentialReadGate,
  type LiveCredentialSelectionInput,
  type LiveCredentialSelectionDescriptor,
} from './live-credential-selection';
import { createLiveCredentialReferenceVault } from './live-credential-reference-vault';
export {
  captureLiveCrashBoundary,
  verifyLiveCrashRecovery,
  reconcileLiveCrashParentDecision,
} from './live-crash-recovery';
export { superviseLiveFixtureChild } from './live-fixtures';
export { createLiveParentPermissionSession } from './live-child-permission';
export { attachLiveChildPermissionWorker } from './live-child-permission-worker';

export interface ElectronLiveRuntimeOptions
  extends Pick<
    LiveDesktopRuntimeOptions,
    | 'runId'
    | 'fixture'
    | 'ledger'
    | 'beforeDispatch'
    | 'signal'
    | 'reviewSummary'
    | 'beforeCrashCommit'
  > {
  readonly credentialSelection: LiveCredentialSelectionInput;
  readonly beforeCredentialRead: LiveCredentialReadGate;
}

/** Main-only bindings. Importing this module performs no crypto, filesystem read, HTTP or Trash.
 * The controller and trusted human workflow must approve before calling it. It is a library,
 * not a complete real-30 launcher, and app.isReady() does not establish native crypto readiness.
 */
export async function createElectronLiveRuntime(input: ElectronLiveRuntimeOptions) {
  if (!app.isReady()) throw new Error('The reviewed Electron main runtime is not ready.');
  const selection = Object.freeze({ ...input.credentialSelection });
  const beforeRead = input.beforeCredentialRead;
  let descriptor: LiveCredentialSelectionDescriptor | undefined;
  return createLiveDesktopRuntime({
    runId: input.runId,
    fixture: input.fixture,
    ledger: input.ledger,
    beforeDispatch: input.beforeDispatch,
    signal: input.signal,
    mode: 'production-default',
    beforeCrashCommit: input.beforeCrashCommit,
    reviewSummary: input.reviewSummary,
    async createProfile(fixture, signal) {
      const prepared = await prepareLiveCredentialSelection(selection, { beforeRead, signal });
      const profile = await copyLiveCredentialSelection(prepared.token, {
        beforeRead,
        signal,
        fixture,
      });
      descriptor = profile.descriptor;
      return profile;
    },
    createVault(store) {
      if (!descriptor) throw new Error('The selected credential reference is unavailable.');
      return createLiveCredentialReferenceVault({
        store,
        descriptor,
        crypto: safeStorage,
        platform: process.platform,
      });
    },
    nativeTrash: { adapter: 'electron.shell.trashItem', trash: (path) => shell.trashItem(path) },
  });
}
