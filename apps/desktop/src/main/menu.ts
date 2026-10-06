import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopAction } from '../bridge';

/** Native menus own the macOS accelerators; no development commands ship in production. */
export function applicationMenu(
  action: (value: DesktopAction) => void,
  development: boolean,
): MenuItemConstructorOptions[] {
  const command = (
    id: string,
    label: string,
    accelerator: string,
    value: DesktopAction,
  ): MenuItemConstructorOptions => ({ id, label, accelerator, click: () => action(value) });
  return [
    {
      label: 'Prospero',
      submenu: [
        { id: 'about', label: 'About Prospero', role: 'about' },
        { type: 'separator' },
        command('settings', 'Settings…', 'Command+,', 'settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Prospero', role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        command('new-task', 'New Task', 'Command+N', 'new-task'),
        { type: 'separator' },
        { id: 'close-window', label: 'Close Window', role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        command('search', 'Search Tasks', 'Command+F', 'search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        command('toggle-sidebar', 'Toggle Sidebar', 'Command+\\', 'toggle-sidebar'),
        command('command-palette', 'Command Palette…', 'Command+K', 'command-palette'),
        command(
          'command-palette-alternative',
          'Show Commands…',
          'Command+Shift+P',
          'command-palette',
        ),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { id: 'fullscreen', role: 'togglefullscreen', accelerator: 'Control+Command+F' },
        ...(development
          ? [{ type: 'separator' }, { id: 'reload', role: 'reload' }]
          : ([] as MenuItemConstructorOptions[])),
      ] as MenuItemConstructorOptions[],
    },
    {
      label: 'Window',
      submenu: [
        { id: 'minimize', role: 'minimize' },
        { id: 'zoom', label: 'Zoom', role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [{ id: 'help', label: 'Prospero Help', click: () => action('about') }],
    },
  ];
}
