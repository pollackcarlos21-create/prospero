import { expect, test } from 'bun:test';
import type { DotRepository } from '@prospero/persistence';
import type { DotSupervisionItem, DotSupervisionSnapshot } from '../bridge';
import { DotAlerts, type DotAlertClock } from './dot-alerts';
class Clock implements DotAlertClock {
  value = 1000;
  private sequence = 0;
  readonly jobs = new Map<number, { at: number; run: () => void }>();
  now = () => this.value;
  schedule = (run: () => void, ms: number) => {
    const key = ++this.sequence;
    this.jobs.set(key, { at: this.value + ms, run });
    return () => {
      this.jobs.delete(key);
    };
  };
  async advance(ms: number) {
    this.value += ms;
    for (let count = 0; count < 100; count++) {
      const item = [...this.jobs].find(([, job]) => job.at <= this.value);
      if (!item) {
        await Promise.resolve();
        return;
      }
      this.jobs.delete(item[0]);
      item[1].run();
      await Promise.resolve();
    }
    throw new Error('Unexpected timer loop');
  }
}
function setup() {
  const entry: DotSupervisionItem = {
    dotId: 'dot',
    runId: 'run',
    intentId: 'intent',
    intentRevision: 0,
    intentDigest: 'a'.repeat(64),
    kind: 'approval',
    createdAt: 1,
    updatedAt: 1,
  };
  const claims = new Set<string>();
  let sequence = 0;
  let allowed = true;
  let throwShow = false;
  let failed = 0;
  const notices: (() => void)[] = [];
  const opened: string[] = [];
  const snapshots: DotSupervisionSnapshot[] = [];
  let snapshot: () => Promise<DotSupervisionSnapshot> = async () => ({
    sequence: ++sequence,
    items: [entry],
    more: false,
  });
  const repository = {
    alertClaim: (id: string, kind: string) => (claims.has(`${id}:${kind}`) ? {} : undefined),
    claimSupervisionAlerts: (items: readonly DotSupervisionItem[]) =>
      items.filter((item) => {
        const key = `${item.intentId}:${item.kind}`;
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      }),
  } as unknown as DotRepository;
  const clock = new Clock();
  const alerts = new DotAlerts(
    repository,
    {
      snapshot: () => snapshot(),
      publish: (value) => snapshots.push(value),
      canNotify: () => allowed,
      show: (open) => {
        if (throwShow) throw new Error('OS failure');
        notices.push(open);
      },
      open: (id) => {
        opened.push(id);
      },
      failed: () => {
        failed++;
      },
    },
    clock,
  );
  return {
    entry,
    claims,
    alerts,
    clock,
    notices,
    opened,
    snapshots,
    allow: (value: boolean) => {
      allowed = value;
    },
    failShow: () => {
      throwShow = true;
    },
    failures: () => failed,
    source: (value: typeof snapshot) => {
      snapshot = value;
    },
  };
}
test('focused or muted alerts keep the review inbox and claim nothing; later background refresh notifies once', async () => {
  const f = setup();
  try {
    f.allow(false);
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.snapshots).toHaveLength(1);
    expect(f.claims.size).toBe(0);
    f.allow(true);
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.notices).toHaveLength(1);
    f.alerts.refresh();
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.notices).toHaveLength(1);
    f.notices[0]();
    await Promise.resolve();
    expect(f.opened).toEqual(['dot']);
  } finally {
    f.alerts.dispose();
  }
});
test('failed native show is a durable attempt and cannot cause notification retry', async () => {
  const f = setup();
  try {
    f.failShow();
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.failures()).toBe(1);
    expect(f.claims.size).toBe(1);
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.failures()).toBe(1);
    expect(f.snapshots).toHaveLength(2);
  } finally {
    f.alerts.dispose();
  }
});
test('dispose discards late snapshots and stale notification clicks', async () => {
  const f = setup();
  let resolve!: (snapshot: DotSupervisionSnapshot) => void;
  f.source(
    () =>
      new Promise((ready) => {
        resolve = ready;
      }),
  );
  f.alerts.refresh();
  await f.clock.advance(50);
  f.alerts.dispose();
  resolve({ sequence: 1, items: [f.entry], more: false });
  await Promise.resolve();
  expect(f.notices).toEqual([]);
  expect(f.claims.size).toBe(0);
  const g = setup();
  g.alerts.refresh();
  await g.clock.advance(50);
  g.notices[0]();
  g.alerts.dispose();
  await Promise.resolve();
  expect(g.opened).toEqual([]);
  expect(g.clock.jobs.size).toBe(0);
});
test('a newer refresh invalidates an older asynchronous scan', async () => {
  const f = setup();
  try {
    let resolve!: (snapshot: DotSupervisionSnapshot) => void;
    f.source(
      () =>
        new Promise((ready) => {
          resolve = ready;
        }),
    );
    f.alerts.refresh();
    await f.clock.advance(50);
    f.alerts.refresh();
    resolve({ sequence: 1, items: [f.entry], more: false });
    await Promise.resolve();
    expect(f.notices).toHaveLength(0);
    f.source(async () => ({ sequence: 2, items: [], more: false }));
    await f.clock.advance(50);
    expect(f.snapshots.map((value) => value.sequence)).toEqual([2]);
  } finally {
    f.alerts.dispose();
  }
});
test('expiry is rechecked by a bounded timer without executing work or busy looping', async () => {
  const f = setup();
  try {
    f.source(async () => ({ sequence: 1, items: [], more: false, recheckAt: 2000 }));
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.notices).toHaveLength(0);
    f.source(async () => ({ sequence: 2, items: [f.entry], more: false }));
    await f.clock.advance(950);
    await f.clock.advance(50);
    expect(f.notices).toHaveLength(1);
    expect(f.clock.jobs.size).toBe(0);
  } finally {
    f.alerts.dispose();
  }
});
test('previously claimed entries do not starve a newly eligible item in the same inbox page', async () => {
  const f = setup();
  try {
    const items = Array.from({ length: 25 }, (_, index) => ({
      ...f.entry,
      intentId: `intent-${index}`,
    }));
    for (let i = 0; i < 24; i++) f.claims.add(`intent-${i}:approval`);
    f.source(async () => ({ sequence: 1, items, more: false }));
    f.alerts.refresh();
    await f.clock.advance(50);
    expect(f.claims.has('intent-24:approval')).toBe(true);
    expect(f.notices).toHaveLength(1);
  } finally {
    f.alerts.dispose();
  }
});
