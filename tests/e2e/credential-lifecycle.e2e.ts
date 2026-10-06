import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Stage = 'availability' | 'encrypt';
interface NativeState {
  held: boolean;
  availabilityCalls: number;
  encryptCalls: number;
  decryptCalls: number;
  nativeReplies: number;
  unhandledRejections: number;
  release: () => void;
}

async function launch(profile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROSPERO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PROSPERO_API_KEY;
  delete env.PROSPERO_DEV_URL;
  return _electron.launch({
    args: process.env.PROSPERO_PACKAGED_APP ? [] : [resolve('.')],
    executablePath: process.env.PROSPERO_PACKAGED_APP,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
}

function savedCounts(profile: string) {
  const database = new DatabaseSync(join(profile, 'prospero.sqlite'), { readOnly: true });
  try {
    return {
      credentials: Number(
        database.prepare('SELECT COUNT(*) AS count FROM credentials').get()?.count,
      ),
      providers: Number(database.prepare('SELECT COUNT(*) AS count FROM providers').get()?.count),
    };
  } finally {
    database.close();
  }
}

async function saveFromUi(page: Page) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Provider name', { exact: true }).fill('Cancelled credential fixture');
  // Saving never probes this unused loopback endpoint. No HTTP provider is required.
  await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:9/v1');
  await page.getByLabel('Model', { exact: true }).fill('offline-lifecycle-fixture');
  await page.getByLabel('API key', { exact: true }).fill('offline-lifecycle-dummy-key');
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
}

test('v1 window close cancels credential saves before late availability or encryption replies', async () => {
  const testInfo = test.info();
  test.skip(process.platform !== 'darwin', 'The idle Dock window lifecycle is specific to macOS.');
  for (const stage of ['availability', 'encrypt'] as const) {
    const dir = await mkdtemp(join(tmpdir(), `prospero-credential-${stage}-`));
    const profile = join(dir, 'profile');
    let app: ElectronApplication | undefined;
    try {
      app = await launch(profile);
      const running = app;
      const child = running.process();
      const page = await running.firstWindow();
      // Both native entry points are replaced before the first credential operation.
      // This checks logical cancellation, not Keychain initialization or physical OS cancellation.
      await running.evaluate(({ safeStorage }, heldStage: Stage) => {
        const state: NativeState = {
          held: false,
          availabilityCalls: 0,
          encryptCalls: 0,
          decryptCalls: 0,
          nativeReplies: 0,
          unhandledRejections: 0,
          release: () => {
            throw new Error('Native fixture has not started.');
          },
        };
        (
          globalThis as unknown as { credentialLifecycleState: NativeState }
        ).credentialLifecycleState = state;
        process.on('unhandledRejection', () => {
          state.unhandledRejections++;
        });
        safeStorage.isAsyncEncryptionAvailable = async () => {
          state.availabilityCalls++;
          if (heldStage !== 'availability') return true;
          state.held = true;
          return new Promise<boolean>((resolveReply) => {
            state.release = () => {
              state.nativeReplies++;
              resolveReply(true);
            };
          });
        };
        safeStorage.encryptStringAsync = async () => {
          state.encryptCalls++;
          if (heldStage !== 'encrypt')
            throw new Error('Cancelled availability must never encrypt.');
          state.held = true;
          return new Promise<Buffer>((resolveReply) => {
            state.release = () => {
              state.nativeReplies++;
              resolveReply(Buffer.from('synthetic-ciphertext-fixture'));
            };
          });
        };
        safeStorage.decryptStringAsync = async () => {
          state.decryptCalls++;
          throw new Error('This fixture must not decrypt a credential.');
        };
      }, stage);
      await saveFromUi(page);
      await expect
        .poll(() =>
          running.evaluate(
            () =>
              (globalThis as unknown as { credentialLifecycleState: NativeState })
                .credentialLifecycleState.held,
          ),
        )
        .toBe(true);
      expect(savedCounts(profile)).toEqual({ credentials: 0, providers: 0 });

      await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await expect
        .poll(() => running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
        .toBe(0);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(savedCounts(profile)).toEqual({ credentials: 0, providers: 0 });

      const counters = await running.evaluate(async () => {
        const state = (globalThis as unknown as { credentialLifecycleState: NativeState })
          .credentialLifecycleState;
        state.release();
        // Drain the native reply continuation and any unhandled rejection notification.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        return {
          availabilityCalls: state.availabilityCalls,
          encryptCalls: state.encryptCalls,
          decryptCalls: state.decryptCalls,
          nativeReplies: state.nativeReplies,
          unhandledRejections: state.unhandledRejections,
        };
      });
      expect(counters).toEqual({
        availabilityCalls: 1,
        encryptCalls: stage === 'encrypt' ? 1 : 0,
        decryptCalls: 0,
        nativeReplies: 1,
        unhandledRejections: 0,
      });
      expect(savedCounts(profile)).toEqual({ credentials: 0, providers: 0 });

      const reopened = running.waitForEvent('window');
      await running.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
      const newPage = await reopened;
      expect((await newPage.evaluate(() => window.prospero.bootstrap())).providers).toEqual([]);
      await newPage.getByRole('button', { name: 'Open settings', exact: true }).click();
      await newPage.getByRole('button', { name: 'Models', exact: true }).click();
      await expect(
        newPage.getByRole('button', { name: 'Add provider', exact: true }),
      ).toBeVisible();
      await expect(
        newPage.getByRole('button', { name: 'Edit Cancelled credential fixture', exact: true }),
      ).toHaveCount(0);
      await newPage.getByRole('button', { name: 'Close settings', exact: true }).click();
      await running.close();
      app = undefined;
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      expect(savedCounts(profile)).toEqual({ credentials: 0, providers: 0 });
      const diagnostics = (await readFile(join(profile, 'diagnostics/events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { code: string }).code);
      expect(diagnostics).not.toContain('app.failure');
      expect(diagnostics).not.toContain('shutdown.failure');
      await testInfo.attach(`credential-${stage}-lifecycle`, {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            stage,
            counters,
            windowClosed: true,
            mainStayedAlive: true,
            dockReopened: true,
            finalExitCode: child.exitCode,
            savedCounts: savedCounts(profile),
            scope:
              'Test-only native promises; no real Keychain or external API. Does not establish physical OS cancellation or cold safeStorage readiness.',
          }),
        ),
      });
    } finally {
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
