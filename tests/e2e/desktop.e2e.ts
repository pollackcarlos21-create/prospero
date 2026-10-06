import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeProvider } from './fake-provider';

async function launch(profile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PROSPERO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PROSPERO_API_KEY;
  delete env.PROSPERO_DEV_URL;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return _electron.launch({
    args: process.env.PROSPERO_PACKAGED_APP ? [] : [resolve('.')],
    executablePath: process.env.PROSPERO_PACKAGED_APP,
    env: cleanEnv,
  });
}
type CredentialPhase = { phase: string; event: string; at: number };
const credentialTraces = new WeakMap<
  ElectronApplication,
  { phases: CredentialPhase[]; stage: string; write: Promise<void> }
>();
const phasePrefix = 'PROSPERO_E2E_CREDENTIAL_PHASE ';
async function traceCredentialPhases(
  app: ElectronApplication,
  filename = 'credential-native-phases.json',
) {
  const trace = {
    phases: [] as CredentialPhase[],
    stage: 'native credential observation',
    write: Promise.resolve(),
  };
  credentialTraces.set(app, trace);
  const persist = () => {
    const snapshot = JSON.stringify(
      {
        stage: trace.stage,
        phases: trace.phases,
        note: 'Phase names and timestamps only; no inputs, ciphertext, decrypted values or error bodies. Original native methods execute unchanged.',
      },
      null,
      2,
    );
    trace.write = trace.write
      .then(async () => {
        await mkdir('output/v1-validation', { recursive: true });
        await writeFile(join('output/v1-validation', filename), `${snapshot}\n`);
      })
      .catch(() => {});
  };
  let pending = '';
  app.process().stderr?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith(phasePrefix)) continue;
      try {
        const entry = JSON.parse(line.slice(phasePrefix.length)) as CredentialPhase;
        if (
          ![
            'availability',
            'encrypt',
            'decrypt',
            'before-quit',
            'will-quit',
            'quit',
            'main-heartbeat',
          ].includes(entry.phase) ||
          !['started', 'finished', 'failed', 'alive'].includes(entry.event) ||
          !Number.isSafeInteger(entry.at)
        )
          continue;
        trace.phases.push({ phase: entry.phase, event: entry.event, at: entry.at });
        persist();
      } catch {
        /* Ignore unrelated or partial diagnostic output. */
      }
    }
  });
  app.process().once('exit', () => {
    trace.phases.push({ phase: 'process-exit', event: 'finished', at: Date.now() });
    persist();
  });
  await app.evaluate(({ safeStorage, app: nativeApp }, prefix) => {
    const record = (phase: string, event: string) => {
      process.stderr.write(`${prefix}${JSON.stringify({ phase, event, at: Date.now() })}\n`);
    };
    function track<A extends unknown[], R>(phase: string, operation: (...args: A) => Promise<R>) {
      return async (...args: A): Promise<R> => {
        record(phase, 'started');
        try {
          const result = await operation(...args);
          record(phase, 'finished');
          return result;
        } catch (error) {
          record(phase, 'failed');
          throw error;
        }
      };
    }
    safeStorage.isAsyncEncryptionAvailable = track(
      'availability',
      safeStorage.isAsyncEncryptionAvailable.bind(safeStorage),
    );
    safeStorage.encryptStringAsync = track(
      'encrypt',
      safeStorage.encryptStringAsync.bind(safeStorage),
    );
    safeStorage.decryptStringAsync = track(
      'decrypt',
      safeStorage.decryptStringAsync.bind(safeStorage),
    );
    nativeApp.on('before-quit', () => record('before-quit', 'started'));
    nativeApp.on('will-quit', () => record('will-quit', 'started'));
    nativeApp.on('quit', () => record('quit', 'started'));
    setInterval(() => record('main-heartbeat', 'alive'), 1_000).unref();
  }, phasePrefix);
}
async function saveCredentialPhases(app: ElectronApplication, stage: string) {
  const trace = credentialTraces.get(app);
  if (!trace) return;
  trace.stage = stage;
  // Diagnostic collection never evaluates the possibly blocked main process,
  // and must not replace the original assertion failure with a diagnostic error.
  await trace.write;
}
async function observeFailedCredentialDeadline(
  app: ElectronApplication,
  page: Page,
  filename = 'credential-deadline-observation.json',
) {
  const trace = credentialTraces.get(app);
  const started = trace?.phases.find(
    (entry) => entry.phase === 'availability' && entry.event === 'started',
  );
  if (!trace || !started) return;
  const timeoutMessage =
    'Secure credential operation timed out. Unlock the OS credential store and try again.';
  const observation: {
    originalAssertionRemainsFailed: true;
    availabilityStartedAt: number;
    productDeadlineMs: number;
    samples: { at: number; saved: boolean; timedOut: boolean }[];
    outcome: 'saved-before-close' | 'product-timeout' | 'pending' | 'observer-unavailable';
    availabilitySettled?: boolean;
    encryptionStarted?: boolean;
  } = {
    originalAssertionRemainsFailed: true,
    availabilityStartedAt: started.at,
    productDeadlineMs: 30_000,
    samples: [],
    outcome: 'pending',
  };
  try {
    // Keep the same failed process alive through its product deadline. This does not
    // extend the original assertion or retry native work, and exports no DOM/error body.
    while (Date.now() <= started.at + 32_000) {
      let observerTimer: ReturnType<typeof setTimeout> | undefined;
      const sample = await Promise.race([
        page.evaluate(
          (timeoutMessage) => ({
            at: Date.now(),
            saved:
              document
                .querySelector('[data-testid="provider-list"]')
                ?.textContent?.includes('Offline provider') ?? false,
            timedOut: Array.from(document.querySelectorAll('[role="alert"]')).some((element) =>
              element.textContent?.includes(timeoutMessage),
            ),
          }),
          timeoutMessage,
        ),
        new Promise<never>((_, reject) => {
          observerTimer = setTimeout(() => reject(new Error('Observer unavailable.')), 1_000);
        }),
      ]).finally(() => clearTimeout(observerTimer));
      observation.samples.push(sample);
      if (sample.saved || sample.timedOut) {
        observation.outcome = sample.saved ? 'saved-before-close' : 'product-timeout';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch {
    observation.outcome = 'observer-unavailable';
  }
  observation.availabilitySettled = trace.phases.some(
    (entry) => entry.phase === 'availability' && entry.event !== 'started',
  );
  observation.encryptionStarted = trace.phases.some((entry) => entry.phase === 'encrypt');
  try {
    await mkdir('output/v1-validation', { recursive: true });
    await writeFile(
      join('output/v1-validation', filename),
      `${JSON.stringify(observation, null, 2)}\n`,
    );
  } catch {
    // Diagnostic failure must not replace the original product assertion.
  }
}
async function configure(page: Page, baseUrl: string, key = '', saveTimeoutMs = 35_000) {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Provider name', { exact: true }).fill('Offline provider');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('Model', { exact: true }).fill('offline-model');
  if (key) await page.getByLabel('API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  // Native credential initialization has a 30s product deadline. Allow its bounded
  // outcome to reach the UI before asserting success; a product timeout still fails.
  await expect(page.getByTestId('provider-list')).toContainText('Offline provider', {
    timeout: saveTimeoutMs,
  });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function workspace(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, path);
  await page.getByRole('button', { name: 'Attach workspace', exact: true }).click();
  await expect(page.getByTestId('execution-status')).toHaveText('Ready');
  await expect
    .poll(async () => {
      const data = await page.evaluate(() => window.prospero.bootstrap());
      return data.conversations[0]?.workspace;
    })
    .toBe(await realpath(path));
  await expect(page.getByRole('button', { name: 'Attach workspace', exact: true })).toBeEnabled();
}
async function send(page: Page, text: string) {
  await page.getByLabel('Message Prospero', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send task', exact: true }).click();
}

test('desktop offline agent approvals, safe credential storage, persistence and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prospero-e2e-'));
  const profile = join(dir, 'profile');
  const folder = join(dir, 'workspace');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'Offline notes: keep the files organized.\n');
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  const marker = 'offline-test-credential-marker';
  const searchMarker = 'offline-test-brave-credential-marker';
  fake.expectCredential(marker);
  try {
    app = await launch(profile);
    await traceCredentialPhases(app);
    let page = await app.firstWindow();
    await expect(page.getByText('What would you like to do?', { exact: true })).toBeVisible();
    try {
      await configure(page, fake.baseUrl, marker);
    } catch (error) {
      await observeFailedCredentialDeadline(app, page);
      await saveCredentialPhases(app, 'initial provider configuration failed');
      throw error;
    }
    // Exercise the distinct search credential through the actual vault, without a search probe.
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Web Search', exact: true }).click();
    await page.getByLabel('Search API key', { exact: true }).fill(searchMarker);
    await page.getByRole('checkbox', { name: 'Enable Web Search', exact: true }).check();
    await page.getByRole('button', { name: 'Save Web Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toHaveText(
      'Web Search settings saved.',
    );
    await expect(page.getByLabel('Search API key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const boundary = await page.evaluate(() => ({
      node: typeof (globalThis as unknown as { require?: unknown }).require,
      process: typeof (globalThis as unknown as { process?: unknown }).process,
      methods: Object.keys(window.prospero),
    }));
    expect(boundary.node).toBe('undefined');
    expect(boundary.process).toBe('undefined');
    expect(boundary.methods).not.toContain('invoke');
    await workspace(app, page, folder);
    await send(page, 'offline agent: read notes, run the approved command and save result.txt');
    await expect(
      page.getByTestId('permission-card').filter({ hasText: "printf 'shell-ok'" }),
    ).toBeVisible();
    expect(fake.requests.length).toBe(2);
    expect(
      fake.requests[1].messages.some(
        (m) => m.role === 'tool' && m.content.includes('Offline notes'),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'File change diff', exact: true }).last(),
    ).toContainText('Prospero saved this after approval.');
    await expect(readFile(join(folder, 'result.txt'))).rejects.toThrow();
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/permission-light.png' });
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
    await expect(page.getByTestId('timeline')).toContainText(
      'Your notes were read, shell succeeded, and result.txt was saved.',
    );
    expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe(
      'Prospero saved this after approval.\n',
    );
    expect(fake.requests.at(-1)?.messages.filter((m) => m.role === 'tool').length).toBe(3);
    const metadata = await page.evaluate(() => window.prospero.bootstrap());
    expect(metadata.webSearch).toMatchObject({ enabled: true, hasApiKey: true });
    expect(JSON.stringify(metadata)).not.toContain(searchMarker);
    const webTools = (fake.requests[0].tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    expect(webTools).toEqual(
      expect.arrayContaining(['authorize_research', 'web_search', 'fetch_source', 'fetch_page']),
    );
    expect(JSON.stringify(metadata)).not.toContain(marker);
    const id = metadata.conversations[0].id;
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByLabel('Memory text', { exact: true }).fill('Prefer concise Chinese answers.');
    await page.getByRole('button', { name: 'Add memory', exact: true }).click();
    await expect(page.getByText('Prefer concise Chinese answers.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.screenshot({ path: 'output/playwright/conversation-dark.png' });
    await saveCredentialPhases(app, 'initial configuration and task completed');
    await app.close();
    app = await launch(profile);
    page = await app.firstWindow();
    await expect(page.getByTestId('timeline')).toContainText(
      'Your notes were read, shell succeeded, and result.txt was saved.',
    );
    const restored = await page.evaluate(() => window.prospero.bootstrap());
    expect(restored.conversations[0].id).toBe(id);
    expect(restored.settings.memory[0].text).toBe('Prefer concise Chinese answers.');
    expect(restored.settings.theme).toBe('dark');
    expect(restored.webSearch).toMatchObject({ enabled: true, hasApiKey: true });
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Offline provider', exact: true }).click();
    expect(await page.getByLabel('API key', { exact: true }).inputValue()).toBe('');
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
    await page.getByRole('button', { name: 'Web Search', exact: true }).click();
    await expect(page.getByLabel('Search API key', { exact: true })).toHaveValue('');
    await expect(
      page.getByRole('checkbox', { name: 'Enable Web Search', exact: true }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await send(page, 'continue the saved conversation');
    await expect(page.getByTestId('timeline')).toContainText('Offline conversation complete.');
    // The same service initialization must decrypt the search key after restart too.
    const continuedTools = fake.requests.at(-1)?.tools as
      | { function: { name: string } }[]
      | undefined;
    expect(continuedTools?.some((tool) => tool.function.name === 'web_search')).toBe(true);
    const saved = await page.evaluate(async () => {
      const bootstrap = await window.prospero.bootstrap();
      return window.prospero.getConversation(bootstrap.conversations[0].id);
    });
    expect(
      saved.timeline.filter((item) => item.type === 'tool').map((item) => item.call?.name),
    ).toEqual(['read_file', 'shell', 'write_file']);
    expect(saved.sources).toEqual([]);
    expect(saved.researchPlans ?? []).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(searchMarker);
    expect(JSON.stringify(fake.requests)).not.toContain(searchMarker);
    await app.close();
    app = undefined;
    for (const name of ['prospero.sqlite', 'diagnostics/events.jsonl']) {
      const data = await readFile(join(profile, name));
      expect(data.includes(Buffer.from(marker))).toBe(false);
      expect(data.includes(Buffer.from(searchMarker))).toBe(false);
    }
  } finally {
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('credential deadline reaches the UI while a test-only native promise remains pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prospero-credential-deadline-'));
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(dir, 'profile'));
    await app.evaluate(({ safeStorage }) => {
      // No OS crypto executes in this fixture; only the production logical deadline is real.
      safeStorage.isAsyncEncryptionAvailable = () => new Promise<boolean>(() => {});
    });
    await traceCredentialPhases(app, 'credential-deadline-fixture-phases.json');
    const page = await app.firstWindow();
    let assertionFailed = false;
    try {
      // Fail this diagnostic assertion early so the same pending fixture remains
      // observable through the unchanged 30s product deadline.
      await configure(page, fake.baseUrl, 'offline-pending-credential-fixture', 10_000);
    } catch {
      assertionFailed = true;
      await observeFailedCredentialDeadline(app, page, 'credential-deadline-fixture.json');
    }
    expect(assertionFailed).toBe(true);
    const observed = JSON.parse(
      await readFile('output/v1-validation/credential-deadline-fixture.json', 'utf8'),
    );
    expect(observed.originalAssertionRemainsFailed).toBe(true);
    expect(observed.outcome).toBe('product-timeout');
    expect(observed.availabilitySettled).toBe(false);
    expect(observed.encryptionStarted).toBe(false);
    const finalSample = observed.samples.at(-1);
    expect(finalSample.at - observed.availabilityStartedAt).toBeGreaterThanOrEqual(29_500);
    expect(finalSample.saved).toBe(false);
    expect((await page.evaluate(() => window.prospero.bootstrap())).providers).toHaveLength(0);
    await page.getByRole('button', { name: 'Save provider', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'New provider creation is busy. Wait for its secure credential operation to finish.',
    );
    expect(
      credentialTraces
        .get(app)
        ?.phases.filter((entry) => entry.phase === 'availability' && entry.event === 'started'),
    ).toHaveLength(1);
  } finally {
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('app quit cleans shell children; abrupt model interruption restores safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prospero-quit-'));
  const profile = join(dir, 'profile');
  const folder = join(dir, 'workspace');
  await mkdir(folder);
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profile);
    let page = await app.firstWindow();
    await configure(page, fake.baseUrl);
    await workspace(app, page, folder);
    await send(page, 'slow shell');
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
    await app.close();
    app = undefined;
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
    app = await launch(profile);
    page = await app.firstWindow();
    await expect(page.getByTestId('execution-status')).toHaveText('Stopped');
    await send(page, 'slow model');
    await expect(page.getByTestId('streaming-text')).toBeVisible();
    const crashed = app;
    const crashedPid = crashed.process().pid;
    if (!crashedPid) throw new Error('Missing isolated Electron process');
    process.kill(crashedPid, 'SIGKILL');
    await new Promise<void>((resolve) => {
      if (crashed.process().exitCode !== null || crashed.process().signalCode !== null) resolve();
      else crashed.process().once('exit', () => resolve());
    });
    app = await launch(profile);
    page = await app.firstWindow();
    await expect(page.getByTestId('execution-status')).toHaveText(
      'Interrupted — ready to continue',
    );
    expect(await page.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0);
    await send(page, 'continue after the interruption');
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
  } finally {
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('deny, model abort, waiting permission abort, shell process cleanup, errors and read session grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prospero-cancel-'));
  const folder = join(dir, 'workspace');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'Read this file.');
  const fake = await startFakeProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(dir, 'profile'));
    const page = await app.firstWindow();
    await configure(page, fake.baseUrl);
    await workspace(app, page, folder);
    await send(page, 'deny shell');
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
    await expect(readFile(join(folder, 'denied.txt'))).rejects.toThrow();
    await send(page, 'slow model');
    await expect(page.getByTestId('streaming-text')).toContainText('partial response');
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Stopped');
    await expect.poll(() => fake.abortedStreams).toBeGreaterThan(0);
    await expect(page.getByTestId('timeline')).toContainText(
      'A partial response that survives stopping.',
    );
    await send(page, 'slow shell');
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Stopped');
    await expect(readFile(join(folder, 'child.pid'))).rejects.toThrow();
    await send(page, 'slow shell');
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
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Stopped');
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
    await send(page, 'provider error');
    await expect(page.getByTestId('execution-status')).toHaveText('Task failed');
    await expect(page.getByTestId('timeline')).toContainText('Provider authentication failed');
    await expect(page.getByTestId('timeline')).not.toContainText(
      'never expose private provider body',
    );
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Permissions', exact: true }).click();
    await page.getByLabel('Ask before reading files').click();
    await expect(page.getByLabel('Ask before reading files')).toBeChecked();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await send(page, 'read confirmation');
    await page.getByRole('button', { name: 'Allow for this session', exact: true }).click();
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
    await send(page, 'read confirmation again');
    await expect(page.getByTestId('execution-status')).toHaveText('Completed');
    expect(await page.getByRole('button', { name: 'Allow once', exact: true }).count()).toBe(0);
  } finally {
    await app?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
