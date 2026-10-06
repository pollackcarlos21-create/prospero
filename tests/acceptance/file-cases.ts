import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPatch } from 'diff';
import type { StructuredAction } from '../../packages/core/src';
import type { FakeResponse } from '../e2e/fake-provider';
import type { AcceptanceCase, CaseContext, Planner } from './harness';

function ref(ctx: CaseContext, path: string) {
  return { scopeId: ctx.scopeId, path };
}
function tool(tool: string, args: unknown): FakeResponse {
  return { tool, args };
}
function done(results: Parameters<Planner>[2]): FakeResponse {
  const result = results.at(-1)?.content ?? '';
  return { text: `Observed action result: ${result}` };
}
function plan(_ctx: CaseContext, title: string, actions: StructuredAction[]): Planner {
  return (_request, _task, results) =>
    results.length ? done(results) : tool('execute_plan', { title, actions });
}
interface Page {
  entries: { name: string; type: string; modifiedAt: string; sizeBytes: number }[];
  nextCursor: string | null;
  timeBasis: string;
}
const pages = (results: Parameters<Planner>[2]) =>
  results.map((value) => JSON.parse(value.content) as Page);
const completed = (ctx: CaseContext) => {
  const record = ctx.service.getConversation(ctx.conversationId).actionPlans?.at(-1);
  expect(record?.status).toBe('completed');
  expect(
    record?.plan.actions.every(
      (action) =>
        record.journal.findLast((entry) => entry.actionId === action.id)?.status === 'succeeded',
    ),
  ).toBe(true);
  return record;
};

export const fileCases: AcceptanceCase[] = [
  {
    id: 'F01',
    title: 'Create directory and UTF-8 file from one full preview',
    async run(ctx) {
      const content = '\uFEFFProspero fixture\n中文与 emoji 📄\n';
      const result = await ctx.run(
        'Create Notes/note.txt with the exact supplied text.',
        plan(ctx, 'Create a note', [
          { kind: 'create_directory', target: ref(ctx, 'Notes') },
          { kind: 'write_text', target: ref(ctx, 'Notes/note.txt'), content },
        ]),
      );
      expect(result.state).toBe('completed');
      expect(await readFile(join(ctx.root, 'Notes/note.txt'), 'utf8')).toBe(content);
      expect(ctx.approvals).toHaveLength(1);
      const preview = ctx.approvals[0].preview.plan;
      expect(preview?.actions.map((action) => action.kind)).toEqual([
        'create_directory',
        'write_text',
      ]);
      const write = preview?.actions[1];
      if (!write?.diff) throw new Error('The exact approved file preview is missing.');
      // Independently reconstruct all approved bytes, including BOM, emoji and final newline.
      expect(applyPatch('', write.diff)).toBe(content);
      expect(write.bytes).toBe(Buffer.byteLength(content));
      expect(write.beforeHash).toBe(createHash('sha256').update('').digest('hex'));
      expect(write.afterHash).toBe(createHash('sha256').update(content).digest('hex'));
      completed(ctx);
    },
  },
  {
    id: 'F02',
    title: 'Copy a binary file without changing the source',
    async run(ctx) {
      const bytes = Uint8Array.from({ length: 2048 }, (_, index) => index % 256);
      await writeFile(join(ctx.root, 'source.bin'), bytes);
      await ctx.run(
        'Copy source.bin to copy.bin.',
        plan(ctx, 'Copy fixture', [
          { kind: 'copy_file', source: ref(ctx, 'source.bin'), target: ref(ctx, 'copy.bin') },
        ]),
      );
      expect(await readFile(join(ctx.root, 'copy.bin'))).toEqual(Buffer.from(bytes));
      expect(await readFile(join(ctx.root, 'source.bin'))).toEqual(Buffer.from(bytes));
      completed(ctx);
    },
  },
  {
    id: 'F03',
    title: 'Move then rename with producer-bound postconditions',
    async run(ctx) {
      await writeFile(join(ctx.root, 'source.txt'), 'Pinned bytes.\n');
      await ctx.run(
        'Move source.txt then rename it to final.txt.',
        plan(ctx, 'Move and rename', [
          { kind: 'move_file', source: ref(ctx, 'source.txt'), target: ref(ctx, 'moved.txt') },
          { kind: 'rename_file', source: ref(ctx, 'moved.txt'), target: ref(ctx, 'final.txt') },
        ]),
      );
      expect(await readFile(join(ctx.root, 'final.txt'), 'utf8')).toBe('Pinned bytes.\n');
      expect((await readdir(ctx.root)).sort()).toEqual(['final.txt']);
      expect(completed(ctx)?.plan.actions.map((action) => action.kind)).toEqual([
        'move_file',
        'rename_file',
      ]);
    },
  },
  {
    id: 'F04',
    title: 'Filter files by an explicit filesystem mtime range',
    async run(ctx) {
      for (const [name, date] of [
        ['recent.pdf', '2026-09-15'],
        ['old.pdf', '2026-07-01'],
        ['future.pdf', '2026-11-01'],
      ]) {
        await writeFile(join(ctx.root, name), `%PDF synthetic ${name}`);
        const at = new Date(`${date}T12:00:00Z`);
        await utimes(join(ctx.root, name), at, at);
      }
      let selected: string[] = [];
      const answer = await ctx.run(
        'Move PDFs with filesystem modifiedAt in [2026-09-01, 2026-10-01) to Selected; this is not a download date.',
        (_request, _task, results) => {
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            const page = pages(results)[0];
            expect(page.timeBasis).toContain('not download dates');
            selected = page.entries
              .filter(
                (entry) =>
                  entry.type === 'file' &&
                  entry.name.endsWith('.pdf') &&
                  entry.modifiedAt >= '2026-09-01' &&
                  entry.modifiedAt < '2026-10-01',
              )
              .map((entry) => entry.name);
            return tool('execute_plan', {
              title: 'Organize by filesystem modifiedAt',
              actions: [
                { kind: 'create_directory', target: ref(ctx, 'Selected') },
                ...selected.map((name) => ({
                  kind: 'move_file',
                  source: ref(ctx, name),
                  target: ref(ctx, `Selected/${name}`),
                })),
              ],
            });
          }
          return {
            text: `Used filesystem modifiedAt, not download date. Selected ${selected.join(', ')}. ${results.at(-1)?.content}`,
          };
        },
      );
      expect(selected).toEqual(['recent.pdf']);
      expect(await readdir(join(ctx.root, 'Selected'))).toEqual(['recent.pdf']);
      expect((await readdir(ctx.root)).sort()).toEqual(['Selected', 'future.pdf', 'old.pdf']);
      expect(answer.messages.at(-1)?.content).toContain('not download date');
      completed(ctx);
    },
  },
  {
    id: 'F05',
    title: 'Complete a directory listing larger than one page',
    async run(ctx) {
      const names = Array.from(
        { length: 617 },
        (_, index) => `paper-${String(index).padStart(4, '0')}.pdf`,
      );
      await Promise.all(names.map((name) => writeFile(join(ctx.root, name), '%PDF synthetic')));
      let observed: string[] = [];
      const value = await ctx.run(
        'List every direct file, following each nextCursor.',
        (_request, _task, results) => {
          if (!results.length)
            return tool('list_directory', { scopeId: ctx.scopeId, path: '.', maxEntries: 500 });
          const received = pages(results);
          const last = received.at(-1);
          if (last?.nextCursor)
            return tool('list_directory', {
              scopeId: ctx.scopeId,
              path: '.',
              maxEntries: 500,
              cursor: last.nextCursor,
            });
          observed = received.flatMap((page) => page.entries.map((entry) => entry.name));
          return {
            text: `Read ${observed.length} distinct direct entries; final nextCursor is null.`,
          };
        },
      );
      expect(value.state).toBe('completed');
      expect(observed).toEqual(names);
      expect(new Set(observed).size).toBe(617);
      expect(ctx.providerRequests.length).toBeGreaterThan(3);
      expect(ctx.providerRequests.length).toBeLessThan(24);
      expect(
        ctx.service
          .getConversation(ctx.conversationId)
          .timeline.filter((item) => item.call?.name === 'list_directory')
          .every((item) => Buffer.byteLength(item.result?.content ?? '') <= 32 * 1024),
      ).toBe(true);
    },
  },
  {
    id: 'F06',
    title: 'Preserve an existing destination and approve a new target',
    async run(ctx) {
      await writeFile(join(ctx.root, 'input.txt'), 'New bytes');
      await writeFile(join(ctx.root, 'report.txt'), 'Existing user bytes');
      let destination = '';
      await ctx.run(
        'Copy input.txt as report.txt, preserving any collision and proposing a distinct target.',
        (_request, _task, results) => {
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            const existing = new Set(pages(results)[0].entries.map((entry) => entry.name));
            destination = existing.has('report.txt') ? 'report-copy.txt' : 'report.txt';
            expect(existing.has(destination)).toBe(false);
            return tool('execute_plan', {
              title: `Preserve collision; create ${destination}`,
              actions: [
                { kind: 'copy_file', source: ref(ctx, 'input.txt'), target: ref(ctx, destination) },
              ],
            });
          }
          return done(results);
        },
      );
      expect(await readFile(join(ctx.root, 'report.txt'), 'utf8')).toBe('Existing user bytes');
      expect(await readFile(join(ctx.root, destination), 'utf8')).toBe('New bytes');
      expect(ctx.approvals[0].preview.plan?.actions[0].target).toBe(join(ctx.root, destination));
      completed(ctx);
    },
  },
  {
    id: 'F07',
    title: 'Review once and execute a batch of directories and moves',
    async run(ctx) {
      await writeFile(join(ctx.root, 'a.pdf'), 'A');
      await writeFile(join(ctx.root, 'b.pdf'), 'B');
      await ctx.run(
        'Create two categories and move both selected files.',
        plan(ctx, 'Two category batch', [
          { kind: 'create_directory', target: ref(ctx, 'Retrieval') },
          { kind: 'create_directory', target: ref(ctx, 'Memory') },
          { kind: 'move_file', source: ref(ctx, 'a.pdf'), target: ref(ctx, 'Retrieval/a.pdf') },
          { kind: 'move_file', source: ref(ctx, 'b.pdf'), target: ref(ctx, 'Memory/b.pdf') },
        ]),
      );
      expect(ctx.approvals).toHaveLength(1);
      expect(ctx.approvals[0].preview.plan?.actions).toHaveLength(4);
      expect(await readFile(join(ctx.root, 'Retrieval/a.pdf'), 'utf8')).toBe('A');
      expect(await readFile(join(ctx.root, 'Memory/b.pdf'), 'utf8')).toBe('B');
      completed(ctx);
    },
  },
  {
    id: 'F08',
    title: 'Use the native Trash contract for selected files',
    async run(ctx) {
      await writeFile(join(ctx.root, 'selected.txt'), 'Recoverable selected bytes');
      await writeFile(join(ctx.root, 'keep.txt'), 'Keep');
      const value = await ctx.run(
        'Move only selected.txt into native Trash.',
        plan(ctx, 'Trash selected fixture', [
          { kind: 'trash_file', target: ref(ctx, 'selected.txt') },
        ]),
      );
      expect(value.state).toBe('completed');
      expect(await readdir(ctx.root)).toEqual(['keep.txt']);
      expect(await readFile(join(ctx.temp, 'fixture-trash/selected.txt'), 'utf8')).toBe(
        'Recoverable selected bytes',
      );
      expect(ctx.nativeEffects).toEqual([{ kind: 'trash', path: join(ctx.root, 'selected.txt') }]);
      expect(value.timeline.some((item) => item.call?.name === 'shell')).toBe(false);
      completed(ctx);
    },
  },
  {
    id: 'F09',
    title: 'Discover recent papers, research identities and organize by evidence',
    async run(ctx) {
      const papers = [
        {
          file: 'AnchorRec_Ada_Lin_2025.pdf',
          query: 'AnchorRec Ada Lin 2025',
          category: 'Retrieval',
          fact: 'retrieval reduces candidate lookup cost',
          url: 'https://papers.acceptance.example/anchor',
        },
        {
          file: 'MemorySketch_Bo_Chen_2024.pdf',
          query: 'MemorySketch Bo Chen 2024',
          category: 'Memory',
          fact: 'compressed history limits memory storage',
          url: 'https://papers.acceptance.example/memory',
        },
      ];
      for (const item of papers) {
        await writeFile(join(ctx.root, item.file), `%PDF synthetic ${item.file}`);
        const at = new Date('2026-09-15T12:00:00Z');
        await utimes(join(ctx.root, item.file), at, at);
      }
      await writeFile(join(ctx.root, 'old.pdf'), '%PDF old');
      const old = new Date('2026-06-01T00:00:00Z');
      await utimes(join(ctx.root, 'old.pdf'), old, old);
      await writeFile(join(ctx.root, 'notes.txt'), 'Non-paper file.');
      const out = join(ctx.temp, 'Papers');
      await mkdir(out);
      const outScope = await ctx.addScope(out);
      ctx.configureWeb({
        searches: Object.fromEntries(
          papers.map((p) => [
            p.query,
            [
              {
                url: p.url,
                title: p.query,
                description: 'Synthetic identity hint; fetch full evidence.',
              },
            ],
          ]),
        ),
        pages: Object.fromEntries(
          papers.map((p) => [
            p.url,
            {
              html: `<html><head><title>${p.query}</title></head><body><article><p>Identity: ${p.query}</p><p>Category: ${p.category}</p><p>Reason: ${p.fact}</p></article></body></html>`,
            },
          ]),
        ),
      });
      let candidates: string[] = [];
      const evidence: { file: string; category: string; reason: string; citation: string }[] = [];
      const result = await ctx.run(
        'Find September AI PDFs by filesystem modifiedAt, research their identity, show a plan, then organize in Papers. Leave uncertain files untouched.',
        (_request, _task, results) => {
          if (!results.length) return tool('list_directory', { scopeId: ctx.scopeId, path: '.' });
          if (results.length === 1) {
            candidates = pages(results)[0]
              .entries.filter(
                (e) =>
                  e.type === 'file' &&
                  e.name.endsWith('.pdf') &&
                  e.modifiedAt >= '2026-09-01' &&
                  e.modifiedAt < '2026-10-01',
              )
              .map((e) => e.name);
            const queries = candidates.map((name) =>
              name.replace(/\.pdf$/, '').replaceAll('_', ' '),
            );
            return tool('authorize_research', {
              title: 'Identify selected PDFs',
              queries: queries.map((query) => ({ query, maxResults: 2 })),
              maxFetches: candidates.length,
              maxResponseBytes: 8 * 1024 * 1024,
              lifetimeSeconds: 60,
            });
          }
          const after = results.length - 2;
          if (after < candidates.length * 2) {
            const name = candidates[Math.floor(after / 2)];
            if (after % 2 === 0)
              return tool('web_search', {
                query: name.replace(/\.pdf$/, '').replaceAll('_', ' '),
                maxResults: 2,
              });
            const sources = JSON.parse(results.at(-1)?.content ?? '{}').sources;
            if (!sources?.[0]) throw new Error('Research must discover an actual source.');
            return tool('fetch_source', { sourceId: sources[0].id });
          }
          if (after === candidates.length * 2) {
            for (let index = 0; index < candidates.length; index++) {
              const source = JSON.parse(results[3 + index * 2].content).sources[0];
              const category = /Category: ([^\n]+)/.exec(source.content)?.[1]?.trim();
              const reason = /Reason: ([^\n]+)/.exec(source.content)?.[1]?.trim();
              if (
                !category ||
                !reason ||
                !source.content.includes(
                  candidates[index].replace(/\.pdf$/, '').replaceAll('_', ' '),
                )
              )
                throw new Error('Page identity/category evidence is incomplete.');
              evidence.push({
                file: candidates[index],
                category,
                reason,
                citation: source.citation,
              });
            }
            return tool('execute_plan', {
              title: 'Organize by fetched research evidence',
              actions: [
                ...[...new Set(evidence.map((p) => p.category))].map((category) => ({
                  kind: 'create_directory',
                  target: { scopeId: outScope, path: category },
                })),
                ...evidence.map((p) => ({
                  kind: 'move_file',
                  source: ref(ctx, p.file),
                  target: { scopeId: outScope, path: `${p.category}/${p.file}` },
                })),
              ],
            });
          }
          return {
            text: `Filesystem modifiedAt approximation, not download date. ${evidence.map((p) => `${p.file}: ${p.category}, ${p.reason} ${p.citation}`).join('\n')}\n${results.at(-1)?.content}`,
          };
        },
      );
      expect(result.state).toBe('completed');
      expect(candidates).toHaveLength(2);
      for (const paper of papers) {
        expect(await readFile(join(out, paper.category, paper.file), 'utf8')).toBe(
          `%PDF synthetic ${paper.file}`,
        );
        expect(result.messages.at(-1)?.content).toContain(paper.fact);
      }
      expect((await readdir(ctx.root)).sort()).toEqual(['notes.txt', 'old.pdf']);
      expect(ctx.approvals.filter((p) => !!p.preview.research)).toHaveLength(1);
      expect(ctx.approvals.filter((p) => !!p.preview.plan)).toHaveLength(1);
      expect(ctx.webRequests.filter((p) => p.kind === 'fetch')).toHaveLength(2);
      expect(
        evidence.every((p) =>
          result.sources?.some(
            (source) => source.kind === 'page' && p.citation === `[source:${source.id}]`,
          ),
        ),
      ).toBe(true);
      for (const paper of papers) {
        const actual = ctx.providerRequests
          .flatMap((request) =>
            request.messages
              .filter((message) => message.role === 'tool')
              .flatMap((message) => {
                try {
                  const value = JSON.parse(message.content);
                  return Array.isArray(value.sources) ? value.sources : [];
                } catch {
                  return [];
                }
              }),
          )
          .find((source) => source.kind === 'page' && source.url === paper.url);
        expect(actual).toBeDefined();
        const retained = result.sources?.find((source) => source.id === actual.id);
        expect(retained?.contentHash).toBe(
          createHash('sha256').update(actual.content, 'utf8').digest('hex'),
        );
        expect(
          ctx.webRequests.some(
            (request) =>
              request.kind === 'fetch' &&
              request.input === paper.url &&
              request.status === 200 &&
              request.outcome === 'response',
          ),
        ).toBe(true);
      }
      completed(ctx);
    },
  },
  {
    id: 'F10',
    title: 'Replan after stale input and preserve the external edit',
    async run(ctx) {
      await writeFile(join(ctx.root, 'input.txt'), 'Original bytes');
      const first = await ctx.run(
        'Copy input.txt to result.txt after approval.',
        plan(ctx, 'First immutable copy', [
          { kind: 'copy_file', source: ref(ctx, 'input.txt'), target: ref(ctx, 'result.txt') },
        ]),
        {
          onPermission: async () => {
            await writeFile(join(ctx.root, 'input.txt'), 'External newer bytes');
            return 'allow-once';
          },
        },
      );
      expect(first.actionPlans?.at(-1)?.status).toBe('stale');
      expect(await readFile(join(ctx.root, 'input.txt'), 'utf8')).toBe('External newer bytes');
      await expect(stat(join(ctx.root, 'result.txt'))).rejects.toThrow();
      await ctx.run(
        'Now inspect the changed file and approve a fresh copy of its current bytes.',
        (_request, _task, results) => {
          if (!results.length)
            return tool('read_file', { scopeId: ctx.scopeId, path: 'input.txt' });
          if (results.length === 1) {
            expect(results[0].content).toBe('External newer bytes');
            return tool('execute_plan', {
              title: 'Fresh copy after stale inspection',
              actions: [
                {
                  kind: 'copy_file',
                  source: ref(ctx, 'input.txt'),
                  target: ref(ctx, 'result.txt'),
                },
              ],
            });
          }
          return done(results);
        },
      );
      expect(await readFile(join(ctx.root, 'result.txt'), 'utf8')).toBe('External newer bytes');
      const plans = ctx.approvals.filter((p) => p.preview.plan).map((p) => p.preview.plan);
      expect(plans).toHaveLength(2);
      expect(plans[0]?.digest).not.toBe(plans[1]?.digest);
      completed(ctx);
    },
  },
];
