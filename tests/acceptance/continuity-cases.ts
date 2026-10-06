import { expect } from 'bun:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StructuredAction, PermissionRequest } from '../../packages/core/src';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { CapturedRequest, FakeResponse } from '../e2e/fake-provider';
import { basicContinuityCases } from './continuity-basic-cases';
import type { AcceptanceCase, CaseContext, Planner } from './harness';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing continuity fixture result.');
  return value;
}
function ref(ctx: CaseContext, path: string) {
  return { scopeId: ctx.scopeId, path };
}
function tool(tool: string, args: unknown): FakeResponse {
  return { tool, args };
}
function plan(title: string, actions: StructuredAction[]): FakeResponse {
  return tool('execute_plan', { title, actions });
}
function outcome(results: Parameters<Planner>[2]): FakeResponse {
  return { text: `Observed result: ${results.at(-1)?.content ?? 'none'}` };
}
function sources(results: Parameters<Planner>[2]) {
  const value = JSON.parse(required(results.at(-1)).content) as {
    sources?: {
      id: string;
      url: string;
      kind: string;
      title: string;
      content: string;
      citation: string;
    }[];
  };
  if (!Array.isArray(value.sources)) throw new Error('No actual source receipt.');
  return value.sources;
}
function statuses(value: Conversation, index: number) {
  const record = required(value.actionPlans?.[index]);
  return record.plan.actions.map(
    (action) => record.journal.findLast((entry) => entry.actionId === action.id)?.status,
  );
}
function researchInput(title: string, queries: string[], fetches = 1) {
  return {
    title,
    queries: queries.map((query) => ({ query, maxResults: 1 })),
    maxFetches: fetches,
    maxResponseBytes: 4 * 1024 * 1024,
    lifetimeSeconds: 60,
  };
}

const recoveryContinuityCases: AcceptanceCase[] = [
  {
    id: 'C02',
    title:
      'Continue a long conversation with bounded summary, source identity, constraints and real file results',
    async run(ctx) {
      await writeFile(join(ctx.root, 'original.txt'), 'Keep these original bytes.\n');
      const query = 'Continuity fixture constraints';
      const url = 'https://continuity.acceptance.example/constraints';
      ctx.configureWeb({
        searches: {
          [query]: [
            { url, title: 'Continuity constraints', description: 'A frozen public fixture.' },
          ],
        },
        pages: {
          [url]: {
            html: '<html><head><title>Continuity constraints</title></head><body><article><p>Keep original.txt unchanged. Copy it into SummaryCopies. This is a synthetic fixture.</p></article></body></html>',
          },
        },
      });
      let pageId = '';
      await ctx.run(
        'Read the continuity fixture; preserve original.txt and later copy it into SummaryCopies.',
        (_request, _task, results) => {
          if (!results.length)
            return tool(
              'authorize_research',
              researchInput('Read continuity constraints', [query]),
            );
          if (results.length === 1) return tool('web_search', { query });
          if (results.length === 2)
            return tool('fetch_source', { sourceId: required(sources(results)[0]).id });
          const page = required(sources(results)[0]);
          expect(page.content).toContain('Keep original.txt unchanged');
          pageId = page.id;
          return {
            text: `Preserve original.txt. Copy only into SummaryCopies; no move/delete. ${page.citation}`,
          };
        },
      );
      let summaryCalls = 0;
      const summary = 'C02_EXECUTION_ONLY_SUMMARY_SENTINEL';
      const summarize = (request: CapturedRequest): FakeResponse | undefined => {
        if (
          request.messages[0]?.role !== 'system' ||
          !request.messages[0].content.startsWith('Summarize conversation data')
        )
          return undefined;
        summaryCalls++;
        const input = required(request.messages.find((message) => message.role === 'user')).content;
        const data = JSON.parse(input.slice(input.indexOf('\n') + 1)) as {
          previousSummary: string;
          messages: { content: string }[];
        };
        const observed = [
          data.previousSummary,
          ...data.messages.map((message) => message.content),
        ].join('\n');
        const constraint = observed.match(
          /Preserve original\.txt\. Copy only into SummaryCopies; no move\/delete\./,
        )?.[0];
        const references = [...observed.matchAll(/\[source:(src_[a-f0-9]{24})\]/g)].map(
          (match) => match[0],
        );
        expect(constraint).toBeDefined();
        expect(references).toContain(`[source:${pageId}]`);
        return {
          text: `${summary}\n${required(constraint)}\n${[...new Set(references)].join(' ')}`,
        };
      };
      for (let number = 0; number < 13; number++)
        await ctx.run(
          `Continuity discussion ${number}; original constraints still apply.`,
          (request) =>
            summarize(request) ?? {
              text: `Unrelated synthetic discussion ${number}. ${'Additional public discussion. '.repeat(650)}`,
            },
        );
      const before = ctx.providerRequests.length;
      const result = await ctx.run(
        'Now complete the original copy goal, preserving the original and its source identity.',
        (request, _task, results) => {
          const compact = summarize(request);
          if (compact) return compact;
          const context = JSON.stringify(request.messages);
          expect(context).toContain('SummaryCopies');
          expect(context).toContain(pageId);
          if (!results.length)
            return tool('read_file', { scopeId: ctx.scopeId, path: 'original.txt' });
          if (results.length === 1) {
            expect(results[0]?.content).toBe('Keep these original bytes.\n');
            return plan('Complete copy after long discussion', [
              { kind: 'create_directory', target: ref(ctx, 'SummaryCopies') },
              {
                kind: 'copy_file',
                source: ref(ctx, 'original.txt'),
                target: ref(ctx, 'SummaryCopies/original.txt'),
              },
            ]);
          }
          return {
            text: `The approved copy completed; original was preserved. [source:${pageId}] ${results.at(-1)?.content}`,
          };
        },
      );
      expect(summaryCalls).toBeGreaterThan(0);
      expect(result.state).toBe('completed');
      expect(await readFile(join(ctx.root, 'original.txt'), 'utf8')).toBe(
        'Keep these original bytes.\n',
      );
      expect(await readFile(join(ctx.root, 'SummaryCopies/original.txt'), 'utf8')).toBe(
        'Keep these original bytes.\n',
      );
      expect(result.actionPlans?.at(-1)?.status).toBe('completed');
      expect(result.sources?.some((source) => source.id === pageId && source.kind === 'page')).toBe(
        true,
      );
      expect(JSON.stringify(ctx.store.getConversation(ctx.conversationId))).not.toContain(summary);
      expect(ctx.providerRequests.length).toBeGreaterThan(before);
    },
  },
  {
    id: 'C04',
    title:
      'Stop research and report completed search/page evidence and unfinished work without extra model calls',
    async run(ctx) {
      const first = 'First continuity paper';
      const second = 'Second continuity paper';
      const url = 'https://continuity.acceptance.example/first';
      ctx.configureWeb({
        searches: {
          [first]: [{ url, title: 'First paper', description: 'Search snippet only.' }],
          [second]: [],
        },
        pages: {
          [url]: {
            html: '<html><head><title>First paper full page</title></head><body><article><p>C04_EPHEMERAL_PAGE_BODY Evidence for the first paper.</p></article></body></html>',
          },
        },
      });
      let pageId = '';
      let searchId = '';
      ctx.beforeWeb = async (kind, input, signal) => {
        if (kind !== 'search' || input !== second) return undefined;
        queueMicrotask(() => {
          void ctx.service.stopTask(ctx.conversationId);
        });
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Synthetic request cancelled')), {
            once: true,
          });
          if (signal.aborted) reject(new Error('Synthetic request cancelled'));
        });
        return undefined;
      };
      const stopped = await ctx.run(
        'Research two papers; Stop must give an accurate result list.',
        (_request, _task, results) => {
          if (!results.length)
            return tool('authorize_research', researchInput('Two-paper research', [first, second]));
          if (results.length === 1) return tool('web_search', { query: first });
          if (results.length === 2) {
            searchId = required(sources(results)[0]).id;
            return tool('fetch_source', { sourceId: searchId });
          }
          if (results.length === 3) {
            pageId = required(sources(results)[0]).id;
            return tool('web_search', { query: second });
          }
          throw new Error('Stop must not cause another model request.');
        },
      );
      expect(stopped.state).toBe('cancelled');
      expect(ctx.providerRequests).toHaveLength(4);
      expect(ctx.webRequests.map((request) => request.input)).toEqual([first, url, second]);
      expect(ctx.webRequests.at(-1)).toMatchObject({
        kind: 'search',
        input: second,
        status: 0,
        bytes: 0,
        outcome: 'cancelled',
        responseBytesKnown: false,
      });
      expect(pageId).not.toBe(searchId);
      const report = required(stopped.messages.at(-1)).content;
      expect(report).toContain(`Search completed (1 sources): ${first}`);
      expect(report).toContain(`Search not completed: ${second}`);
      expect(report).toContain(`Saved search source: First paper [source:${searchId}]`);
      expect(report).toContain(`Saved page source: First paper full page [source:${pageId}]`);
      expect(report).not.toContain('C04_EPHEMERAL_PAGE_BODY');
      expect(JSON.stringify(ctx.store.getConversation(ctx.conversationId))).not.toContain(
        'C04_EPHEMERAL_PAGE_BODY',
      );
      expect(
        stopped.researchPlans?.[0]?.events.filter((event) => event.type === 'completed'),
      ).toHaveLength(2);
      expect(
        stopped.researchPlans?.[0]?.events.filter((event) => event.type === 'failed'),
      ).toHaveLength(1);
      expect(
        stopped.sources?.some((source) => source.id === pageId && source.kind === 'page'),
      ).toBe(true);
      ctx.beforeWeb = undefined;
    },
  },
  {
    id: 'C05',
    title: 'Stop file operations, inspect completed effects and approve only remaining work',
    async run(ctx) {
      await writeFile(join(ctx.root, 'trash-me.txt'), 'Recoverable Trash bytes');
      ctx.beforeNative = async (kind) => {
        if (kind !== 'trash') return;
        queueMicrotask(() => {
          void ctx.service.stopTask(ctx.conversationId);
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      };
      const stopped = await ctx.run(
        'Create first.txt, trash the selected file and create last.txt.',
        (_request, _task, results) =>
          results.length
            ? outcome(results)
            : plan('Stop an approved file batch', [
                {
                  kind: 'write_text',
                  target: ref(ctx, 'first.txt'),
                  content: 'First completed bytes',
                },
                { kind: 'trash_file', target: ref(ctx, 'trash-me.txt') },
                { kind: 'write_text', target: ref(ctx, 'last.txt'), content: 'Remaining bytes' },
              ]),
      );
      expect(stopped.state).toBe('cancelled');
      expect(stopped.actionPlans?.[0]?.status).toBe('partial');
      expect(statuses(stopped, 0)).toEqual(['succeeded', 'succeeded', 'cancelled']);
      expect(await readFile(join(ctx.root, 'first.txt'), 'utf8')).toBe('First completed bytes');
      expect(await readFile(join(ctx.temp, 'fixture-trash/trash-me.txt'), 'utf8')).toBe(
        'Recoverable Trash bytes',
      );
      await expect(stat(join(ctx.root, 'last.txt'))).rejects.toThrow();
      expect(stopped.messages.at(-1)?.content).toContain('Not completed: Write text');
      ctx.beforeNative = undefined;
      await ctx.run(
        'Continue after Stop: verify current files and finish only last.txt with new approval.',
        (_request, _task, results) => {
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            const entries = JSON.parse(required(results[0]).content).entries as { name: string }[];
            expect(entries.map((entry) => entry.name)).toEqual(['first.txt']);
            return tool('read_file', { scopeId: ctx.scopeId, path: 'first.txt' });
          }
          if (results.length === 2) {
            expect(results[1]?.content).toBe('First completed bytes');
            return plan('Finish only the remaining file', [
              { kind: 'write_text', target: ref(ctx, 'last.txt'), content: 'Remaining bytes' },
            ]);
          }
          return outcome(results);
        },
      );
      const result = ctx.service.getConversation(ctx.conversationId);
      expect(result.actionPlans?.map((record) => record.status)).toEqual(['partial', 'completed']);
      expect(ctx.approvals.filter((entry) => entry.preview.plan)).toHaveLength(2);
      expect(ctx.nativeEffects.filter((entry) => entry.kind === 'trash')).toHaveLength(1);
      expect(await readFile(join(ctx.root, 'last.txt'), 'utf8')).toBe('Remaining bytes');
    },
  },
  {
    id: 'C06',
    title:
      'Complete remaining actions after partial native failure without replaying the successful copy',
    async run(ctx) {
      await writeFile(join(ctx.root, 'input.txt'), 'Source stays intact');
      await writeFile(join(ctx.root, 'trash-me.txt'), 'Native failure fixture');
      ctx.beforeNative = async () => {
        throw new Error('PRIVATE_NATIVE_FAILURE');
      };
      const partial = await ctx.run(
        'Copy input, trash the selected file and create remaining.txt.',
        (_request, _task, results) =>
          results.length
            ? outcome(results)
            : plan('Batch with temporary native fault', [
                {
                  kind: 'copy_file',
                  source: ref(ctx, 'input.txt'),
                  target: ref(ctx, 'copied.txt'),
                },
                { kind: 'trash_file', target: ref(ctx, 'trash-me.txt') },
                {
                  kind: 'write_text',
                  target: ref(ctx, 'remaining.txt'),
                  content: 'Completed remaining work',
                },
              ]),
      );
      expect(partial.actionPlans?.[0]?.status).toBe('partial');
      expect(statuses(partial, 0)).toEqual(['succeeded', 'failed', 'skipped']);
      expect(await readFile(join(ctx.root, 'copied.txt'), 'utf8')).toBe('Source stays intact');
      expect(await readFile(join(ctx.root, 'trash-me.txt'), 'utf8')).toBe('Native failure fixture');
      expect(JSON.stringify(partial)).not.toContain('PRIVATE_NATIVE_FAILURE');
      ctx.beforeNative = undefined;
      const finished = await ctx.run(
        'Recover after the native error: inspect current files and approve only the uncompleted work.',
        (request, _task, results) => {
          expect(JSON.stringify(request.messages)).toContain('needs-inspection');
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            const names = (
              JSON.parse(required(results[0]).content).entries as { name: string }[]
            ).map((entry) => entry.name);
            expect(names.sort()).toEqual(['copied.txt', 'input.txt', 'trash-me.txt']);
            return tool('read_file', { scopeId: ctx.scopeId, path: 'copied.txt' });
          }
          if (results.length === 2) {
            expect(results[1]?.content).toBe('Source stays intact');
            return plan('Fresh approval for remaining work', [
              { kind: 'trash_file', target: ref(ctx, 'trash-me.txt') },
              {
                kind: 'write_text',
                target: ref(ctx, 'remaining.txt'),
                content: 'Completed remaining work',
              },
            ]);
          }
          return outcome(results);
        },
      );
      expect(finished.actionPlans?.map((record) => record.status)).toEqual([
        'partial',
        'completed',
      ]);
      expect(
        finished.actionPlans?.at(-1)?.plan.actions.some((action) => action.kind === 'copy_file'),
      ).toBe(false);
      expect(await readFile(join(ctx.root, 'copied.txt'), 'utf8')).toBe('Source stays intact');
      expect(await readFile(join(ctx.root, 'input.txt'), 'utf8')).toBe('Source stays intact');
      expect(await readFile(join(ctx.root, 'remaining.txt'), 'utf8')).toBe(
        'Completed remaining work',
      );
      expect(ctx.nativeEffects.filter((effect) => effect.kind === 'trash')).toHaveLength(1);
      expect(ctx.approvals.filter((entry) => entry.preview.plan)).toHaveLength(2);
    },
  },
  {
    id: 'C07',
    title: 'Recover from a real process exit after an effect and before its success commit',
    async run(ctx) {
      ctx.setPlanner((_request, _task, results) =>
        results.length
          ? outcome(results)
          : plan(
              'Crash after second real effect',
              ['first.txt', 'second.txt', 'third.txt'].map((path) => ({
                kind: 'write_text',
                target: ref(ctx, path),
                content: `${path} approved content`,
              })),
            ),
      );
      await ctx.suspendForCrash();
      const servicePath = new URL('../../apps/desktop/src/main/service.ts', import.meta.url)
        .pathname;
      const storePath = new URL('../../packages/persistence/src/index.ts', import.meta.url)
        .pathname;
      const childCode = `
        import { DesktopService } from ${JSON.stringify(servicePath)};
        import { ProsperoStore } from ${JSON.stringify(storePath)};
        const store = new ProsperoStore(process.env.PROSPERO_RECOVERY_DB);
        const original = store.actionJournal.bind(store);
        store.actionJournal = (...args) => { const journal = original(...args); return { ...journal,
          transition(planId, actionId, status, detail) {
            if (actionId === 'action-2' && status === 'succeeded') process.exit(23);
            journal.transition(planId, actionId, status, detail);
          } }; };
        let service; const decisions = new Set();
        service = new DesktopService(store,
          { put: async () => {}, get: async id => id === 'brave-search' ? 'offline-brave-fixture-key' : undefined },
          { folder: async () => undefined, files: async () => [] },
          event => {
            if (event.type !== 'conversation') return;
            const request = event.conversation.pendingPermission;
            if (!request?.preview.plan || decisions.has(request.requestId)) return;
            decisions.add(request.requestId);
            process.stdout.write(JSON.stringify(request) + '\\n');
            queueMicrotask(() => service.decideActionPlan(event.conversation.id, request.requestId, request.preview.plan.digest, 'allow-once'));
          }, '0.2.0', undefined, undefined,
          () => ({ search: async () => { throw new Error('No Web request expected'); }, fetchPage: async () => { throw new Error('No Web request expected'); } }));
        await service.sendTask(process.env.PROSPERO_RECOVERY_ID, 'C07 real crash after file effects');
      `;
      let exit = -1;
      let stdout = '';
      let stderr = '';
      try {
        const child = Bun.spawn([process.execPath, '--eval', childCode], {
          cwd: new URL('../../', import.meta.url).pathname,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: ctx.temp,
            PROSPERO_RECOVERY_DB: join(ctx.temp, 'prospero.sqlite'),
            PROSPERO_RECOVERY_ID: ctx.conversationId,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const timer = setTimeout(() => child.kill(), 5000);
        exit = await child.exited;
        clearTimeout(timer);
        stdout = await new Response(child.stdout).text();
        stderr = await new Response(child.stderr).text();
      } finally {
        ctx.reopenAfterCrash();
      }
      expect({ exit, stderr }).toEqual({ exit: 23, stderr: '' });
      const oldApproval = JSON.parse(stdout.trim()) as PermissionRequest;
      ctx.approvals.push(oldApproval);
      expect(await readFile(join(ctx.root, 'first.txt'), 'utf8')).toBe(
        'first.txt approved content',
      );
      expect(await readFile(join(ctx.root, 'second.txt'), 'utf8')).toBe(
        'second.txt approved content',
      );
      await expect(stat(join(ctx.root, 'third.txt'))).rejects.toThrow();
      const restored = ctx.service.getConversation(ctx.conversationId);
      expect(restored.state).toBe('interrupted');
      expect(statuses(restored, 0)).toEqual(['succeeded', 'interrupted', 'interrupted']);
      expect(restored.messages.at(-1)?.content).toContain('effect may have occurred');
      expect(restored.pendingPermission).toBeUndefined();
      expect(ctx.providerRequests).toHaveLength(1);
      ctx.runReceipts.push({
        modelRequests: ctx.providerRequests.length,
        toolCalls: restored.timeline.filter((item) => item.type === 'tool').length,
        state: 'interrupted',
      });
      const recovered = await ctx.run(
        'After restart, inspect the possible effects and finish only third.txt with new approval.',
        (request, _task, results) => {
          expect(JSON.stringify(request.messages)).toContain('needs-inspection');
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            expect(
              (JSON.parse(required(results[0]).content).entries as { name: string }[]).map(
                (entry) => entry.name,
              ),
            ).toEqual(['first.txt', 'second.txt']);
            return tool('read_file', { scopeId: ctx.scopeId, path: 'second.txt' });
          }
          if (results.length === 2) {
            expect(results[1]?.content).toBe('second.txt approved content');
            return plan('New approval for the remaining third file', [
              {
                kind: 'write_text',
                target: ref(ctx, 'third.txt'),
                content: 'third.txt approved content',
              },
            ]);
          }
          return outcome(results);
        },
        {
          onPermission: async (request) => {
            expect(() => ctx.approve(oldApproval)).toThrow('changed');
            expect(request.preview.plan?.id).not.toBe(oldApproval.preview.plan?.id);
            return 'allow-once';
          },
        },
      );
      expect(recovered.actionPlans?.map((record) => record.status)).toEqual([
        'interrupted',
        'completed',
      ]);
      expect(recovered.actionPlans?.at(-1)?.plan.actions.map((action) => action.target)).toEqual([
        join(ctx.root, 'third.txt'),
      ]);
      expect((await readdir(ctx.root)).sort()).toEqual(['first.txt', 'second.txt', 'third.txt']);
      expect(await readFile(join(ctx.root, 'third.txt'), 'utf8')).toBe(
        'third.txt approved content',
      );
      expect(statuses(recovered, 0)).toEqual(['succeeded', 'interrupted', 'interrupted']);
    },
  },
  {
    id: 'C09',
    title:
      'Block a real SQLite running-commit failure, then inspect and complete under fresh approval',
    async run(ctx) {
      const database = new DatabaseSync(join(ctx.temp, 'prospero.sqlite'));
      try {
        database.exec(
          "CREATE TRIGGER c09_fail_running BEFORE INSERT ON action_journal WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_FAILURE'); END;",
        );
        const failed = await ctx.run(
          'Create storage-result.txt; a storage failure must block its effect.',
          (_request, _task, results) =>
            results.length
              ? outcome(results)
              : plan('Storage-sensitive first plan', [
                  {
                    kind: 'write_text',
                    target: ref(ctx, 'storage-result.txt'),
                    content: 'Recovered under fresh approval',
                  },
                ]),
        );
        expect(failed.actionPlans?.[0]?.status).toBe('failed');
        expect(statuses(failed, 0)).toEqual(['failed']);
        await expect(stat(join(ctx.root, 'storage-result.txt'))).rejects.toThrow();
        expect(JSON.stringify(failed)).not.toContain('PRIVATE_STORAGE_FAILURE');
        const oldApproval = required(ctx.approvals[0]);
        database.exec('DROP TRIGGER c09_fail_running');
        await ctx.restart();
        const recovered = await ctx.run(
          'Storage is available again: inspect current files and newly approve creating storage-result.txt.',
          (request, _task, results) => {
            expect(JSON.stringify(request.messages)).toContain('not-completed');
            if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
            if (results.length === 1) {
              expect(JSON.parse(required(results[0]).content).entries).toEqual([]);
              return plan('Fresh plan after verifying no prior effect', [
                {
                  kind: 'write_text',
                  target: ref(ctx, 'storage-result.txt'),
                  content: 'Recovered under fresh approval',
                },
              ]);
            }
            return outcome(results);
          },
          {
            onPermission: async (request) => {
              expect(() => ctx.approve(oldApproval)).toThrow('changed');
              expect(request.preview.plan?.id).not.toBe(oldApproval.preview.plan?.id);
              await expect(stat(join(ctx.root, 'storage-result.txt'))).rejects.toThrow();
              return 'allow-once';
            },
          },
        );
        expect(recovered.actionPlans?.map((record) => record.status)).toEqual([
          'failed',
          'completed',
        ]);
        expect(statuses(recovered, 1)).toEqual(['succeeded']);
        expect(await readFile(join(ctx.root, 'storage-result.txt'), 'utf8')).toBe(
          'Recovered under fresh approval',
        );
        expect(ctx.store.getConversation<Conversation>(ctx.conversationId)?.state).toBe(
          'completed',
        );
        expect(ctx.approvals.filter((entry) => entry.preview.plan)).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  },
];

export const continuityCases: AcceptanceCase[] = [
  ...basicContinuityCases,
  ...recoveryContinuityCases,
].sort((first, second) => first.id.localeCompare(second.id));
