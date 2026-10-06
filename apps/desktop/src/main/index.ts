import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  session,
  shell,
  systemPreferences,
} from 'electron';
import type { DesktopAction, DesktopAppearance, DesktopEvent } from '../bridge';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProsperoStore } from '@prospero/persistence';
import { normalizeBaseUrl } from '@prospero/providers';
import { Channels } from '../ipc';
import { SecureCredentialVault } from './credentials';
import { registerDesktopIpc } from './ipc-boundary';
import { createLogger } from './logger';
import { applicationMenu } from './menu';
import { DesktopService } from './service';

app.setName('Prospero');
// Isolated smoke/test profiles are opted into explicitly, never exposed over renderer IPC.
if (process.env.PROSPERO_USER_DATA) app.setPath('userData', process.env.PROSPERO_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined;
let service: DesktopService | undefined;
let store: ProsperoStore | undefined;
let expectedUrl = '';
let quitting = false;
let creatingWindow: Promise<BrowserWindow> | undefined;
let closingWindow: Promise<void> | undefined;
let rendererReady = false;
const queuedActions: DesktopAction[] = [];
const log = createLogger(join(app.getPath('userData'), 'diagnostics', 'events.jsonl'));
const devUrl =
  !app.isPackaged && process.env.PROSPERO_DEV_URL === 'http://127.0.0.1:5173'
    ? process.env.PROSPERO_DEV_URL
    : undefined;

function appearance(): DesktopAppearance {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
  };
}
function emit(event: DesktopEvent) {
  if (event.type === 'bootstrap' && nativeTheme.themeSource !== event.data.settings.theme)
    nativeTheme.themeSource = event.data.settings.theme;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send(Channels.event, event);
}
function flushActions() {
  if (!rendererReady) return;
  for (const action of queuedActions.splice(0)) emit({ type: 'desktop-action', action });
}
async function dispatchAction(action: DesktopAction) {
  if (quitting) return;
  queuedActions.push(action);
  await createWindow();
  flushActions();
}
function updateAppearance() {
  const current = window;
  if (current && !current.isDestroyed()) {
    current.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#171716' : '#f4f2ed');
    if (process.platform === 'darwin')
      current.setVibrancy(nativeTheme.prefersReducedTransparency ? null : 'sidebar');
  }
  emit({ type: 'desktop-appearance', appearance: appearance() });
}
async function createWindow(): Promise<BrowserWindow> {
  if (closingWindow) await closingWindow;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }
  if (creatingWindow) return creatingWindow;
  creatingWindow = openWindow();
  try {
    return await creatingWindow;
  } finally {
    creatingWindow = undefined;
  }
}
async function openWindow(): Promise<BrowserWindow> {
  rendererReady = false;
  const current = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Prospero',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171716' : '#f4f2ed',
    ...(process.platform === 'darwin'
      ? {
          vibrancy: nativeTheme.prefersReducedTransparency ? undefined : ('sidebar' as const),
          visualEffectState: 'followWindow' as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      scrollBounce: true,
    },
  });
  window = current;
  service?.resumeWindow();
  expectedUrl = devUrl ?? pathToFileURL(join(__dirname, 'renderer', 'index.html')).href;
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event) => event.preventDefault());
  current.webContents.on('will-attach-webview', (event) => event.preventDefault());
  current.webContents.on('render-process-gone', async (_event, details) => {
    log('renderer.crash', { process: 'renderer', exitCode: details.exitCode });
    rendererReady = false;
    await service?.shutdown();
    if (current.isDestroyed() || quitting) return;
    const { response } = await dialog.showMessageBox(current, {
      type: 'error',
      title: 'Prospero needs to reload',
      message: 'The task has been stopped. Your saved conversations are available after reload.',
      buttons: ['Reload', 'Quit'],
    });
    if (response === 0) {
      service?.resumeWindow();
      current.reload();
    } else app.quit();
  });
  current.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closingWindow) return;
    rendererReady = false;
    // Stop execution before destroying the window. macOS keeps an idle app in the Dock.
    closingWindow = (service?.suspendWindow() ?? Promise.resolve())
      .catch(() => log('shutdown.failure'))
      .finally(() => {
        if (!current.isDestroyed()) current.destroy();
        if (window === current) window = undefined;
        closingWindow = undefined;
      });
  });
  current.on('closed', () => {
    if (window === current) window = undefined;
    rendererReady = false;
  });
  current.once('ready-to-show', () => {
    if (!current.isDestroyed() && !quitting && !closingWindow) current.show();
  });
  await current.loadURL(expectedUrl);
  return current;
}

app
  .whenReady()
  .then(async () => {
    store = new ProsperoStore(join(app.getPath('userData'), 'prospero.sqlite'));
    service = new DesktopService(
      store,
      new SecureCredentialVault(store),
      {
        folder: async (mode) => {
          if (!window) return undefined;
          const result = await dialog.showOpenDialog(window, {
            title:
              mode === 'read'
                ? 'Choose a read-only folder'
                : mode === 'write'
                  ? 'Choose a writable folder'
                  : 'Choose workspace',
            properties: ['openDirectory'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        files: async () => {
          if (!window) return [];
          const result = await dialog.showOpenDialog(window, {
            title: 'Attach read-only files',
            properties: ['openFile', 'multiSelections'],
          });
          return result.canceled ? [] : result.filePaths;
        },
      },
      emit,
      app.getVersion(),
      !app.isPackaged && process.env.PROSPERO_API_KEY && process.env.PROSPERO_BASE_URL
        ? {
            apiKey: process.env.PROSPERO_API_KEY,
            baseUrl: normalizeBaseUrl(process.env.PROSPERO_BASE_URL),
          }
        : undefined,
      {
        appearance,
        ready: () => {
          rendererReady = true;
          flushActions();
        },
        contextMenu: (items) => {
          if (!window || window.isDestroyed()) return;
          Menu.buildFromTemplate(
            items.map((item) => ({
              label: item.label,
              enabled: item.enabled,
              click: () => {
                void Promise.resolve()
                  .then(() => item.action())
                  .catch(() => log('ipc.rejected'));
              },
            })),
          ).popup({ window });
        },
        copy: (value) => clipboard.writeText(value),
        reveal: (path) => shell.showItemInFolder(path),
        trash: (path) => shell.trashItem(path),
        openSource: (url) => shell.openExternal(url, { activate: true }),
        taskFinished: (durationMs) => {
          if (
            durationMs < 10_000 ||
            quitting ||
            !window ||
            window.isDestroyed() ||
            window.isFocused() ||
            !Notification.isSupported()
          )
            return;
          // Notifications contain no task text, file paths, model output or credentials.
          try {
            const notification = new Notification({
              title: 'Prospero',
              body: 'Your task is complete.',
              silent: true,
            });
            notification.on('click', () => {
              void createWindow().catch(() => log('app.failure'));
            });
            notification.show();
          } catch {
            log('app.failure');
          }
        },
      },
    );
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${devUrl ? "'self' ws://127.0.0.1:5173" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`;
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      });
    });
    registerDesktopIpc(
      {
        handle: (channel, handler) =>
          ipcMain.handle(channel, (event, ...args) =>
            handler(
              {
                senderId: event.sender.id,
                frameUrl: event.senderFrame?.url ?? '',
                isMainFrame: event.senderFrame === event.sender.mainFrame,
              },
              ...args,
            ),
          ),
      },
      service,
      () =>
        window && !window.isDestroyed() && !quitting && !closingWindow
          ? { senderId: window.webContents.id, url: expectedUrl }
          : undefined,
      () => log('ipc.rejected'),
    );
    nativeTheme.themeSource = service.bootstrap().settings.theme;
    app.setAboutPanelOptions({
      applicationName: 'Prospero',
      applicationVersion: app.getVersion(),
      copyright: 'Prospero contributors',
      credits: 'A personal agent for macOS. Local conversations, explicit permissions.',
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        applicationMenu((action) => {
          void dispatchAction(action).catch(() => log('app.failure'));
        }, Boolean(devUrl)),
      ),
    );
    nativeTheme.on('updated', updateAppearance);
    if (process.platform === 'darwin')
      systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification',
        updateAppearance,
      );
    await createWindow();
    log('app.ready', { process: 'main' });
  })
  .catch(() => {
    // Quitting during initial load cancels loadURL; it is a normal lifecycle transition.
    if (quitting) return;
    log('app.failure', { process: 'main' });
    dialog.showErrorBox(
      'Prospero could not start',
      'Your saved data has been preserved. Check local diagnostics and retry.',
    );
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (app.isReady() && !quitting) void createWindow().catch(() => log('app.failure'));
});
app.on('second-instance', () => {
  if (app.isReady() && !quitting) void createWindow().catch(() => log('app.failure'));
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  service
    ?.shutdown()
    .catch(() => log('shutdown.failure'))
    .finally(() => {
      store?.close();
      // Let the native AppKit quit callback unwind before beginning the final quit.
      setImmediate(() => app.quit());
    });
  if (!service) {
    store?.close();
    app.exit(0);
  }
});
let fatalShutdown = false;
process.on('uncaughtException', () => {
  log('app.failure', { process: 'main' });
  if (fatalShutdown) return;
  fatalShutdown = true;
  void (service?.shutdown() ?? Promise.resolve()).finally(() => {
    store?.close();
    app.exit(1);
  });
});
process.on('unhandledRejection', () => log('app.failure', { process: 'main' }));
