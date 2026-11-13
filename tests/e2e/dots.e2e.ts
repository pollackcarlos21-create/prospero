import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider } from './fake-provider';

async function launch(profile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROSPERO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PROSPERO_API_KEY;
  delete env.PROSPERO_BASE_URL;
  delete env.PROSPERO_DEV_URL;
  return _electron.launch({
    args: process.env.PROSPERO_PACKAGED_APP ? [] : [resolve('.')],
    executablePath: process.env.PROSPERO_PACKAGED_APP,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
}

test('normal Dot UI creates, runs, pauses, restores and continues durable progress through typed IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prospero-dot-ui-'));
  const profile = join(root, 'profile');
  const fake = await startFakeProvider((request, _task, results) => {
    if (results.length) return { text: 'The bounded step is recorded.' };
    const continued = request.messages.some((message) =>
      message.content.includes('First saved UI brief'),
    );
    return {
      tool: 'record_progress',
      args: {
        summary: continued
          ? 'First saved UI brief — continued in a second step.'
          : 'First saved UI brief',
        completed: continued
          ? ['Question A analysed', 'Question B compared']
          : ['Question A analysed'],
        next: ['Continue the remaining question'],
      },
    };
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile);
    let page = await app.firstWindow();
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: 'Add provider', exact: true }).click();
    await page.getByLabel('Provider name', { exact: true }).fill('Dot test provider');
    await page.getByLabel('Base URL', { exact: true }).fill(fake.baseUrl);
    await page.getByLabel('Model', { exact: true }).fill('offline-model');
    await page.getByRole('button', { name: 'Save provider', exact: true }).click();
    await expect(page.getByTestId('provider-list')).toContainText('Dot test provider');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dots', exact: true }).click();
    await page.getByRole('button', { name: 'Create a Dot', exact: true }).click();
    await page.getByLabel('Dot name', { exact: true }).fill('Researcher');
    await page
      .getByLabel('Dot goal', { exact: true })
      .fill('Maintain an evolving brief from the notes I provide.');
    await page.getByRole('button', { name: 'Create and run', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Latest Dot result', exact: true }),
    ).toContainText('First saved UI brief');
    await expect(page.getByTestId('dot-status')).toHaveText('Ready for next step');
    const first = await page.evaluate(async () => {
      if (!window.prospero.dots) throw new Error('Missing focused Dot API.');
      const dots = await window.prospero.dots.list();
      return window.prospero.dots.get(dots[0].id);
    });
    expect(first.dot.lifecycle).toBe('active');
    expect(first.runs[0].status).toBe('succeeded');
    expect(first.checkpoint?.revision).toBe(1);
    expect(fake.requests).toHaveLength(2);
    expect(await page.evaluate(() => Object.isFrozen(window.prospero.dots))).toBe(true);
    await page.getByRole('button', { name: 'Pause Dot', exact: true }).click();
    await expect(page.getByTestId('dot-status')).toHaveText('Paused');
    await expect(page.getByRole('button', { name: 'Run next step', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Resume Dot', exact: true }).click();
    await expect(page.getByTestId('dot-status')).toHaveText('Ready for next step');
    await app.close();
    app = await launch(profile);
    page = await app.firstWindow();
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dots', exact: true }).click();
    await page.getByRole('button', { name: 'Open Dot Researcher', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Latest Dot result', exact: true }),
    ).toContainText('First saved UI brief');
    expect(fake.requests).toHaveLength(2);
    await page.getByRole('button', { name: 'Run next step', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Latest Dot result', exact: true }),
    ).toContainText('First saved UI brief — continued in a second step.');
    const second = await page.evaluate(async (id) => {
      if (!window.prospero.dots) throw new Error('Missing focused Dot API.');
      return window.prospero.dots.get(id);
    }, first.dot.id);
    expect(second.dot.id).toBe(first.dot.id);
    expect(second.checkpoint?.revision).toBe(2);
    expect(second.runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
    expect(second.runs.some((run) => run.id === first.runs[0].id)).toBe(true);
    expect((await page.evaluate(() => window.prospero.bootstrap())).conversations).toEqual([]);
    expect(fake.requests).toHaveLength(4);
    await page.getByText('Saved progress history', { exact: true }).click();
    await expect(page.locator('.dot-progress-record')).toHaveCount(2);
    await page.locator('.dot-progress-record').first().locator('summary').click();
    await expect(page.locator('.dot-progress-record').first()).toContainText(
      'First saved UI brief',
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(760);
    for (const name of ['Run next step', 'Pause Dot', 'Archive Dot']) {
      const bounds = await page.getByRole('button', { name, exact: true }).evaluate((element) => ({
        x: element.getBoundingClientRect().x,
        right: element.getBoundingClientRect().right,
        width: innerWidth,
      }));
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 820));
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark');
    await page.locator('.dots-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/dots-workspace-dark.png' });
    await page.getByRole('button', { name: 'Archive Dot', exact: true }).click();
    await expect(page.getByTestId('dot-status')).toHaveText('Archived');
    await expect(page.getByRole('button', { name: 'Run next step', exact: true })).toBeDisabled();
    expect(fake.requests).toHaveLength(4);
  } finally {
    await app?.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a main-owned Dot finishes with no window and its saved result is visible after reopening', async () => {
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'prospero-dot-no-window-'));
  const profile = join(root, 'profile');
  const fake = await startFakeProvider((_request, _task, results) =>
    results.length
      ? undefined
      : {
          tool: 'record_progress',
          args: {
            summary: 'The independently owned step is saved.',
            completed: ['Inspected the supplied notes'],
            next: ['Compare the next question'],
          },
        },
  );
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile);
    let page = await app.firstWindow();
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: 'Add provider', exact: true }).click();
    await page.getByLabel('Provider name', { exact: true }).fill('Independent Dot provider');
    await page.getByLabel('Base URL', { exact: true }).fill(fake.baseUrl);
    await page.getByLabel('Model', { exact: true }).fill('offline-model');
    await page.getByRole('button', { name: 'Save provider', exact: true }).click();
    await expect(page.getByTestId('provider-list')).toContainText('Independent Dot provider');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dots', exact: true }).click();
    await page.getByRole('button', { name: 'Create a Dot', exact: true }).click();
    await page.getByLabel('Dot name', { exact: true }).fill('Independent researcher');
    await page.getByLabel('Dot goal', { exact: true }).fill('notification long completion');
    await page.getByRole('button', { name: 'Create and run', exact: true }).click();
    await expect(
      page.getByText('Working on the notification test.', { exact: false }),
    ).toBeVisible();
    const id = await page.evaluate(async () => {
      const dots = await window.prospero.dots?.list();
      if (!dots?.[0]) throw new Error('Missing created Dot.');
      return dots[0].id;
    });
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect
      .poll(() => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    expect(fake.requests).toHaveLength(2);
    const status = () => {
      const db = new DatabaseSync(join(profile, 'prospero.sqlite'), { readOnly: true });
      try {
        return db.prepare('SELECT status FROM dot_runs WHERE dot_id = ?').get(id)?.status;
      } finally {
        db.close();
      }
    };
    expect(status()).toBe('running');
    await expect.poll(status, { timeout: 20_000 }).toBe('succeeded');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    const opened = app.waitForEvent('window');
    await app.evaluate(({ app }) => app.emit('activate'));
    page = await opened;
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dots', exact: true }).click();
    await page
      .getByRole('button', { name: 'Open Dot Independent researcher', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Latest Dot result', exact: true }),
    ).toContainText('The independently owned step is saved.');
    const saved = await page.evaluate((id) => window.prospero.dots?.get(id), id);
    expect(saved?.checkpoint?.revision).toBe(1);
    expect(saved?.runs[0].status).toBe('succeeded');
    expect(fake.requests).toHaveLength(2);
  } finally {
    await app?.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});
