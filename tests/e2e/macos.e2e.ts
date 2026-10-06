import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
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

async function menuAction(app: ElectronApplication, id: string) {
  await app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`Missing native menu item: ${itemId}`);
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  }, id);
}

async function configure(page: Page, baseUrl: string) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Provider name', { exact: true }).fill('Native test provider');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('Model', { exact: true }).fill('offline-model');
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  await expect(page.getByTestId('provider-list')).toContainText('Native test provider');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

test('macOS native menus, keyboard, window states, materials, focus and live appearance', async () => {
  test.setTimeout(90_000);
  const dir = await mkdtemp(join(tmpdir(), 'prospero-native-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(dir, 'profile'));
    const page = await app.firstWindow();
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    const menu = await app.evaluate(({ Menu }) => {
      const appMenu = Menu.getApplicationMenu();
      return {
        labels: appMenu?.items.map((item) => item.label),
        reloads: appMenu?.items
          .flatMap((item) => item.submenu?.items ?? [])
          .filter((item) => ['reload', 'forceReload', 'toggleDevTools'].includes(item.role ?? ''))
          .length,
      };
    });
    expect(menu.labels).toEqual(['Prospero', 'File', 'Edit', 'View', 'Window', 'Help']);
    expect(menu.reloads).toBe(0);
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        minimum: window.getMinimumSize(),
        trafficLights: window.getWindowButtonPosition(),
      };
    });
    expect(native.minimum).toEqual([760, 560]);
    expect(native.trafficLights).toEqual({ x: 16, y: 17 });
    expect(
      await page.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require),
    ).toBe('undefined');
    expect(
      await page.evaluate(() => typeof (globalThis as unknown as { process?: unknown }).process),
    ).toBe('undefined');

    await page.keyboard.press('Meta+,');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Search commands', exact: true }),
    ).toBeFocused();
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/macos-command-palette.png' });
    await page.getByRole('combobox', { name: 'Search commands', exact: true }).fill('settings');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.screenshot({ path: 'output/playwright/macos-settings.png' });
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+n');
    await expect
      .poll(
        async () => (await page.evaluate(() => window.prospero.bootstrap())).conversations.length,
      )
      .toBe(1);
    await page.keyboard.press('Meta+\\');
    await expect(page.locator('.desktop-app')).toHaveClass(/sidebar-collapsed/);
    await page.keyboard.press('Meta+f');
    await expect(
      page.getByRole('textbox', { name: 'Search conversations', exact: true }),
    ).toBeFocused();
    await expect(page.locator('.desktop-app')).not.toHaveClass(/sidebar-collapsed/);
    await page.keyboard.press('Escape');
    await menuAction(app, 'command-palette');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual([760, 560]);
    await expect(page.getByLabel('Message Prospero', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/macos-minimum.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25),
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await menuAction(app, 'settings');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByLabel('Appearance', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setFullScreen(false),
    );
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
      )
      .toBe(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(true);
    await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
    await expect
      .poll(() =>
        app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(false);

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark');
    await page.screenshot({ path: 'output/playwright/macos-welcome-dark.png' });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('light');
    const surfaces = await page.evaluate(() => {
      const selectors = [
        '.sidebar',
        '.titlebar',
        '.composer',
        'textarea',
        'button',
        '.conversation-row',
      ];
      return selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .map((element) => {
            const style = getComputedStyle(element);
            return {
              selector,
              borders: [
                style.borderTopWidth,
                style.borderRightWidth,
                style.borderBottomWidth,
                style.borderLeftWidth,
              ],
            };
          }),
      );
    });
    expect(surfaces.every((surface) => surface.borders.every((width) => width === '0px'))).toBe(
      true,
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('.sidebar') as Element).transitionDuration,
      ),
    ).toBe('0s');
    await page.screenshot({ path: 'output/playwright/macos-welcome-light.png' });
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native context menus and clipboard; final window close stops work and Dock reopen restores', async () => {
  test.setTimeout(90_000);
  const dir = await mkdtemp(join(tmpdir(), 'prospero-native-life-'));
  const folder = join(dir, 'workspace');
  await mkdir(folder);
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(dir, 'profile'));
    let page = await app.firstWindow();
    await configure(page, fake.baseUrl);
    await app.evaluate(async ({ dialog, Menu, clipboard }, workspace) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
      Reflect.set(globalThis, 'prosperoSavedClipboardForTest', await clipboard.readText());
      Menu.prototype.popup = function () {
        Reflect.set(globalThis, 'prosperoContextMenuForTest', this);
      };
    }, folder);
    await page.getByRole('button', { name: 'Attach workspace', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.prospero.bootstrap())).conversations[0]?.workspace,
      )
      .toBe(await realpath(folder));
    await page.locator('.conversation-select').first().click({ button: 'right' });
    expect(
      await app.evaluate(() =>
        (
          Reflect.get(globalThis, 'prosperoContextMenuForTest') as { items: { label: string }[] }
        ).items.map((item) => item.label),
      ),
    ).toEqual(['Rename…', 'Delete…']);
    await app.evaluate(() => {
      const menu = Reflect.get(globalThis, 'prosperoContextMenuForTest') as {
        items: { label: string; click: () => void }[];
      };
      menu.items.find((item) => item.label === 'Rename…')?.click();
    });
    const rename = page.getByRole('dialog', { name: 'Rename conversation', exact: true });
    await expect(rename).toBeVisible();
    await page.getByLabel('Conversation title', { exact: true }).fill('Native lifecycle test');
    await rename.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.locator('.conversation-select').first()).toContainText(
      'Native lifecycle test',
    );
    await expect(
      page.getByRole('heading', { name: 'Native lifecycle test', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Workspace actions', exact: true })
      .click({ button: 'right' });
    await expect
      .poll(() =>
        app?.evaluate(() =>
          (
            Reflect.get(globalThis, 'prosperoContextMenuForTest') as { items: { label: string }[] }
          ).items.map((item) => item.label),
        ),
      )
      .toEqual(['Reveal in Finder', 'Copy Path']);
    await app.evaluate(() => {
      const menu = Reflect.get(globalThis, 'prosperoContextMenuForTest') as {
        items: { label: string; click: () => void }[];
      };
      menu.items.find((item) => item.label === 'Copy Path')?.click();
    });
    await expect
      .poll(() => app?.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(await realpath(folder));
    await page.evaluate(() => window.prospero.copyText('Prospero clipboard test'));
    expect(
      await app.evaluate(
        async ({ clipboard }) => (await clipboard.readText()) === 'Prospero clipboard test',
      ),
    ).toBe(true);
    await page.getByLabel('Message Prospero', { exact: true }).fill('slow shell');
    await page.keyboard.press('Meta+Enter');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return (await readFile(join(folder, 'child.pid'), 'utf8')).trim();
        } catch {
          return '';
        }
      })
      .not.toBe('');
    const pid = Number((await readFile(join(folder, 'child.pid'), 'utf8')).trim());
    // Menu roles are dispatched by AppKit, rather than by calling MenuItem.click directly.
    // Invoke the native window close API here; real Cmd+W is checked through macOS UI automation.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect
      .poll(() => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    expect(app.process().exitCode).toBeNull();
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    const reopened = app.waitForEvent('window');
    await app.evaluate(({ app: nativeApp }) => nativeApp.emit('activate'));
    page = await reopened;
    await expect(page.getByTestId('execution-status')).toHaveText('Stopped');
    expect(await page.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0);
    expect((await page.evaluate(() => window.prospero.bootstrap())).conversations[0].title).toBe(
      'Native lifecycle test',
    );
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText(Reflect.get(globalThis, 'prosperoSavedClipboardForTest') as string);
    });
    await app.close();
    app = undefined;
  } finally {
    if (app)
      await app
        .evaluate(async ({ clipboard }) => {
          const saved = Reflect.get(globalThis, 'prosperoSavedClipboardForTest');
          if (typeof saved === 'string') await clipboard.writeText(saved);
        })
        .catch(() => {});
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
