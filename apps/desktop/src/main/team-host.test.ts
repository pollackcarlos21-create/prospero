import { expect, test } from 'bun:test';
import type { ToolHost } from '@prospero/core';
import { withTeamTools } from './team-host';

const signal = () => new AbortController().signal;
const call = (tasks: unknown) => ({
  id: 'batch',
  name: 'collaborate',
  arguments: JSON.stringify({ tasks }),
});
const tasks = Array.from({ length: 3 }, (_, i) => ({
  name: `Agent ${i}`,
  task: 'Inspect evidence',
}));
const base: ToolHost = {
  definitions: [{ name: 'write', description: '', riskLevel: 'write', inputSchema: {} }],
  async prepare(call) {
    return {
      call,
      definition: this.definitions[0],
      preview: { kind: 'write', title: 'Write' },
      permissionKey: 'write',
      allowSession: false,
      requiresPermission: true,
      execute: async () => ({ content: 'executed' }),
    };
  },
};

test('team batches have bounded fanout and a one-time task preview before launch', async () => {
  let launches = 0;
  const host = withTeamTools(base, { denied: false }, async () => {
    launches++;
    return { content: 'reports' };
  });
  for (const invalid of [
    [],
    [...tasks, tasks[0]],
    [{ name: '', task: 'x' }],
    [{ name: 'x', task: 'x', extra: true }],
  ])
    await expect(host.prepare(call(invalid), signal())).rejects.toThrow();
  const prepared = await host.prepare(call(tasks), signal());
  expect(prepared.requiresPermission).toBe(true);
  expect(prepared.allowSession).toBe(false);
  expect(prepared.preview.before).toContain('Agent 2');
  expect(launches).toBe(0);
  await prepared.execute(signal());
  await (await host.prepare(call(tasks), signal())).execute(signal());
  await expect(host.prepare(call(tasks), signal())).rejects.toThrow();
  expect(launches).toBe(2);
});

test('a family refusal blocks sibling prepared effects and later delegation', async () => {
  const gate = { denied: false };
  const lead = withTeamTools(base, gate, async () => ({ content: 'reports' }));
  const child = withTeamTools(base, gate);
  expect(child.definitions.some((tool) => tool.name === 'collaborate')).toBe(false);
  const siblingWrite = await child.prepare({ id: 'w', name: 'write', arguments: '{}' }, signal());
  const batch = await lead.prepare(call(tasks), signal());
  await batch.onDecision?.('deny');
  expect((await siblingWrite.execute(signal())).isError).toBe(true);
  expect((await batch.execute(signal())).isError).toBe(true);
  await expect(lead.prepare(call(tasks), signal())).rejects.toThrow('denied');
});
