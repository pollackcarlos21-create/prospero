import { expect, test } from 'bun:test';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopAction } from '../bridge';
import { applicationMenu } from './menu';
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...flatten(Array.isArray(item.submenu) ? item.submenu : []),
  ]);
}
test('macOS menu uses six native menus and production has no reload or developer tools', () => {
  const template = applicationMenu(() => {}, false);
  expect(template.map((item) => item.label)).toEqual([
    'Prospero',
    'File',
    'Edit',
    'View',
    'Window',
    'Help',
  ]);
  const items = flatten(template);
  expect(items.some((item) => item.role === 'reload' || item.role === 'toggleDevTools')).toBe(
    false,
  );
  for (const role of [
    'about',
    'quit',
    'close',
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'selectAll',
    'minimize',
    'zoom',
    'front',
    'togglefullscreen',
  ])
    expect(items.some((item) => item.role === role)).toBe(true);
  expect(items.find((item) => item.id === 'fullscreen')).toMatchObject({
    role: 'togglefullscreen',
    accelerator: 'Control+Command+F',
  });
  const development = flatten(applicationMenu(() => {}, true));
  expect(development.filter((item) => item.role === 'reload')).toHaveLength(1);
});
test('native command accelerators emit exactly one renderer action with macOS bindings', () => {
  const actions: DesktopAction[] = [];
  const items = flatten(applicationMenu((action) => actions.push(action), false));
  const bindings = {
    'new-task': 'Command+N',
    settings: 'Command+,',
    search: 'Command+F',
    'command-palette': 'Command+K',
    'command-palette-alternative': 'Command+Shift+P',
    'toggle-sidebar': 'Command+\\',
  };
  for (const [id, accelerator] of Object.entries(bindings)) {
    const item = items.find((item) => item.id === id);
    expect(item?.accelerator).toBe(accelerator);
    item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
  }
  expect(actions).toEqual([
    'new-task',
    'settings',
    'search',
    'command-palette',
    'command-palette',
    'toggle-sidebar',
  ]);
});
