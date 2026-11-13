import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore, DotRepositoryError, SCHEMA_VERSION, type DotRepository } from './index';
const provider = { id: 'model', baseUrl: 'https://fixture.example.test/v1', model: 'fixture' };
function seed(repo: DotRepository) {
  const dot = repo.create({
    id: 'dot',
    name: 'Scheduled',
    goal: { text: 'Keep a brief' },
    createdAt: 100,
  });
  repo.createPolicy(
    {
      id: 'policy',
      dotId: 'dot',
      createdAt: 100,
      expiresAt: 10000,
      provider,
      configurationRevision: 7,
      queries: [{ query: 'bounded', maxResults: 1 }],
      allowDiscoveredPages: false,
      limits: {
        maxRuns: 2,
        maxSearches: 2,
        maxFetches: 0,
        maxResponseBytes: 1048576,
        maxModelTurns: 16,
        maxModelRequestBytes: 16 * 96 * 1024,
      },
    },
    dot.revision,
  );
  return repo.scheduleWake(
    { id: 'wake', dotId: 'dot', policyId: 'policy', createdAt: 110, dueAt: 200 },
    0,
    provider,
    7,
  );
}
async function fixture(
  body: (repo: DotRepository, db: DatabaseSync, path: string) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-wake-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const db = new DatabaseSync(path);
  try {
    await body(store.dots(), db, path);
  } finally {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test('one-shot claim, Run pair and budget survive connection restart and cannot be claimed twice', async () =>
  fixture((repo, _db, path) => {
    const wake = seed(repo);
    expect(repo.dueWakes(199)).toEqual([]);
    expect(repo.nextWakeAt()).toBe(200);
    const another = new ProsperoStore(path);
    try {
      expect(another.dots().wake(wake.id)).toEqual(wake);
      const claimed = another
        .dots()
        .claimWake(wake.id, 0, { runId: 'run', at: 200, provider, configurationRevision: 7 });
      expect(claimed.wake.status).toBe('claimed');
      expect(String(claimed.pair?.dot.inFlightRunId)).toBe('run');
      expect(() =>
        repo.claimWake(wake.id, 0, {
          runId: 'duplicate',
          at: 201,
          provider,
          configurationRevision: 7,
        }),
      ).toThrow(DotRepositoryError);
      expect(repo.runs('dot')).toHaveLength(1);
      expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
      expect(repo.nextWakeAt()).toBeUndefined();
      repo.recoverInFlight(202, () => true);
      expect(repo.getRun('run')?.status).toBe('interrupted');
      expect(repo.wake(wake.id)?.status).toBe('claimed');
      expect(repo.dueWakes(300)).toEqual([]);
    } finally {
      another.close();
    }
  }));
test('claim failure rolls back wake, Dot, Run and reservation together', async () =>
  fixture((repo, db) => {
    const wake = seed(repo);
    const before = repo.snapshot('dot');
    db.exec(
      "CREATE TRIGGER fail_wake BEFORE UPDATE ON dot_wakes WHEN NEW.status='claimed' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.claimWake(wake.id, 0, { runId: 'run', at: 200, provider, configurationRevision: 7 }),
    ).toThrow(DotRepositoryError);
    expect(repo.snapshot('dot')).toEqual(before);
    expect(repo.getRun('run')).toBeUndefined();
  }));
test('a busy Dot and a backwards clock consume neither wake nor budget', async () =>
  fixture((repo) => {
    seed(repo);
    const queued = repo.createRun('dot', 0, {
      id: 'manual',
      createdAt: 120,
      provider,
      configurationRevision: 7,
    });
    expect(
      repo.claimWake('wake', 0, { runId: 'too-early', at: 199, provider, configurationRevision: 7 })
        .pair,
    ).toBeUndefined();
    expect(
      repo.claimWake('wake', 0, { runId: 'busy', at: 200, provider, configurationRevision: 7 })
        .pair,
    ).toBeUndefined();
    repo.finishRun('dot', 'manual', queued.dot.revision, 'cancelled', 250);
    expect(repo.dueWakes(210)).toEqual([]);
    expect(repo.nextWakeAt()).toBe(250);
    expect(
      repo.claimWake('wake', 0, { runId: 'backwards', at: 210, provider, configurationRevision: 7 })
        .pair,
    ).toBeUndefined();
    expect(repo.wake('wake')?.status).toBe('scheduled');
    expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
    expect(
      String(
        repo.claimWake('wake', 0, {
          runId: 'after-clock-catches-up',
          at: 250,
          provider,
          configurationRevision: 7,
        }).pair?.run.id,
      ),
    ).toBe('after-clock-catches-up');
  }));
for (const scenario of ['configuration', 'expired', 'budget'] as const)
  test(`${scenario} blocks a wake without creating a Run or replacing its authorization`, async () =>
    fixture((repo) => {
      seed(repo);
      if (scenario === 'budget')
        for (let i = 0; i < 2; i++) {
          const dot = repo.get('dot');
          if (!dot) throw new Error('Missing fixture Dot');
          const next = repo.createRun('dot', dot.revision, {
            id: `manual-${i}`,
            createdAt: 120 + i,
            provider,
            configurationRevision: 7,
          });
          repo.finishRun('dot', next.run.id, next.dot.revision, 'cancelled', 120 + i);
        }
      const count = repo.runs('dot').length;
      const usage = repo.currentPolicy('dot')?.usage;
      const blocked = repo.claimWake('wake', 0, {
        runId: 'blocked',
        at: scenario === 'expired' ? 10000 : 200,
        provider,
        configurationRevision: scenario === 'configuration' ? 8 : 7,
      });
      expect(blocked.wake.status).toBe('blocked');
      expect(blocked.wake.reason).toBe(scenario === 'expired' ? 'policy' : scenario);
      expect(blocked.pair).toBeUndefined();
      expect(repo.runs('dot')).toHaveLength(count);
      expect(repo.currentPolicy('dot')?.usage).toEqual(usage);
    }));
test('pause, stop cancellation and revocation preserve terminal wake history; resume never resurrects it', async () =>
  fixture((repo) => {
    seed(repo);
    const paused = repo.transition('dot', 0, 'pause', 120);
    expect(repo.wake('wake')?.reason).toBe('state');
    const active = repo.transition('dot', paused.revision, 'resume', 130);
    expect(repo.dueWakes(300)).toEqual([]);
    const second = repo.scheduleWake(
      { id: 'second', dotId: 'dot', policyId: 'policy', createdAt: 140, dueAt: 200 },
      active.revision,
      provider,
      7,
    );
    expect(() => repo.cancelWake('dot', second.id, 1, 150)).toThrow(DotRepositoryError);
    repo.cancelDotWakes('dot', 150);
    expect(repo.wake(second.id)?.status).toBe('cancelled');
    repo.scheduleWake(
      { id: 'third', dotId: 'dot', policyId: 'policy', createdAt: 160, dueAt: 200 },
      active.revision,
      provider,
      7,
    );
    repo.revokePolicy('dot', 'policy', 0, 170);
    expect(repo.wake('third')?.reason).toBe('policy');
    expect(repo.nextWakeAt()).toBeUndefined();
  }));
test('duplicate schedule, stale Dot revision and outliving the policy are rejected', async () =>
  fixture((repo) => {
    const wake = seed(repo);
    expect(() => repo.scheduleWake({ ...wake, id: 'another' }, 0, provider, 7)).toThrow();
    expect(() =>
      repo.scheduleWake(
        { id: 'stale', dotId: 'dot', policyId: 'policy', createdAt: 120, dueAt: 200 },
        1,
        provider,
        7,
      ),
    ).toThrow();
    repo.cancelWake('dot', 'wake', 0, 120);
    expect(() =>
      repo.scheduleWake(
        { id: 'too-late', dotId: 'dot', policyId: 'policy', createdAt: 130, dueAt: 10000 },
        0,
        provider,
        7,
      ),
    ).toThrow();
  }));
for (const tamper of [
  'UPDATE dot_wakes SET due_at=201',
  'UPDATE dot_wake_events SET at=111',
  'DELETE FROM dot_wake_events',
])
  test(`wake audit is immutable: ${tamper}`, async () =>
    fixture((repo, db) => {
      seed(repo);
      expect(() => db.exec(tamper)).toThrow();
      expect(repo.wake('wake')?.status).toBe('scheduled');
    }));
test('corrupt state fails closed and ordinary reads do not heal it', async () =>
  fixture((repo, db) => {
    seed(repo);
    db.exec('UPDATE dot_wakes SET revision=1');
    expect(() => repo.wake('wake')).toThrow(DotRepositoryError);
    expect(() => repo.recoverInFlight(300, () => true)).toThrow(DotRepositoryError);
    expect(db.prepare('SELECT revision FROM dot_wakes').get()?.revision).toBe(1);
  }));
test('v7 migration preserves v6 policy usage and unrelated data; collision rolls back only migration', async () =>
  fixture((repo, db, path) => {
    seed(repo);
    repo.cancelWake('dot', 'wake', 0, 120);
    const reserved = repo.createRun('dot', 0, {
      id: 'reserved-before-migration',
      createdAt: 130,
      provider,
      configurationRevision: 7,
    });
    repo.finishRun('dot', reserved.run.id, reserved.dot.revision, 'cancelled', 130);

    db.exec(
      'DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; PRAGMA user_version=6',
    );
    db.exec("CREATE TABLE dot_wakes(sentinel TEXT); INSERT INTO dot_wakes VALUES('keep')");
    expect(() => new ProsperoStore(path)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
    expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
    expect(db.prepare('SELECT sentinel FROM dot_wakes').get()?.sentinel).toBe('keep');
    db.exec('DROP TABLE dot_wakes');
    const reopened = new ProsperoStore(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      expect(reopened.dots().currentPolicy('dot')?.policy.id).toBe('policy');
      expect(reopened.dots().currentPolicy('dot')?.usage.runs).toBe(1);
      expect(reopened.dots().snapshot('dot').wakes).toEqual([]);
    } finally {
      reopened.close();
    }
  }));

const processFixture = join(import.meta.dir, 'fixtures/dot-wake-process.ts');
for (const mode of ['crash-before', 'crash-after'] as const)
  test(`${mode} wake claim preserves atomic durable facts without automatic replay`, async () =>
    fixture((repo, _db, path) => {
      seed(repo);
      const before = repo.snapshot('dot');
      const child = Bun.spawnSync([process.execPath, processFixture, mode, path, 'crash-run'], {
        env: {},
        timeout: 5000,
      });
      expect(child.stderr.toString()).toBe('');
      expect(child.exitCode).toBe(mode === 'crash-before' ? 24 : 25);
      if (mode === 'crash-before') expect(repo.snapshot('dot')).toEqual(before);
      else {
        expect(repo.wake('wake')?.status).toBe('claimed');
        expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
        repo.recoverInFlight(201, () => true);
        expect(repo.getRun('crash-run')?.status).toBe('interrupted');
        expect(repo.dueWakes(500)).toEqual([]);
      }
    }));
test('two processes racing the same wake create exactly one Run and one reservation', async () =>
  fixture(async (repo, _db, path) => {
    seed(repo);
    const children = ['process-a', 'process-b'].map((id) =>
      Bun.spawn([process.execPath, processFixture, 'cas', path, id], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {},
      }),
    );
    const lines = children.map((child) => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      return async () => {
        while (!pending.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw new Error('Fixture ended before its result');
          pending += decoder.decode(next.value, { stream: true });
        }
        const cut = pending.indexOf('\n');
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        return JSON.parse(line);
      };
    });
    try {
      expect(await Promise.all(lines.map((read) => read()))).toEqual([
        { ready: true },
        { ready: true },
      ]);
      for (const child of children) {
        child.stdin.write('go');
        child.stdin.end();
      }
      const outcomes = await Promise.all(lines.map((read) => read()));
      expect(outcomes.map((value) => value.kind).sort()).toEqual(['claimed', 'error']);
      expect(outcomes.find((value) => value.kind === 'error')?.code).toBe('conflict');
      expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
      expect(await Promise.all(children.map((child) => new Response(child.stderr).text()))).toEqual(
        ['', ''],
      );
      expect(repo.runs('dot')).toHaveLength(1);
      expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
      expect(repo.wake('wake')?.runId).toEqual(repo.runs('dot')[0].id);
    } finally {
      for (const child of children) child.kill();
    }
  }));

test('revoking one policy does not depend on an unrelated Dot with a corrupt wake', async () =>
  fixture((repo, db) => {
    seed(repo);
    repo.create({ id: 'other', name: 'Other', goal: { text: 'Separate scope' }, createdAt: 100 });
    repo.createPolicy(
      {
        id: 'other-policy',
        dotId: 'other',
        createdAt: 100,
        expiresAt: 10000,
        provider,
        configurationRevision: 7,
        queries: [{ query: 'other', maxResults: 1 }],
        allowDiscoveredPages: false,
        limits: {
          maxRuns: 2,
          maxSearches: 2,
          maxFetches: 0,
          maxResponseBytes: 1048576,
          maxModelTurns: 16,
          maxModelRequestBytes: 16 * 96 * 1024,
        },
      },
      0,
    );
    repo.scheduleWake(
      { id: 'other-wake', dotId: 'other', policyId: 'other-policy', createdAt: 110, dueAt: 200 },
      0,
      provider,
      7,
    );
    db.exec("UPDATE dot_wakes SET revision=1 WHERE id='other-wake'");
    expect(() => repo.wake('other-wake')).toThrow(DotRepositoryError);
    expect(repo.revokePolicy('dot', 'policy', 0, 120).policy.status).toBe('revoked');
    expect(repo.wake('wake')?.reason).toBe('policy');
    expect(repo.currentPolicy('other')?.policy.status).toBe('active');
  }));

test('claim audit rejects substitution by another valid Run with the same owner, policy and creation time', async () =>
  fixture((repo, db) => {
    seed(repo);
    const claimed = repo.claimWake('wake', 0, {
      runId: 'claimed-run',
      at: 200,
      provider,
      configurationRevision: 7,
    });
    if (!claimed.pair) throw new Error('Missing claimed Run');
    const idle = repo.finishRun('dot', 'claimed-run', claimed.pair.dot.revision, 'cancelled', 200);
    const other = repo.createRun('dot', idle.dot.revision, {
      id: 'same-time-other-run',
      createdAt: 200,
      provider,
      configurationRevision: 7,
    });
    repo.finishRun('dot', other.run.id, other.dot.revision, 'cancelled', 200);
    db.exec("UPDATE dot_wakes SET run_id='same-time-other-run' WHERE id='wake'");
    expect(() => repo.wake('wake')).toThrow(DotRepositoryError);
    expect(() => repo.snapshot('dot')).toThrow(DotRepositoryError);
    expect(
      db.prepare("SELECT run_id FROM dot_wake_events WHERE wake_id='wake' AND sequence=2").get()
        ?.run_id,
    ).toBe('claimed-run');
  }));
