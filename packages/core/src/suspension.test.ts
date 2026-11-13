import { expect, spyOn, test } from 'bun:test';
import {
  runAgent,
  rehydrateAgentContinuation,
  type AgentContinuation,
  type AgentEvent,
  type AgentLimits,
  type ModelPort,
  type ModelRequest,
  type PermissionDecision,
  type SuspendedAgentOutcome,
  type SuspendableAgentOptions,
  type ToolCall,
  type ToolDefinition,
  type ToolHost,
} from './index';
import { SUSPENDED_TOOL_CONTENT, DEFERRED_TOOL_CONTENT } from './continuation';

const definition: ToolDefinition = {
  name: 'inspect',
  description: 'Inspect bounded fixture notes',
  riskLevel: 'read',
  inputSchema: { type: 'object' },
};
const call = (id: string): ToolCall => ({ id, name: 'inspect', arguments: '{}' });
function fixture(
  settings: { calls?: ToolCall[]; limits?: AgentLimits; hook?: () => void | Promise<void> } = {},
) {
  const executed: string[] = [];
  const prepared: string[] = [];
  const skipped: string[] = [];
  const suspended: string[] = [];
  const decisions: string[] = [];
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  let generation = 0;
  const host: ToolHost = {
    definitions: [definition],
    prepare: async (requested) => {
      prepared.push(requested.id);
      return {
        call: { ...requested },
        definition,
        permissionKey: requested.id,
        allowSession: true,
        requiresPermission: true,
        preview: { kind: 'read', title: `Fresh preparation ${++generation}` },
        execute: async () => {
          executed.push(requested.id);
          return {
            content: `Actual result for ${requested.id}`,
            sources:
              requested.id === 'prefix'
                ? [
                    {
                      id: 'source-1',
                      url: 'https://example.test/article',
                      title: 'Fixture source',
                      kind: 'page',
                      retrievedAt: 1,
                      contentHash: 'fixture-hash',
                      excerpt: 'Untrusted fixture excerpt',
                    },
                  ]
                : undefined,
          };
        },
        onSkipped: (reason) => {
          skipped.push(`${requested.id}:${reason}`);
        },
        onSuspended: async () => {
          suspended.push(requested.id);
          await settings.hook?.();
        },
      };
    },
  };
  const model: ModelPort = {
    stream: async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return {
          content: 'A bounded plan',
          toolCalls: settings.calls ?? [call('prefix'), call('pending'), call('suffix')],
          finishReason: 'tool_calls',
        };
      return { content: 'The bounded step finished.', toolCalls: [], finishReason: 'stop' };
    },
  };
  const options: SuspendableAgentOptions = {
    executionId: 'dot-run-1',
    host,
    model,
    signal: new AbortController().signal,
    messages: [{ role: 'user', content: 'Inspect only these supplied notes.' }],
    memory: ['A saved, untrusted note'],
    permissions: {
      decide: async (request) => {
        decisions.push(request.call.id);
        return request.call.id === 'pending' ? 'suspend' : 'allow-session';
      },
    },
    suspension: {},
    limits: settings.limits,
    onEvent: (event) => {
      events.push(event);
    },
  };
  const resume = (
    continuation: AgentContinuation,
    decide: PermissionDecision | 'suspend' = 'allow-once',
    limits?: AgentLimits,
  ) =>
    runAgent({
      ...options,
      messages: [{ role: 'user', content: 'This must not replace the saved execution' }],
      memory: ['This must not replace saved memory'],
      suspension: { continuation },
      limits,
      permissions: {
        decide: async (request) => {
          decisions.push(request.call.id);
          expect(request.preview.title).toContain('Fresh preparation');
          return decide;
        },
      },
    });
  return { options, resume, executed, prepared, skipped, suspended, decisions, requests, events };
}
async function paused(h: ReturnType<typeof fixture>): Promise<SuspendedAgentOutcome> {
  const outcome = await runAgent(h.options);
  expect(outcome.state).toBe('suspended');
  if (outcome.state !== 'suspended') throw new Error('Expected explicit suspension.');
  return outcome;
}

test('opt-in suspension pairs history and resumes only its pending call after JSON rehydration', async () => {
  const h = fixture();
  const first = await paused(h);
  expect(h.executed).toEqual(['prefix']);
  expect(h.prepared).toEqual(['prefix', 'pending']);
  expect(h.suspended).toEqual(['pending']);
  expect(h.skipped).toEqual([]);
  expect(
    first.messages.filter((message) => message.role === 'tool').map((message) => message.content),
  ).toEqual(['Actual result for prefix', SUSPENDED_TOOL_CONTENT, DEFERRED_TOOL_CONTENT]);
  expect(
    h.events.some(
      (event) =>
        event.type === 'permission-decision' && event.requestId === first.request.requestId,
    ),
  ).toBe(false);
  expect(h.events.at(-1)).toEqual({ type: 'state', state: 'suspended' });
  const saved = rehydrateAgentContinuation(JSON.parse(JSON.stringify(first.continuation)));
  expect(Object.isFrozen(saved.messages[1].toolCalls?.[0])).toBe(true);
  const finished = await h.resume(saved);
  expect(finished.state).toBe('completed');
  expect(h.executed).toEqual(['prefix', 'pending']);
  expect(h.prepared).toEqual(['prefix', 'pending', 'pending']);
  expect(h.decisions).toEqual(['prefix', 'pending', 'pending']);
  expect(h.skipped).toEqual([]);
  expect(finished.toolCalls).toBe(2);
  expect(finished.modelTurns).toBe(2);
  expect(
    finished.messages
      .filter((message) => message.toolCallId === 'pending')
      .map((message) => message.content),
  ).toEqual(['Actual result for pending']);
  expect(
    h.events.some(
      (event) => event.type === 'message' && event.replacesMessage === saved.pending.resultIndex,
    ),
  ).toBe(true);
  expect(h.requests[1].messages.some((message) => message.content === DEFERRED_TOOL_CONTENT)).toBe(
    true,
  );
  expect(
    h.requests[1].messages.some(
      (message) =>
        message.content.includes('Current execution source receipts') &&
        message.content.includes('source-1'),
    ),
  ).toBe(true);
  expect(
    h.requests[1].messages.some((message) => message.content.includes('A saved, untrusted note')),
  ).toBe(true);
  expect(JSON.stringify(h.requests[1])).not.toContain('This must not replace');
});

test('repeated suspension retains the same call position and cumulative counters without restoring grants', async () => {
  const h = fixture();
  const first = await paused(h);
  const second = await h.resume(first.continuation, 'suspend');
  expect(second.state).toBe('suspended');
  if (second.state !== 'suspended') throw new Error('Expected second suspension.');
  expect(second.continuation.pending).toEqual(first.continuation.pending);
  expect(second.request.requestId).toBe(first.request.requestId);
  expect(second.toolCalls).toBe(2);
  expect(second.modelTurns).toBe(1);
  expect(second.continuation.remainingExecutionMs).toBeLessThanOrEqual(
    first.continuation.remainingExecutionMs,
  );
  expect(second.continuation.wallDeadline).toBe(first.continuation.wallDeadline);
  expect(h.executed).toEqual(['prefix']);
  const third = await h.resume(second.continuation);
  expect(third.state).toBe('completed');
  expect(h.decisions).toEqual(['prefix', 'pending', 'pending', 'pending']);
});

test('a host without a suspension cleanup hook fails closed and receives failure cleanup', async () => {
  const h = fixture({ calls: [call('pending')] });
  const original = h.options.host.prepare;
  h.options.host.prepare = async (...args) => {
    const prepared = await original(...args);
    delete prepared.onSuspended;
    return prepared;
  };
  const outcome = await runAgent(h.options);
  expect(outcome.state).toBe('failed');
  expect(h.executed).toEqual([]);
  expect(h.skipped).toEqual(['pending:failed']);
  expect(outcome.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
});

test('cleanup failure cannot manufacture a suspended outcome or dispatch the pending effect', async () => {
  const h = fixture({
    calls: [call('pending')],
    hook: () => {
      throw new Error('private cleanup detail');
    },
  });
  const outcome = await runAgent(h.options);
  expect(outcome.state).toBe('failed');
  expect(h.executed).toEqual([]);
  expect(h.skipped).toEqual(['pending:failed']);
  expect(JSON.stringify(outcome)).not.toContain('private cleanup detail');
});

test('Stop during suspension cleanup remains cancellation and waits for host cleanup', async () => {
  let finish!: () => void;
  let entered!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const h = fixture({
    calls: [call('pending')],
    hook: () => {
      entered();
      return cleaning;
    },
  });
  h.options.signal = controller.signal;
  let settled = false;
  const running = runAgent(h.options).then((result) => {
    settled = true;
    return result;
  });
  await began;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  expect((await running).state).toBe('cancelled');
  expect(h.executed).toEqual([]);
  expect(h.skipped).toEqual(['pending:cancelled']);
});

test('continuation validation rejects tampering, accessors and budget exhaustion before any I/O', async () => {
  const h = fixture();
  const first = await paused(h);
  const originalPrepared = h.prepared.length;
  const originalRequests = h.requests.length;
  interface CorruptFixture {
    version: number;
    executionId: string;
    pending: { resultIndex: number };
    messages: { content: string; toolCalls: { id: string }[] }[];
    remainingExecutionMs: number;
    suspendedAt: number;
    wallDeadline: number;
    toolCalls: number;
    memory: string[];
    denied: Record<string, unknown>;
  }
  const mutations: ((value: CorruptFixture) => void)[] = [
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.executionId = 'different-run';
    },
    (value) => {
      value.pending.resultIndex--;
    },
    (value) => {
      value.messages[value.pending.resultIndex].content = 'Pretend approved';
    },
    (value) => {
      value.messages.pop();
    },
    (value) => {
      value.messages[1].toolCalls[1].id = 'prefix';
    },
    (value) => {
      value.remainingExecutionMs = 0;
    },
    (value) => {
      value.wallDeadline = value.suspendedAt;
    },
    (value) => {
      value.toolCalls = 201;
    },
    (value) => {
      value.memory = ['x'.repeat(1024 * 1024)];
    },
    (value) => {
      value.denied.extra = true;
    },
  ];
  for (const mutate of mutations) {
    const altered = JSON.parse(JSON.stringify(first.continuation));
    mutate(altered);
    const outcome = await h.resume(altered);
    expect(outcome.state).toBe('failed');
  }
  let invoked = 0;
  const getter = { ...first.continuation };
  Object.defineProperty(getter, 'memory', {
    enumerable: true,
    get: () => {
      invoked++;
      return [];
    },
  });
  expect((await h.resume(getter)).state).toBe('failed');
  expect(invoked).toBe(0);
  expect(h.prepared).toHaveLength(originalPrepared);
  expect(h.requests).toHaveLength(originalRequests);
  expect(h.executed).toEqual(['prefix']);
});

test('absolute wall expiry and backwards time reject a resume before host/model access', async () => {
  const h = fixture();
  const first = await paused(h);
  const clock = spyOn(Date, 'now');
  try {
    clock.mockReturnValue(first.continuation.wallDeadline);
    expect((await h.resume(first.continuation)).state).toBe('failed');
    clock.mockReturnValue(first.continuation.suspendedAt - 1);
    expect((await h.resume(first.continuation)).state).toBe('failed');
    expect(h.prepared).toEqual(['prefix', 'pending']);
    expect(h.requests).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test('resuming cannot reset tool/model limits and the previously counted pending call is charged once', async () => {
  const h = fixture({ calls: [call('pending')], limits: { maxModelTurns: 2, maxToolCalls: 1 } });
  const first = await paused(h);
  h.options.model.stream = async (request) => {
    h.requests.push(request);
    return { content: '', toolCalls: [call('new')], finishReason: 'tool_calls' };
  };
  const outcome = await h.resume(first.continuation, 'allow-once', {
    maxModelTurns: 100,
    maxToolCalls: 200,
  });
  expect(outcome.state).toBe('failed');
  expect(outcome.error).toContain('Maximum tool calls');
  expect(outcome.toolCalls).toBe(1);
  expect(outcome.modelTurns).toBe(2);
  expect(h.executed).toEqual(['pending']);
  expect(h.prepared).toEqual(['pending', 'pending']);
  expect(outcome.messages.filter((message) => message.toolCallId === 'new')).toHaveLength(1);
});

test('suspension retains denial barriers and never restores an earlier allow-session grant', async () => {
  const write = { ...definition, name: 'write', riskLevel: 'write' as const };
  const h = fixture({
    calls: [
      { id: 'denied-write', name: 'write', arguments: '{}' },
      call('prefix'),
      call('pending'),
    ],
  });
  h.options.host.definitions.push(write);
  const prepare = h.options.host.prepare;
  h.options.host.prepare = async (requested, signal) => ({
    ...(await prepare(requested, signal)),
    definition: requested.name === 'write' ? write : definition,
  });
  h.options.permissions.decide = async (request) =>
    request.call.id === 'denied-write'
      ? 'deny'
      : request.call.id === 'pending'
        ? 'suspend'
        : 'allow-session';
  const first = await paused(h);
  expect(first.continuation.denied.mutations).toBe(true);
  let afterResume = 0;
  h.options.model.stream = async () =>
    ++afterResume === 1
      ? {
          content: '',
          toolCalls: [{ id: 'write-again', name: 'write', arguments: '{}' }, call('prefix')],
          finishReason: 'tool_calls',
        }
      : { content: 'Finished', toolCalls: [], finishReason: 'stop' };
  expect((await h.resume(first.continuation)).state).toBe('completed');
  expect(h.executed).toEqual(['prefix', 'pending', 'prefix']);
  expect(h.decisions).toEqual(['pending', 'prefix']);
});

test('a re-prepared read cannot drop the pending permission requirement', async () => {
  const h = fixture({ calls: [call('pending')] });
  const first = await paused(h);
  const prepare = h.options.host.prepare;
  h.options.host.prepare = async (...args) => ({
    ...(await prepare(...args)),
    requiresPermission: false,
  });
  const outcome = await h.resume(first.continuation, 'deny');
  expect(outcome.state).toBe('completed');
  expect(h.decisions).toEqual(['pending', 'pending']);
  expect(h.executed).toEqual([]);
  expect(outcome.messages.find((message) => message.toolCallId === 'pending')?.content).toContain(
    'denied',
  );
});

test('a host cannot replace the pending call arguments during re-preparation', async () => {
  const h = fixture({ calls: [call('pending')] });
  const first = await paused(h);
  const prepare = h.options.host.prepare;
  h.options.host.prepare = async (...args) => ({
    ...(await prepare(...args)),
    call: { ...args[0], arguments: '{"changed":true}' },
  });
  const outcome = await h.resume(first.continuation);
  expect(h.executed).toEqual([]);
  expect(outcome.messages.find((message) => message.toolCallId === 'pending')?.content).toContain(
    'did not match',
  );
});

test('the original pending approval deadline survives suspension and never resets', async () => {
  const h = fixture({ calls: [call('pending')], limits: { maxPermissionWaitMs: 100 } });
  const first = await paused(h);
  const clock = spyOn(Date, 'now');
  try {
    clock.mockReturnValue(first.continuation.pending.expiresAt);
    expect((await h.resume(first.continuation)).state).toBe('failed');
    expect(h.prepared).toEqual(['pending']);
    expect(h.executed).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('default Chat options cannot accidentally opt into suspension', async () => {
  const h = fixture({ calls: [call('pending')] });
  const outcome = await runAgent({
    ...h.options,
    suspension: undefined,
    // Deliberately violate a legacy adapter's static contract at the runtime boundary.
    permissions: { decide: async () => 'suspend' as PermissionDecision },
  });
  expect(outcome.state).toBe('failed');
  expect(h.executed).toEqual([]);
  expect(h.suspended).toEqual([]);
  expect(h.skipped).toEqual(['pending:failed']);
});
