import { expect, test } from 'bun:test';
import { runAgent } from './index';
import type { ActionPlan, Effect, PlanStatus } from './actions';
import type {
  AgentEvent,
  AgentOptions,
  ModelRequest,
  ModelResponse,
  PermissionDecision,
  PreparedTool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types';

const definitions: ToolDefinition[] = [
  {
    name: 'execute_plan',
    description: 'Execute approved structured actions',
    inputSchema: { type: 'object' },
    riskLevel: 'write',
    effects: ['file.write'],
  },
  {
    name: 'write_file',
    description: 'Write a text file',
    inputSchema: { type: 'object' },
    riskLevel: 'write',
    effects: ['file.write'],
  },
  {
    name: 'shell',
    description: 'Run a process',
    inputSchema: { type: 'object' },
    riskLevel: 'shell',
    effects: ['process.execute'],
  },
  {
    name: 'read_file',
    description: 'Read without changing files',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: ['file.read'],
  },
  // Effects must still identify mutations even when a host definition is marked as a read.
  {
    name: 'copy_path',
    description: 'Copy a path to the system clipboard',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: ['native.clipboard'],
  },
];

const plan: ActionPlan = {
  id: 'immutable-plan',
  digest: 'immutable-digest',
  title: 'Organize selected files',
  createdAt: 1,
  scopeIds: ['scope'],
  actions: [
    {
      id: 'copy',
      kind: 'copy_file',
      source: '/selected/original.txt',
      target: '/selected/copied.txt',
      effects: ['file.read', 'file.write'],
    },
    {
      id: 'move',
      kind: 'move_file',
      source: '/selected/copied.txt',
      target: '/selected/organized.txt',
      effects: ['file.read', 'file.write', 'file.remove'],
    },
  ],
};

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: '{}' });
const response = (toolCalls: ToolCall[] = [], content = ''): ModelResponse => ({
  content,
  toolCalls,
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
});

function fixture(
  script: ModelResponse[],
  settings: {
    decision?: PermissionDecision;
    signal?: AbortSignal;
    customize?: (prepared: PreparedTool) => PreparedTool;
    planResult?: ToolResult;
    definitions?: ToolDefinition[];
  } = {},
) {
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const approvedCalls: string[] = [];
  const executed: string[] = [];
  const durableDecisions: { id: string; decision: PermissionDecision }[] = [];
  const skipped: { id: string; reason: 'cancelled' | 'failed' }[] = [];
  const availableDefinitions = settings.definitions ?? definitions;
  const options: AgentOptions = {
    executionId: 'execution',
    signal: settings.signal ?? new AbortController().signal,
    messages: [{ role: 'user', content: 'Organize selected files and report what changed.' }],
    onEvent: (event) => {
      events.push(event);
    },
    model: {
      stream: async (request) => {
        requests.push(request);
        const next = script.shift();
        if (!next) throw new Error('Unexpected model request after scripted completion.');
        return next;
      },
    },
    permissions: {
      decide: async (request) => {
        approvedCalls.push(request.call.id);
        return settings.decision ?? 'allow-once';
      },
    },
    host: {
      definitions: availableDefinitions,
      prepare: async (toolCall) => {
        const definition = availableDefinitions.find((item) => item.name === toolCall.name);
        if (!definition) throw new Error('Unknown fake tool.');
        const prepared: PreparedTool = {
          call: toolCall,
          definition,
          permissionKey: `approval:${toolCall.id}`,
          requiresPermission: definition.riskLevel !== 'read',
          allowSession: false,
          preview:
            toolCall.name === 'execute_plan'
              ? { kind: 'plan', title: plan.title, plan }
              : { kind: definition.riskLevel, title: definition.description },
          onDecision: (decision) => {
            durableDecisions.push({ id: toolCall.id, decision });
          },
          onSkipped: (reason) => {
            skipped.push({ id: toolCall.id, reason });
          },
          execute: async () => {
            executed.push(toolCall.id);
            return toolCall.name === 'execute_plan'
              ? (settings.planResult ?? {
                  content: 'Approved files organized.',
                  planOutcome: {
                    planId: plan.id,
                    digest: plan.digest,
                    status: 'completed',
                    journal: [],
                  },
                })
              : { content: `Observed ${toolCall.id}.` };
          },
        };
        return settings.customize?.(prepared) ?? prepared;
      },
    },
  };
  return {
    options,
    events,
    requests,
    approvedCalls,
    executed,
    durableDecisions,
    skipped,
    run: () => runAgent(options),
  };
}

test('denying a plan blocks later shell/write/native mutations across model turns without another approval or effect', async () => {
  const h = fixture(
    [
      response([
        call('plan', 'execute_plan'),
        call('same-turn-shell', 'shell'),
        call('same-turn-write', 'write_file'),
      ]),
      response([
        call('later-shell', 'shell'),
        call('later-write', 'write_file'),
        call('later-native', 'copy_path'),
        call('safe-read', 'read_file'),
      ]),
      response([], 'I respected the refusal and only read the permitted file.'),
    ],
    { decision: 'deny' },
  );
  const outcome = await h.run();
  expect(outcome.state).toBe('completed');
  expect(h.approvedCalls).toEqual(['plan']);
  expect(h.executed).toEqual(['safe-read']);
  expect(h.durableDecisions).toEqual([
    { id: 'plan', decision: 'deny' },
    { id: 'same-turn-shell', decision: 'deny' },
    { id: 'same-turn-write', decision: 'deny' },
    { id: 'later-shell', decision: 'deny' },
    { id: 'later-write', decision: 'deny' },
    { id: 'later-native', decision: 'deny' },
  ]);
  expect(outcome.messages.filter((message) => message.role === 'tool')).toHaveLength(7);
  const results = h.events.filter((event) => event.type === 'tool-result');
  expect(
    results.filter((event) => event.call.id !== 'safe-read').every((event) => event.result.isError),
  ).toBe(true);
  expect(h.requests[1].messages.some((message) => message.content.includes('Do not bypass'))).toBe(
    true,
  );
});

test.each(['stale', 'partial', 'cancelled', 'failed', 'interrupted'] as const)(
  'a %s plan outcome blocks subsequent mutations while retaining its actual result and safe reads',
  async (status: PlanStatus) => {
    const planResult: ToolResult = {
      content: `Observed Action Plan outcome: ${status}; inspect completed effects before starting another task.`,
      isError: true,
      planOutcome: { planId: plan.id, digest: plan.digest, status, journal: [] },
    };
    const h = fixture(
      [
        response([
          call('plan', 'execute_plan'),
          call('shell', 'shell'),
          call('write', 'write_file'),
        ]),
        response([
          call('retry-plan', 'execute_plan'),
          call('native', 'copy_path'),
          call('read', 'read_file'),
        ]),
        response([], `Reported ${status} without retrying file changes.`),
      ],
      { planResult },
    );
    const outcome = await h.run();
    expect(outcome.state).toBe('completed');
    expect(h.approvedCalls).toEqual(['plan']);
    expect(h.executed).toEqual(['plan', 'read']);
    expect(outcome.messages.find((message) => message.toolCallId === 'plan')?.content).toBe(
      planResult.content,
    );
    expect(
      h.events.find((event) => event.type === 'tool-result' && event.call.id === 'plan'),
    ).toMatchObject({ result: planResult });
    expect(
      h.durableDecisions
        .filter((decision) => decision.id !== 'plan')
        .every((decision) => decision.decision === 'deny'),
    ).toBe(true);
  },
);

test.each(['synchronous', 'asynchronous'] as const)(
  'a %s durable approval failure stops execution before any effect and finalizes prepared work safely',
  async (mode) => {
    const h = fixture([response([call('plan', 'execute_plan'), call('queued-shell', 'shell')])], {
      customize: (prepared) => ({
        ...prepared,
        onDecision:
          mode === 'synchronous'
            ? () => {
                throw new Error('PRIVATE_JOURNAL_APPROVAL_FAILURE');
              }
            : async () => {
                throw new Error('PRIVATE_JOURNAL_APPROVAL_FAILURE');
              },
      }),
    });
    const outcome = await h.run();
    expect(outcome.state).toBe('failed');
    expect(h.approvedCalls).toEqual(['plan']);
    expect(h.executed).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.skipped).toEqual([{ id: 'plan', reason: 'failed' }]);
    expect(h.events.filter((event) => event.type === 'permission-decision')).toEqual([]);
    expect(outcome.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_JOURNAL');
    expect(JSON.stringify(h.events)).not.toContain('PRIVATE_JOURNAL');
  },
);

test('Stop awaits host cleanup and preserves a partial durable result in events/history instead of generic cancellation', async () => {
  const controller = new AbortController();
  let cleanupFinished = false;
  const partial: ToolResult = {
    content: 'Copied original.txt. The next move was cancelled; the copied file remains.',
    isError: true,
    planOutcome: {
      planId: plan.id,
      digest: plan.digest,
      status: 'partial',
      journal: [
        { planId: plan.id, actionId: 'copy', sequence: 1, status: 'prepared', at: 1 },
        { planId: plan.id, actionId: 'move', sequence: 2, status: 'prepared', at: 2 },
        { planId: plan.id, actionId: 'copy', sequence: 3, status: 'running', at: 3 },
        { planId: plan.id, actionId: 'copy', sequence: 4, status: 'succeeded', at: 4 },
        { planId: plan.id, actionId: 'move', sequence: 5, status: 'cancelled', at: 5 },
      ],
    },
  };
  const h = fixture([response([call('plan', 'execute_plan'), call('queued-shell', 'shell')])], {
    signal: controller.signal,
    customize: (prepared) => ({
      ...prepared,
      execute: async (signal) => {
        h.executed.push(prepared.call.id);
        controller.abort();
        expect(signal.aborted).toBe(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        cleanupFinished = true;
        return partial;
      },
    }),
  });
  const outcome = await h.run();
  expect(cleanupFinished).toBe(true);
  expect(outcome.state).toBe('cancelled');
  expect(h.executed).toEqual(['plan']);
  expect(h.approvedCalls).toEqual(['plan']);
  expect(h.requests).toHaveLength(1);
  expect(h.skipped).toEqual([]);
  const toolMessages = outcome.messages.filter((message) => message.role === 'tool');
  expect(toolMessages).toHaveLength(2);
  expect(toolMessages[0]).toEqual({ role: 'tool', content: partial.content, toolCallId: 'plan' });
  expect(toolMessages[1]).toMatchObject({
    toolCallId: 'queued-shell',
    content: 'Tool action cancelled before completion.',
  });
  const planResults = h.events.filter(
    (event) => event.type === 'tool-result' && event.call.id === 'plan',
  );
  expect(planResults).toHaveLength(1);
  expect(planResults[0]).toMatchObject({ result: partial });
  const resultIndex = h.events.indexOf(planResults[0]);
  const finalIndex = h.events.findIndex(
    (event) => event.type === 'state' && event.state === 'cancelled',
  );
  expect(resultIndex).toBeLessThan(finalIndex);
});

const privilegedEffects: Effect[] = [
  'file.write',
  'file.remove',
  'process.execute',
  'network.search',
  'network.fetch',
  'native.reveal',
  'native.clipboard',
];

function effectDefinition(effect?: Effect): ToolDefinition {
  return {
    name: 'effect_tool',
    description: 'Effect contract fixture',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    ...(effect ? { effects: [effect] } : {}),
  };
}

test.each(privilegedEffects)(
  '%s requires its own approval even when the host marks it read-only and requests a session grant',
  async (effect) => {
    const h = fixture(
      [
        response([call('first', 'effect_tool'), call('second', 'effect_tool')]),
        response([], 'Done'),
      ],
      {
        definitions: [effectDefinition(effect)],
        customize: (prepared) => ({
          ...prepared,
          permissionKey: 'shared-read-key-cannot-grant-effects',
          requiresPermission: false,
          allowSession: true,
        }),
      },
    );
    expect((await h.run()).state).toBe('completed');
    expect(h.approvedCalls).toEqual(['first', 'second']);
    expect(h.executed).toEqual(['first', 'second']);
    expect(
      h.events
        .filter((event) => event.type === 'permission-request')
        .map((event) => event.request.allowSession),
    ).toEqual([false, false]);
    expect(h.durableDecisions.map((decision) => decision.decision)).toEqual([
      'allow-once',
      'allow-once',
    ]);
  },
);

test.each(privilegedEffects)(
  '%s rejects an invalid allow-session reply and never executes the effect',
  async (effect) => {
    const h = fixture([response([call('effect', 'effect_tool')]), response([], 'Refused safely')], {
      definitions: [effectDefinition(effect)],
      decision: 'allow-session',
      customize: (prepared) => ({ ...prepared, requiresPermission: false, allowSession: true }),
    });
    expect((await h.run()).state).toBe('completed');
    expect(h.approvedCalls).toEqual(['effect']);
    expect(h.executed).toEqual([]);
    expect(h.durableDecisions).toEqual([{ id: 'effect', decision: 'deny' }]);
    expect(h.events.find((event) => event.type === 'permission-request')).toMatchObject({
      request: { allowSession: false },
    });
    expect(h.events.find((event) => event.type === 'tool-result')).toMatchObject({
      result: { isError: true },
    });
  },
);

test.each(['legacy-effects-absent', 'explicit-file-read'] as const)(
  '%s preserves opt-in read-session grants without broadening permissions',
  async (style) => {
    const h = fixture(
      [
        response([call('first', 'effect_tool'), call('second', 'effect_tool')]),
        response([], 'Read done'),
      ],
      {
        definitions: [effectDefinition(style === 'explicit-file-read' ? 'file.read' : undefined)],
        decision: 'allow-session',
        customize: (prepared) => ({
          ...prepared,
          requiresPermission: true,
          allowSession: true,
          permissionKey: 'same-approved-file-scope',
        }),
      },
    );
    expect((await h.run()).state).toBe('completed');
    expect(h.approvedCalls).toEqual(['first']);
    expect(h.executed).toEqual(['first', 'second']);
    expect(h.events.find((event) => event.type === 'permission-request')).toMatchObject({
      request: { allowSession: true },
    });
  },
);

test('legacy read hosts without effects retain their existing no-prompt behavior when reads do not require approval', async () => {
  const h = fixture([response([call('read', 'effect_tool')]), response([], 'Read done')], {
    definitions: [effectDefinition()],
    customize: (prepared) => ({ ...prepared, requiresPermission: false, allowSession: false }),
  });
  expect((await h.run()).state).toBe('completed');
  expect(h.approvedCalls).toEqual([]);
  expect(h.executed).toEqual(['read']);
});
