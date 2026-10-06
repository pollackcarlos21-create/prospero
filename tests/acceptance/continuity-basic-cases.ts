import { expect } from 'bun:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceCase, CaseContext, Planner } from './harness';
import type { StructuredAction } from '../../packages/core/src';
import { desktopTaskLimits } from '../../apps/desktop/src/main/service';

const ref = (ctx: CaseContext, path: string) => ({ scopeId: ctx.scopeId, path });
const singlePlan =
  (title: string, actions: StructuredAction[]): Planner =>
  (_request, _task, results) =>
    results.length
      ? { text: `Actual execution outcome: ${results.at(-1)?.content}` }
      : { tool: 'execute_plan', args: { title, actions } };

export const basicContinuityCases: AcceptanceCase[] = [
  {
    id: 'C01',
    title: 'Changed classification uses a fresh plan and approval',
    async run(ctx) {
      await writeFile(join(ctx.root, 'paper.pdf'), '%PDF synthetic classification fixture');
      await ctx.run(
        'Classify paper.pdf under Retrieval.',
        singlePlan('Initial classification', [
          { kind: 'create_directory', target: ref(ctx, 'Retrieval') },
          {
            kind: 'move_file',
            source: ref(ctx, 'paper.pdf'),
            target: ref(ctx, 'Retrieval/paper.pdf'),
          },
        ]),
      );
      const first = ctx.approvals[0];
      const result = await ctx.run(
        'Change my classification to Evaluation; inspect the current file and propose a new approved move.',
        (_request, _task, results) => {
          if (!results.length)
            return {
              tool: 'get_file_info',
              args: { scopeId: ctx.scopeId, path: 'Retrieval/paper.pdf' },
            };
          if (results.length === 1) {
            const info = JSON.parse(results[0].content);
            expect(info.type).toBe('file');
            return {
              tool: 'execute_plan',
              args: {
                title: 'Reclassify after explicit user change',
                actions: [
                  { kind: 'create_directory', target: ref(ctx, 'Evaluation') },
                  {
                    kind: 'move_file',
                    source: ref(ctx, 'Retrieval/paper.pdf'),
                    target: ref(ctx, 'Evaluation/paper.pdf'),
                  },
                ],
              },
            };
          }
          return {
            text: `Current classification Evaluation; actual new action result ${results.at(-1)?.content}`,
          };
        },
      );
      expect(result.state).toBe('completed');
      expect(await readFile(join(ctx.root, 'Evaluation/paper.pdf'), 'utf8')).toBe(
        '%PDF synthetic classification fixture',
      );
      expect(await readdir(join(ctx.root, 'Retrieval'))).toEqual([]);
      const plans = ctx.approvals.filter((p) => p.preview.plan);
      expect(plans).toHaveLength(2);
      expect(plans[0].preview.plan?.digest).not.toBe(plans[1].preview.plan?.digest);
      expect(result.actionPlans?.map((p) => p.status)).toEqual(['completed', 'completed']);
      expect(() => ctx.approve(first)).toThrow('awaiting');
    },
  },
  {
    id: 'C03',
    title: 'Approval wait stays responsive and resumes within task budgets',
    async run(ctx) {
      const content = 'Approved after a responsive wait.\n';
      let waited = 0;
      const result = await ctx.run(
        'Show the preview and wait before writing note.txt.',
        singlePlan('Wait for approval', [
          { kind: 'write_text', target: ref(ctx, 'note.txt'), content },
        ]),
        {
          onPermission: async (request) => {
            const before = performance.now();
            expect(request.preview.plan?.actions).toHaveLength(1);
            await expect(stat(join(ctx.root, 'note.txt'))).rejects.toThrow();
            expect(
              ctx.service.bootstrap().conversations.some((c) => c.id === ctx.conversationId),
            ).toBe(true);
            expect(ctx.service.getConversation(ctx.conversationId).state).toBe(
              'waiting-permission',
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            expect(
              ctx.service.getConversation(ctx.conversationId).pendingPermission?.requestId,
            ).toBe(request.requestId);
            await expect(stat(join(ctx.root, 'note.txt'))).rejects.toThrow();
            waited = performance.now() - before;
            return 'allow-once';
          },
        },
      );
      expect(waited).toBeGreaterThanOrEqual(240);
      expect(result.state).toBe('completed');
      expect(await readFile(join(ctx.root, 'note.txt'), 'utf8')).toBe(content);
      expect(result.actionPlans?.at(-1)?.status).toBe('completed');
      expect(ctx.approvals).toHaveLength(1);
      expect(desktopTaskLimits.maxPermissionWaitMs).toBe(300_000);
      expect(desktopTaskLimits.maxExecutionMs).toBe(600_000);
      expect(desktopTaskLimits.maxWallClockMs).toBe(1_800_000);
      // Actual 250ms wait/resume; deadline separation/expiry uses the independently scaled core regressions.
    },
  },
  {
    id: 'C08',
    title: 'A temporary Web error recovers using one preapproved alternative query',
    async run(ctx) {
      const primary = 'RouteBudget Cai Rao 2025';
      const alternative = 'RouteBudget Cai Rao 2025 official paper';
      const url = 'https://papers.acceptance.example/route-budget-recovery';
      const fact = 'The frozen routing method uses two skill calls under a declared budget.';
      ctx.configureWeb({
        searches: {
          [primary]: [],
          [alternative]: [
            { url, title: 'RouteBudget Cai Rao 2025', description: 'Synthetic paper identity.' },
          ],
        },
        pages: {
          [url]: {
            html: `<html><title>RouteBudget</title><main><p>Identity: RouteBudget Cai Rao 2025</p><p>Conclusion: ${fact}</p></main></html>`,
          },
        },
      });
      ctx.beforeWeb = async (kind, input) =>
        kind === 'search' && input === primary
          ? {
              status: 503,
              headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode('{"private":"TEMPORARY_ERROR_BODY_NOT_EVIDENCE"}'),
            }
          : undefined;
      const result = await ctx.run(
        'Research RouteBudget. On a temporary failure use the one approved alternate query, with no scope reset.',
        (_request, _task, results) => {
          if (!results.length)
            return {
              tool: 'authorize_research',
              args: {
                title: 'Bounded network recovery',
                queries: [primary, alternative].map((query) => ({ query, maxResults: 2 })),
                maxFetches: 1,
                maxResponseBytes: 8 * 1024 * 1024,
                lifetimeSeconds: 60,
              },
            };
          if (results.length === 1)
            return { tool: 'web_search', args: { query: primary, maxResults: 2 } };
          if (results.length === 2) {
            expect(results[1].content).toContain('temporarily unavailable');
            return { tool: 'web_search', args: { query: alternative, maxResults: 2 } };
          }
          if (results.length === 3) {
            const source = JSON.parse(results[2].content).sources[0];
            expect(source).toBeDefined();
            return { tool: 'fetch_source', args: { sourceId: source.id } };
          }
          const page = JSON.parse(results[3].content).sources[0];
          const conclusion = /Conclusion: ([^\n]+)/.exec(page.content)?.[1];
          if (!conclusion) throw new Error('Actual replacement page evidence is missing.');
          return {
            text: `The first approved search was temporarily unavailable. The alternate query produced this page: ${conclusion} [source:${page.id}]`,
          };
        },
      );
      expect(result.state).toBe('completed');
      expect(result.messages.at(-1)?.content).toContain(fact);
      expect(result.messages.at(-1)?.content).not.toContain('TEMPORARY_ERROR_BODY_NOT_EVIDENCE');
      expect(ctx.webRequests.map(({ kind, status }) => [kind, status])).toEqual([
        ['search', 503],
        ['search', 200],
        ['fetch', 200],
      ]);
      expect(ctx.approvals).toHaveLength(1);
      const events = result.researchPlans?.[0].events ?? [];
      expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'completed')).toHaveLength(2);
      expect(
        result.sources?.some(
          (source) =>
            source.kind === 'page' &&
            source.url === url &&
            result.messages.at(-1)?.content.includes(`[source:${source.id}]`),
        ),
      ).toBe(true);
    },
  },
  {
    id: 'C10',
    title: 'A denied run cannot switch tools; an explicit new task completes with new approval',
    async run(ctx) {
      const workspace = await ctx.service.chooseWorkspace(ctx.conversationId);
      ctx.scopeId = workspace.scopes?.find((scope) => scope.path === ctx.root)?.id ?? '';
      expect(ctx.scopeId).toBe('workspace');
      await writeFile(join(ctx.root, 'input.txt'), 'Keep until newly approved.');
      await ctx.run(
        'Propose moving input.txt to denied.txt.',
        (_request, _task, results) => {
          if (!results.length)
            return {
              tool: 'execute_plan',
              args: {
                title: 'Denied move',
                actions: [
                  {
                    kind: 'move_file',
                    source: ref(ctx, 'input.txt'),
                    target: ref(ctx, 'denied.txt'),
                  },
                ],
              },
            };
          if (results.length === 1)
            return { tool: 'shell', args: { command: 'mv input.txt denied.txt' } };
          if (results.length === 2)
            return {
              tool: 'write_file',
              args: {
                scopeId: ctx.scopeId,
                path: 'denied.txt',
                content: 'Bypass attempt must not write.',
              },
            };
          return {
            text: `The requested mutation was denied. Observed blocked attempts: ${results.map((r) => r.content).join('; ')}`,
          };
        },
        { onPermission: async () => 'deny' },
      );
      expect(ctx.approvals).toHaveLength(1);
      expect(await readdir(ctx.root)).toEqual(['input.txt']);
      expect(ctx.service.getConversation(ctx.conversationId).actionPlans?.[0].status).toBe(
        'denied',
      );
      const second = await ctx.run(
        'Start a new task: inspect input.txt and explicitly approve moving it to allowed.txt.',
        (_request, _task, results) => {
          if (!results.length)
            return { tool: 'read_file', args: { scopeId: ctx.scopeId, path: 'input.txt' } };
          if (results.length === 1) {
            expect(results[0].content).toBe('Keep until newly approved.');
            return {
              tool: 'execute_plan',
              args: {
                title: 'New explicitly authorized move',
                actions: [
                  {
                    kind: 'move_file',
                    source: ref(ctx, 'input.txt'),
                    target: ref(ctx, 'allowed.txt'),
                  },
                ],
              },
            };
          }
          return { text: `New task actual result: ${results.at(-1)?.content}` };
        },
      );
      expect(second.state).toBe('completed');
      expect(await readdir(ctx.root)).toEqual(['allowed.txt']);
      expect(await readFile(join(ctx.root, 'allowed.txt'), 'utf8')).toBe(
        'Keep until newly approved.',
      );
      expect(ctx.approvals.filter((p) => p.preview.plan)).toHaveLength(2);
      expect(second.actionPlans?.map((p) => p.status)).toEqual(['denied', 'completed']);
      expect(second.actionPlans?.[0].plan.digest).not.toBe(second.actionPlans?.[1].plan.digest);
    },
  },
];
