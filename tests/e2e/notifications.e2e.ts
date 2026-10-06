import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeProvider } from './fake-provider';

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
async function configure(page: Page, baseUrl: string) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Provider name', { exact: true }).fill('Notification test provider');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('Model', { exact: true }).fill('offline-model');
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  await expect(page.getByTestId('provider-list')).toContainText('Notification test provider');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function send(page: Page, text: string) {
  await page.getByLabel('Message Prospero', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send task', exact: true }).click();
}
interface Capture {
  title: string;
  body: string;
  silent: boolean;
}
async function captures(app: ElectronApplication): Promise<Capture[]> {
  return app.evaluate(() => Reflect.get(globalThis, 'prosperoNotificationCapturesForTest'));
}

test('native notification API dispatch: short suppression, controlled focus gate, minimized long completion and click restore', async () => {
  test.setTimeout(90_000);
  const dir = await mkdtemp(join(tmpdir(), 'prospero-notification-'));
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(dir, 'profile'));
    const page = await app.firstWindow();
    await configure(page, fake.baseUrl);
    await app.evaluate(({ Notification }) => {
      Reflect.set(globalThis, 'prosperoNotificationShowForTest', Notification.prototype.show);
      Reflect.set(globalThis, 'prosperoNotificationSupportForTest', Notification.isSupported);
      Reflect.set(globalThis, 'prosperoNotificationCapturesForTest', []);
      // Exercise the dispatch branch on all hosts without sending an OS notification or prompt.
      Notification.isSupported = () => true;
      Notification.prototype.show = function () {
        const values = Reflect.get(globalThis, 'prosperoNotificationCapturesForTest') as Capture[];
        // Read the actual Electron Notification instance getters, not a replacement fake class.
        values.push({ title: this.title, body: this.body, silent: this.silent });
        Reflect.set(globalThis, 'prosperoNotificationInstanceForTest', this);
      };
    });

    // Keep native focus false so this case independently proves duration suppression.
    // Without the <10s guard, this minimized task would dispatch a notification.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(true);
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
      )
      .toBe(false);
    const shortStarted = Date.now();
    await send(page, 'short notification completion');
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
    expect(Date.now() - shortStarted).toBeLessThan(10_000);
    expect(await captures(app)).toEqual([]);
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
    ).toBe(false);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.restore();
      window.show();
    });
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(false);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      Reflect.set(globalThis, 'prosperoNativeFocusForTest', window.isFocused);
      // A locked desktop cannot grant actual focus. This explicitly simulates only the focus
      // gate; model execution, elapsed 11s, native Notification class and host dispatch remain real.
      window.isFocused = () => true;
    });
    const focusedStarted = Date.now();
    await send(page, 'notification long completion — private focused task text');
    await expect(page.getByTestId('execution-status')).toHaveText('Thinking');
    await expect(page.getByTestId('execution-status')).toHaveText('Completed', { timeout: 25_000 });
    expect(Date.now() - focusedStarted).toBeGreaterThanOrEqual(11_000);
    expect(await captures(app)).toEqual([]);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.isFocused = Reflect.get(globalThis, 'prosperoNativeFocusForTest');
    });
    const unfocusedStarted = Date.now();
    await send(page, 'notification long completion — private unfocused task text');
    await expect(page.getByTestId('execution-status')).toHaveText('Thinking');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(true);
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
      )
      .toBe(false);
    await expect(page.getByTestId('execution-status')).toHaveText('Completed', { timeout: 25_000 });
    expect(Date.now() - unfocusedStarted).toBeGreaterThanOrEqual(11_000);
    await expect
      .poll(() => captures(app as ElectronApplication))
      .toEqual([{ title: 'Prospero', body: 'Your task is complete.', silent: true }]);
    // Invoke the real instance event callback without claiming literal OS notification delivery.
    await app.evaluate(() => {
      const notification = Reflect.get(
        globalThis,
        'prosperoNotificationInstanceForTest',
      ) as Electron.Notification;
      notification.emit('click');
    });
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => ({
          count: BrowserWindow.getAllWindows().length,
          minimized: BrowserWindow.getAllWindows()[0].isMinimized(),
          visible: BrowserWindow.getAllWindows()[0].isVisible(),
        })),
      )
      .toEqual({ count: 1, minimized: false, visible: true });
    expect(await captures(app)).toHaveLength(1);
  } finally {
    if (app)
      await app
        .evaluate(({ Notification, BrowserWindow }) => {
          const show = Reflect.get(globalThis, 'prosperoNotificationShowForTest');
          const support = Reflect.get(globalThis, 'prosperoNotificationSupportForTest');
          const focus = Reflect.get(globalThis, 'prosperoNativeFocusForTest');
          if (show) Notification.prototype.show = show;
          if (support) Notification.isSupported = support;
          const window = BrowserWindow.getAllWindows()[0];
          if (window && focus) window.isFocused = focus;
        })
        .catch(() => {});
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
