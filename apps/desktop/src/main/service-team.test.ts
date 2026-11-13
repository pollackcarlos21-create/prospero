import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProsperoStore } from '@prospero/persistence';
import { startFakeProvider } from '../../../../tests/e2e/fake-provider';
import { DesktopService } from './service';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for team state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(workerTask = 'Inspect evidence') {
  const provider = await startFakeProvider((_request, task, results) => {
    if (task.startsWith('Complete only')) {
      if (workerTask === 'slow model') return undefined;
      return { text: task.includes('Researcher') ? 'Research evidence A' : 'Review evidence B' };
    }
    if (!results.length)
      return {
        tool: 'collaborate',
        args: {
          tasks: [
            { name: 'Researcher', task: `${workerTask} Researcher` },
            { name: 'Reviewer', task: `${workerTask} Reviewer` },
          ],
        },
      };
    return { text: `Team synthesis: ${results.at(-1)?.content}` };
  });
  const store = new ProsperoStore(':memory:');
  let credentialReads = 0;
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: async () => {
        credentialReads++;
        return 'fake-only';
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
  );
  await service.saveProvider({ displayName: 'Offline', baseUrl: provider.baseUrl, model: 'fake' });
  const parent = service.createConversation();
  await service.sendTask(parent.id, 'Split this task and synthesize the findings', true);
  await until(() => !!service.getConversation(parent.id).pendingPermission);
  const approve = () =>
    service.decidePermission(
      parent.id,
      service.getConversation(parent.id).pendingPermission?.requestId ?? 'missing-request',
      'allow-once',
    );
  return {
    service,
    store,
    provider,
    parent,
    approve,
    reads: () => credentialReads,
    async close() {
      await service.shutdown();
      store.close();
      await provider.close();
    },
  };
}

test('parallel agents return shared reports, retain separate traces and reload under the lead', async () => {
  const f = await fixture();
  try {
    expect(f.provider.requests.length).toBe(1);
    f.approve();
    await until(() => f.provider.requests.length === 3);
    expect(
      f.service
        .getConversation(f.parent.id)
        .team?.every((agent) => agent.state === 'model-request'),
    ).toBe(true);
    await until(() => f.service.getConversation(f.parent.id).state === 'completed');
    const result = f.service.getConversation(f.parent.id);
    expect(result.team?.length).toBe(2);
    expect(result.team?.every((agent) => agent.state === 'completed')).toBe(true);
    expect(result.messages.at(-1)?.content).toContain('Research evidence A');
    expect(result.messages.at(-1)?.content).toContain('Review evidence B');
    expect(f.provider.requests.length).toBe(4);
    // Both worker requests precede the lead's synthesis request.
    expect(
      f.provider.requests
        .slice(1, 3)
        .every((request) =>
          request.messages.some((message) => message.content.startsWith('Complete only')),
        ),
    ).toBe(true);
    for (const request of f.provider.requests.slice(1, 3)) {
      expect(request.tools?.some((tool) => JSON.stringify(tool).includes('collaborate'))).toBe(
        false,
      );
    }
    expect(f.reads()).toBe(1);
    expect(f.service.bootstrap().conversations.length).toBe(1);
    for (const agent of result.team ?? []) {
      expect(
        f.service.getConversation(agent.id).timeline.some((item) => item.type === 'message'),
      ).toBe(true);
      expect(
        f.provider.requests
          .find((request) =>
            request.messages.some((message) =>
              message.content.includes(`assignment\\":\\"Inspect evidence ${agent.title}`),
            ),
          )
          ?.tools?.some((tool) => JSON.stringify(tool).includes('collaborate')) ?? false,
      ).toBe(false);
    }
    await f.service.shutdown();
    const restored = new DesktopService(
      f.store,
      { put: async () => {}, get: async () => undefined },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      '0.2.0',
    );
    expect(restored.getConversation(f.parent.id).team?.length).toBe(2);
    expect(restored.bootstrap().conversations.length).toBe(1);
    restored.deleteConversation(f.parent.id);
    expect(f.store.conversations().length).toBe(0);
    await restored.shutdown();
  } finally {
    await f.close();
  }
});

test('Stop on the lead aborts all child streams and retains stopped reports', async () => {
  const f = await fixture('slow model');
  try {
    f.approve();
    await until(() => f.provider.requests.length === 3);
    await f.service.stopTask(f.parent.id);
    const result = f.service.getConversation(f.parent.id);
    expect(result.state).toBe('cancelled');
    expect(result.team?.every((agent) => agent.state === 'cancelled')).toBe(true);
    expect(result.pendingPermission).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('denied delegation starts no workers and does not expose credentials', async () => {
  const f = await fixture();
  try {
    f.service.decidePermission(
      f.parent.id,
      f.service.getConversation(f.parent.id).pendingPermission?.requestId ?? 'missing-request',
      'deny',
    );
    await until(() => f.service.getConversation(f.parent.id).state === 'completed');
    const result = f.service.getConversation(f.parent.id);
    expect(result.team?.length).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fake-only');
    expect(f.provider.requests.length).toBe(2);
  } finally {
    await f.close();
  }
});

test('a worker failure remains failed in the shared report instead of becoming a success', async () => {
  const f = await fixture('provider error');
  try {
    f.approve();
    await until(() => f.service.getConversation(f.parent.id).state === 'completed');
    const result = f.service.getConversation(f.parent.id);
    expect(result.team?.every((agent) => agent.state === 'failed')).toBe(true);
    const report = result.timeline.find((item) => item.call?.name === 'collaborate')?.result;
    expect(
      JSON.parse(report?.content ?? '{}').reports.every(
        (agent: { state: string }) => agent.state === 'failed',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('individual cancellation leaves its sibling running and reports the cancelled assignment', async () => {
  const f = await fixture('slow model');
  try {
    f.approve();
    await until(() => f.provider.requests.length === 3);
    const agents = f.service.getConversation(f.parent.id).team ?? [];
    await f.service.stopTask(agents[0].id);
    expect(f.service.getConversation(agents[0].id).state).toBe('cancelled');
    expect(f.service.getConversation(agents[1].id).state).toBe('model-request');
    await f.service.stopTask(agents[1].id);
    await until(() => f.service.getConversation(f.parent.id).state === 'completed');
    const report = f.service
      .getConversation(f.parent.id)
      .timeline.find((item) => item.call?.name === 'collaborate')?.result;
    expect(
      JSON.parse(report?.content ?? '{}').reports.every(
        (agent: { state: string }) => agent.state === 'cancelled',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('workers independently approve real writes and a later teammate verifies their files and reports', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'prospero-team-files-'));
  const provider = await startFakeProvider((_request, task, results) => {
    if (task.startsWith('Complete only')) {
      const context = JSON.parse(task.slice(task.indexOf('\n') + 1)) as {
        assignment: string;
        priorReports: { name: string; report: string }[];
      };
      if (context.assignment === 'Verify both files') {
        if (results.length < 2)
          return { tool: 'read_file', args: { path: results.length ? 'beta.txt' : 'alpha.txt' } };
        const shared =
          context.priorReports.some((entry) => entry.name === 'Alpha') &&
          context.priorReports.some((entry) => entry.name === 'Beta');
        return {
          text: `${shared ? 'Shared reports available' : 'MISSING_SHARED_REPORTS'}; verified file outputs: ${results.map((entry) => entry.content).join(' | ')}`,
        };
      }
      const file = context.assignment === 'Write alpha' ? 'alpha.txt' : 'beta.txt';
      if (!results.length)
        return { tool: 'write_file', args: { path: file, content: `Evidence from ${file}` } };
      return { text: `Worker report for ${file}: ${results[0].content}` };
    }
    if (!results.length)
      return {
        tool: 'collaborate',
        args: {
          tasks: [
            { name: 'Alpha', task: 'Write alpha' },
            { name: 'Beta', task: 'Write beta' },
          ],
        },
      };
    if (results.length === 1)
      return {
        tool: 'collaborate',
        args: { tasks: [{ name: 'Verifier', task: 'Verify both files' }] },
      };
    return { text: `Final synthesis: ${results.map((entry) => entry.content).join('\n')}` };
  });
  const store = new ProsperoStore(':memory:');
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => folder, files: async () => [] },
    () => {},
    '0.2.0',
  );
  try {
    await service.saveProvider({
      displayName: 'Offline',
      baseUrl: provider.baseUrl,
      model: 'fake',
    });
    const parent = service.createConversation();
    await service.chooseWorkspace(parent.id);
    await service.sendTask(
      parent.id,
      'Have two agents write separate evidence files and another verify both',
      true,
    );
    await until(() => !!service.getConversation(parent.id).pendingPermission);
    service.decidePermission(
      parent.id,
      service.getConversation(parent.id).pendingPermission?.requestId ?? '',
      'allow-once',
    );
    await until(() => {
      const agents = service.getConversation(parent.id).team ?? [];
      return (
        agents.length === 2 &&
        agents.every((agent) => !!service.getConversation(agent.id).pendingPermission)
      );
    });
    const workers = service.getConversation(parent.id).team ?? [];
    await expect(readFile(join(folder, 'alpha.txt'))).rejects.toThrow();
    await expect(readFile(join(folder, 'beta.txt'))).rejects.toThrow();
    const firstRequest = service.getConversation(workers[0].id).pendingPermission;
    expect(() =>
      service.decidePermission(parent.id, firstRequest?.requestId ?? '', 'allow-once'),
    ).toThrow('no longer active');
    service.decidePermission(workers[0].id, firstRequest?.requestId ?? '', 'allow-once');
    await until(() => service.getConversation(workers[0].id).state === 'completed');
    expect(await readFile(join(folder, 'alpha.txt'), 'utf8')).toBe('Evidence from alpha.txt');
    await expect(readFile(join(folder, 'beta.txt'))).rejects.toThrow();
    service.decidePermission(
      workers[1].id,
      service.getConversation(workers[1].id).pendingPermission?.requestId ?? '',
      'allow-once',
    );
    await until(() => !!service.getConversation(parent.id).pendingPermission);
    service.decidePermission(
      parent.id,
      service.getConversation(parent.id).pendingPermission?.requestId ?? '',
      'allow-once',
    );
    await until(() => service.getConversation(parent.id).state === 'completed');
    expect(await readFile(join(folder, 'beta.txt'), 'utf8')).toBe('Evidence from beta.txt');
    const result = service.getConversation(parent.id);
    expect(result.team?.map((agent) => agent.state)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(result.messages.at(-1)?.content).toContain('Shared reports available');
    expect(result.messages.at(-1)?.content).toContain('Evidence from alpha.txt');
    expect(result.messages.at(-1)?.content).toContain('Evidence from beta.txt');
    expect(
      service
        .getConversation(result.team?.at(-1)?.id ?? '')
        .timeline.filter((item) => item.type === 'tool')
        .map((item) => item.call?.name),
    ).toEqual(['read_file', 'read_file']);
  } finally {
    await service.shutdown();
    store.close();
    await provider.close();
    await rm(folder, { recursive: true, force: true });
  }
});
