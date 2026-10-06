import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createLiveBudgetManifest,
  LiveBudgetLedger,
  type LiveBudgetJournal,
  type LiveBudgetManifest,
} from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';

async function fixture(
  run: (ctx: {
    root: string;
    database: string;
    manifest: LiveBudgetManifest;
    open(mode: 'create' | 'resume'): SqliteLiveBudgetJournal;
    options(
      journal: LiveBudgetJournal,
      humanConfirmed?: boolean,
    ): ConstructorParameters<typeof LiveBudgetLedger>[1];
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prospero-live-budget-')));
  const database = path.join(root, 'journal.sqlite');
  const now = Date.now();
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_${randomUUID()}`,
    sourceSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    journalSha256: createHash('sha256').update(database).digest('hex'),
    caseIds: ['W01'],
    createdAt: now,
    expiresAt: now + 60_000,
    limits: {
      provider: 2,
      search: 1,
      page: 1,
      redirects: 1,
      responseBodyBytes: 110,
      wallClockMs: 60_000,
    },
  });
  const journals: SqliteLiveBudgetJournal[] = [];
  const options = (journal: LiveBudgetJournal, humanConfirmed = true) => ({
    humanConfirmed,
    journal,
    executionIdentity: { sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 },
    now: () => manifest.createdAt,
    monotonic: () => 0,
  });
  try {
    await run({
      root,
      database,
      manifest,
      options,
      open(mode) {
        const journal = new SqliteLiveBudgetJournal(database, { mode });
        journals.push(journal);
        return journal;
      },
    });
  } finally {
    for (const journal of journals) journal.close();
    await rm(root, { recursive: true, force: true });
  }
}
const reserve = (ledger: LiveBudgetLedger, responseBytes = 100) =>
  ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes });

test('actual child exit preserves unknown dispatch consumption; restart never restores consent or token', async () => {
  await fixture(async ({ root, database, manifest, options, open }) => {
    const module = path.resolve('tests/acceptance/live-budget.ts');
    const journalModule = path.resolve('tests/acceptance/live-budget-journal.ts');
    const marker = path.join(root, 'simulated-request.marker');
    const script = `
      import { LiveBudgetLedger } from ${JSON.stringify(module)};
      import { SqliteLiveBudgetJournal } from ${JSON.stringify(journalModule)};
      import { writeFileSync } from 'node:fs';
      const manifest = ${JSON.stringify(manifest)};
      const journal = new SqliteLiveBudgetJournal(${JSON.stringify(database)}, { mode: 'create' });
      const ledger = new LiveBudgetLedger(manifest, { journal, humanConfirmed: true, executionIdentity: { sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 }, now: () => manifest.createdAt, monotonic: () => 0 });
      const token = ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
      ledger.dispatch(token);
      writeFileSync(${JSON.stringify(marker)}, 'simulated effect after durable intent');
      process.exit(23);
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      env: {},
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(23);
    expect(await readFile(marker, 'utf8')).toBe('simulated effect after durable intent');
    const journal = open('resume');
    const facts = journal.load(manifest);
    expect(facts?.state.requests.provider).toBe(1);
    expect(facts?.state.pending[0]?.dispatched).toBe(true);
    const unapproved = new LiveBudgetLedger(manifest, options(journal, false));
    expect(() => reserve(unapproved, 1)).toThrow('authorization');
    expect(journal.load(manifest)?.revision).toBe(facts?.revision);
    const restarted = new LiveBudgetLedger(manifest, options(journal));
    const next = reserve(restarted, 10);
    expect(restarted.usage().chargedResponseBodyBytes).toBe(100);
    expect(restarted.usage().unknownResponseReceipts).toBe(1);
    expect(restarted.usage().provider).toBe(2);
    expect(restarted.usage().durableAcrossProcessRestart).toBe(true);
    expect(() => restarted.dispatch({})).toThrow('reservation');
    restarted.dispatch(next);
    restarted.complete(next, { outcome: 'completed', responseBytes: 5 });
    expect(restarted.usage().chargedResponseBodyBytes).toBe(105);
    expect(() => reserve(restarted, 1)).toThrow('quota');
  });
});

test('recovery releases proven pre-dispatch bytes, retains request counts and invalidates an old live owner', async () => {
  await fixture(async ({ manifest, options, open }) => {
    const first = new LiveBudgetLedger(manifest, options(open('create')));
    const old = reserve(first);
    const recovered = new LiveBudgetLedger(manifest, options(open('resume')));
    const next = reserve(recovered, 100);
    expect(recovered.usage().provider).toBe(2);
    expect(recovered.usage().chargedResponseBodyBytes).toBe(0);
    let attemptedTransport = 0;
    expect(() => {
      first.dispatch(old);
      attemptedTransport++;
    }).toThrow('journal');
    expect(attemptedTransport).toBe(0);
    expect(first.usage().closed).toBe(true);
    expect(first.usage().journalCommitFailed).toBe(true);
    recovered.dispatch(next);
    recovered.complete(next, { outcome: 'completed', responseBytes: 3 });
    expect(recovered.usage().chargedResponseBodyBytes).toBe(3);
    expect(() => reserve(recovered, 1)).toThrow('quota');
  });
});

test('dispatch commit failure prevents transport; possibly committed intent remains charged on recovery', async () => {
  await fixture(async ({ manifest, options, open }) => {
    const durable = open('create');
    const uncertain: LiveBudgetJournal = {
      identitySha256: durable.identitySha256,
      load: (value) => durable.load(value),
      commit: (...args) => {
        const revision = durable.commit(...args);
        if (args[3] === 'dispatch') throw new Error('Private journal detail must not escape.');
        return revision;
      },
    };
    const ledger = new LiveBudgetLedger(manifest, options(uncertain));
    const token = reserve(ledger);
    let attemptedTransport = 0;
    expect(() => {
      ledger.dispatch(token);
      attemptedTransport++;
    }).toThrow('journal');
    expect(attemptedTransport).toBe(0);
    expect(() => reserve(ledger, 1)).toThrow('closed');
    const restarted = new LiveBudgetLedger(manifest, options(open('resume')));
    reserve(restarted, 10);
    expect(restarted.usage().unknownResponseReceipts).toBe(1);
    expect(restarted.usage().chargedResponseBodyBytes).toBe(100);
  });
});

test('receipt commit failure cannot turn a performed request into refunded global budget', async () => {
  await fixture(async ({ root, manifest, options, open }) => {
    const durable = open('create');
    const rejecting: LiveBudgetJournal = {
      identitySha256: durable.identitySha256,
      load: (value) => durable.load(value),
      commit: (...args) => {
        if (args[3] === 'settled') throw new Error('Private SQL failure.');
        return durable.commit(...args);
      },
    };
    const ledger = new LiveBudgetLedger(manifest, options(rejecting));
    const token = reserve(ledger);
    ledger.dispatch(token);
    await writeFile(path.join(root, 'performed.marker'), 'simulated response');
    expect(() => ledger.complete(token, { outcome: 'completed', responseBytes: 1 })).toThrow(
      'journal',
    );
    expect(ledger.usage().persistedDispatchIntents).toBe('unknown');
    const restarted = new LiveBudgetLedger(manifest, options(open('resume')));
    expect(() => reserve(restarted, 11)).toThrow('quota');
    expect(restarted.usage().chargedResponseBodyBytes).toBe(100);
    expect(restarted.usage().unknownResponseReceipts).toBe(1);
  });
});

test('recorded clock rollback and a different durable journal identity fail closed', async () => {
  await fixture(async ({ manifest, options, open }) => {
    const durable = open('create');
    const actor = new LiveBudgetLedger(manifest, {
      ...options(durable),
      now: () => manifest.createdAt + 100,
    });
    reserve(actor);
    const rolledBack = new LiveBudgetLedger(manifest, {
      ...options(open('resume')),
      now: () => manifest.createdAt + 90,
    });
    expect(() => reserve(rolledBack, 1)).toThrow('journal');
    const wrong: LiveBudgetJournal = {
      identitySha256: 'f'.repeat(64),
      load: () => {
        throw new Error('Must not read mismatched journal.');
      },
      commit: () => {
        throw new Error('Must not commit mismatched journal.');
      },
    };
    expect(() => reserve(new LiveBudgetLedger(manifest, options(wrong)), 1)).toThrow('journal');
  });
});
