import { expect, test } from 'bun:test';
import type { ActionPlanRecord, ResearchPlanRecord } from '../bridge';
import { RECOVERY_CONTEXT_BYTES, recoveryContextForModel } from './task-recovery';

test('large recovery history fits 24 KiB without modifying full paths, records or audit', () => {
  const plans: ActionPlanRecord[] = Array.from({ length: 31 }, (_, index) => ({
    executionId: `execution-${index}`,
    status: 'interrupted',
    plan: {
      id: `plan-${index}`,
      digest: String(index % 10).repeat(64),
      title: `Task ${index}`,
      createdAt: index,
      scopeIds: ['scope'],
      actions: Array.from({ length: 25 }, (_, number) => ({
        id: `action-${number}`,
        kind: 'move_file',
        effects: ['file.read', 'file.write', 'file.remove'],
        source: `/private/approved/source-${index}-${number}/${'论文📄'.repeat(180)}`,
        target: `/private/approved/target-${index}-${number}/${'论文📄'.repeat(180)}`,
      })),
    },
    journal: Array.from({ length: 25 }, (_, number) => ({
      planId: `plan-${index}`,
      actionId: `action-${number}`,
      sequence: number + 1,
      status: number === 0 ? 'succeeded' : 'interrupted',
      at: index,
      detail: number === 1 ? 'The effect may have occurred.' : undefined,
    })),
  }));
  const research: ResearchPlanRecord[] = Array.from({ length: 20 }, (_, index) => ({
    snapshot: {
      version: 1,
      id: `research-${index}`,
      digest: 'e'.repeat(64),
      conversationId: 'c',
      executionId: `r-${index}`,
      title: 'Research',
      createdAt: 100 + index,
      expiresAt: 1000,
      queries: Array.from({ length: 12 }, (_, number) => ({
        query: `${number} ${'中文'.repeat(250)}`,
        maxResults: 10,
      })),
      maxSearches: 12,
      maxFetches: 24,
      maxResponseBytes: 16 * 1024 * 1024,
    },
    events: [],
  }));
  const newestTarget = '/private/approved/newest/完整文件📄.txt';
  plans.push({
    executionId: 'newest-execution',
    status: 'interrupted',
    plan: {
      id: 'newest-small-plan',
      digest: 'f'.repeat(64),
      title: 'Newest small plan',
      createdAt: 200,
      scopeIds: ['scope'],
      actions: [
        { id: 'only-action', kind: 'write_text', target: newestTarget, effects: ['file.write'] },
      ],
    },
    journal: [
      {
        planId: 'newest-small-plan',
        actionId: 'only-action',
        sequence: 1,
        status: 'interrupted',
        at: 200,
      },
    ],
  });
  const before = JSON.stringify({ plans, research });
  const context = recoveryContextForModel(plans, research, []);
  const serialized = JSON.stringify(context);
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
    RECOVERY_CONTEXT_BYTES,
  );
  expect(context.trust).toBe('untrusted');
  expect(context.approvalRestored).toBe(false);
  expect(context.automaticReplay).toBe(false);
  expect(context.sourceBodyRestored).toBe(false);
  const newest = context.filePlans.find((entry) => entry.id === 'plan-30');
  expect(newest).toMatchObject({
    omittedActions: 25,
    needInspect: true,
    currentFileState: 'not-rechecked',
  });
  expect(context.omittedEarlierPlans).toBeGreaterThanOrEqual(11);
  expect(context.research[0]?.id).toBe('research-19');
  expect(context.research.some((entry) => typeof entry.omittedQueries === 'number')).toBe(true);
  const newestSmall = context.filePlans.find((entry) => entry.id === 'newest-small-plan');
  expect(Array.isArray(newestSmall?.actions)).toBe(true);
  if (!Array.isArray(newestSmall?.actions))
    throw new Error('The newest complete record was omitted.');
  expect(newestSmall.actions[0].target).toBe(newestTarget);
  expect(newestSmall.omittedActions).toBeUndefined();
  expect(JSON.stringify({ plans, research })).toBe(before);
});
