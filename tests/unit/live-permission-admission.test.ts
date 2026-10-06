import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PermissionRequest } from '../../packages/core/src';
import { captureFileScope, createLocalToolHost } from '../../packages/local-host/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { livePermissionFingerprint } from '../acceptance/live-approval';
import {
  attachLiveParentPermissionSession,
  createLiveParentPermissionSession,
  type LivePermissionParentMessage,
} from '../acceptance/live-child-permission';
import { createLiveFixture } from '../acceptance/live-fixtures';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Actual host preview, adversarial protocol frames. No child/HTTP/native proof is claimed. */
async function fixture(review: (request: PermissionRequest) => Promise<'allow-once' | 'deny'>) {
  const files = await createLiveFixture('C07');
  const scope = await captureFileScope(files.root, 'write');
  const store = new ProsperoStore(join(dirname(files.root), 'admission.sqlite'));
  const conversationId = randomUUID();
  store.saveConversation({
    id: conversationId,
    title: 'Admission fixture',
    state: 'planning',
    updatedAt: 1,
  });
  const prepared = await createLocalToolHost({
    scopes: [scope],
    journal: store.actionJournal(conversationId, randomUUID()),
  }).prepare(
    {
      id: randomUUID(),
      name: 'execute_plan',
      arguments: JSON.stringify({
        title: 'Actual host preview',
        actions: ['first.txt', 'second.txt', 'third.txt'].map((name) => ({
          kind: 'write_text',
          target: { scopeId: scope.id, path: name },
          content: `${name} approved content`,
        })),
      }),
    },
    new AbortController().signal,
  );
  const request: PermissionRequest = {
    requestId: randomUUID(),
    call: prepared.call,
    preview: prepared.preview,
    permissionKey: prepared.permissionKey,
    allowSession: prepared.allowSession,
  };
  const binding = {
    runId: randomUUID(),
    generationId: randomUUID(),
    caseId: 'C07' as const,
    phaseId: 'initial' as const,
    conversationId,
  };
  const session = createLiveParentPermissionSession({
    binding,
    boundary: { roots: [files.root], scopeIds: [scope.id] },
    expiresAt: Date.now() + 5000,
    assertCurrent: async (signal) => signal.throwIfAborted(),
    reviewPermission: async ({ request }) => review(request),
  });
  const sent: LivePermissionParentMessage[] = [];
  let stops = 0;
  const channel = attachLiveParentPermissionSession(
    session,
    async (message) => {
      sent.push(message);
    },
    () => {
      stops++;
    },
    new AbortController().signal,
  );
  channel.receive({ version: 1, type: 'permission-ready', binding });
  await tick();
  const hello = sent.find((message) => message.type === 'permission-session');
  if (!hello) throw new Error('Missing session');
  const snapshot = {
    version: 1,
    type: 'permission-snapshot',
    binding,
    nonce: hello.nonce,
    challengeId: null,
    request: JSON.parse(JSON.stringify(request)),
  };
  return {
    files,
    request,
    binding,
    session,
    sent,
    channel,
    snapshot,
    get stops() {
      return stops;
    },
    async noEffect() {
      for (const name of ['first.txt', 'second.txt', 'third.txt'])
        await expect(access(join(files.root, name))).rejects.toThrow();
    },
    async close() {
      channel.finish();
      store.close();
      await files.close();
    },
  };
}
test('an early valid-looking ACK is rejected synchronously while actual host preview review remains unresolved', async () => {
  let release: ((decision: 'allow-once') => void) | undefined;
  const f = await fixture(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    f.channel.receive(f.snapshot);
    await tick();
    expect(release).toBeDefined();
    f.channel.receive({
      version: 1,
      type: 'permission-ack',
      binding: f.binding,
      nonce: f.snapshot.nonce,
      requestId: f.request.requestId,
      fingerprint: livePermissionFingerprint(f.request),
      decision: 'allow-once',
    });
    expect(f.stops).toBe(1);
    expect(f.session.evidence().records).toHaveLength(0);
    release?.('allow-once');
    await tick();
    expect(f.sent.some((message) => message.type === 'permission-decision')).toBe(false);
    await f.noEffect();
  } finally {
    await f.close();
  }
});
test('oversized frames are bounded at synchronous admission instead of accumulating behind a hanging review', async () => {
  let release: ((decision: 'allow-once') => void) | undefined;
  const f = await fixture(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    f.channel.receive(f.snapshot);
    await tick();
    expect(release).toBeDefined();
    for (let index = 0; index < 32; index++)
      f.channel.receive({ ...f.snapshot, payload: 'x'.repeat(65536) });
    expect(f.stops).toBe(1);
    expect(f.session.evidence().receivedBytes).toBeLessThan(65536);
    expect(f.session.evidence().records).toHaveLength(0);
    release?.('allow-once');
    await tick();
    expect(f.sent.some((message) => message.type === 'permission-decision')).toBe(false);
    await f.noEffect();
  } finally {
    await f.close();
  }
});
test('caller mutation cannot change an admitted full snapshot before asynchronous review or refresh', async () => {
  let observed: PermissionRequest | undefined;
  const f = await fixture(async (request) => {
    observed = request;
    return 'deny';
  });
  try {
    const original = livePermissionFingerprint(f.request);
    f.channel.receive(f.snapshot);
    f.snapshot.request.preview.plan.actions[0].target = '/unapproved';
    await tick();
    expect(observed).toBeDefined();
    expect(livePermissionFingerprint(observed as PermissionRequest)).toBe(original);
    expect(Object.isFrozen(observed?.preview.plan)).toBe(true);
    const refresh = f.sent.find((message) => message.type === 'permission-refresh');
    if (refresh?.type !== 'permission-refresh') throw new Error('Missing refresh');
    f.channel.receive({ ...f.snapshot, challengeId: refresh.challengeId, request: f.request });
    await tick();
    const decision = f.sent.find((message) => message.type === 'permission-decision');
    if (decision?.type !== 'permission-decision') throw new Error('Missing decision');
    f.channel.receive({
      version: 1,
      type: 'permission-ack',
      binding: f.binding,
      nonce: f.snapshot.nonce,
      requestId: decision.requestId,
      fingerprint: decision.fingerprint,
      decision: 'deny',
    });
    await tick();
    expect(f.session.evidence().status).toBe('denied');
    expect(f.session.evidence().records[0].acknowledged).toBe(true);
    await f.noEffect();
  } finally {
    await f.close();
  }
});
test('a copied or consumed session cannot attach a second channel or reuse its review authority', async () => {
  const f = await fixture(async () => 'deny');
  try {
    for (const session of [{ ...f.session }, JSON.parse(JSON.stringify(f.session)), f.session])
      expect(() =>
        attachLiveParentPermissionSession(
          session,
          async () => {},
          () => {},
          new AbortController().signal,
        ),
      ).toThrow('inconsistent');
    expect(f.session.evidence().records).toHaveLength(0);
    await f.noEffect();
  } finally {
    await f.close();
  }
});
