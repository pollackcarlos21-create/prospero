import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { SourceRecord } from '../../packages/core/src';
import type { CapturedRequest } from '../e2e/fake-provider';
import type { AcceptanceCase, CaseContext, Planner } from './harness';

export const WEB_FIXTURE_VERSION = 'synthetic-web-fixtures-v1';

interface FrozenPaper {
  readonly key: string;
  readonly title: string;
  readonly authors: string;
  readonly year: string;
  readonly category: string;
  readonly problem: string;
  readonly method: string;
  readonly conclusion: string;
  readonly classificationReason: string;
  readonly limitations: string;
  readonly benchmark: string;
  readonly url: string;
}

/** Synthetic papers exercise provenance and task behavior; they are not real research claims. */
export const webCorpus = Object.freeze({
  anchor: Object.freeze({
    key: 'anchor',
    title: 'AnchorRec',
    authors: 'Ada Lin',
    year: '2025',
    category: 'retrieval',
    problem: 'Too many recommendation candidates increase retrieval latency.',
    method: 'A sparse first-stage index selects twenty candidates before dense reranking.',
    conclusion: 'Candidate retrieval latency decreases by twenty percent on Fixture Benchmark A.',
    classificationReason: 'The contribution changes candidate retrieval before reranking.',
    limitations:
      'The result covers a fixed candidate distribution and does not establish cold-start gains.',
    benchmark: 'Fixture Benchmark A with a fixed candidate distribution.',
    url: 'https://papers.acceptance.example/anchor-2025',
  } satisfies FrozenPaper),
  memory: Object.freeze({
    key: 'memory',
    title: 'MemorySketch',
    authors: 'Bo Chen',
    year: '2024',
    category: 'memory',
    problem: 'Long recommendation histories exceed a bounded context window.',
    method: 'Explicit preference sketches retain recent choices and user-provided constraints.',
    conclusion:
      'The sketch retains ninety percent of annotated preferences in the frozen fixture set.',
    classificationReason: 'The contribution stores and compresses preference history.',
    limitations:
      'The fixture measures explicit preferences and excludes automatic private-data extraction.',
    benchmark: 'Fixture Preference Set B.',
    url: 'https://papers.acceptance.example/memory-2024',
  } satisfies FrozenPaper),
  routing: Object.freeze({
    key: 'routing',
    title: 'RouteBudget',
    authors: 'Cai Rao',
    year: '2025',
    category: 'routing',
    problem: 'A fixed router overspends expensive recommendation skills.',
    method: 'A calibrated router chooses one skill under a declared per-task budget.',
    conclusion: 'The router reduces average fixture skill calls from three to two.',
    classificationReason: 'The contribution selects a skill before task execution.',
    limitations:
      'The fixture contains a fixed skill set and does not prove robustness after skill replacement.',
    benchmark: 'Fixture Routing Set C.',
    url: 'https://papers.acceptance.example/routing-2025',
  } satisfies FrozenPaper),
  audit: Object.freeze({
    key: 'audit',
    title: 'SignalAudit',
    authors: 'Di Xu',
    year: '2023',
    category: 'evaluation',
    problem: 'Recommendation success labels conflate observed outcomes with model declarations.',
    method:
      'A frozen utility matrix checks independent outcomes and labels missing evidence as unknown.',
    conclusion: 'The evaluator exposes four unsupported success declarations in the fixture set.',
    classificationReason: 'The contribution changes measurement and outcome validation.',
    limitations: 'The matrix is a controlled fixture and does not estimate production prevalence.',
    benchmark: 'Fixture Utility Matrix D.',
    url: 'https://papers.acceptance.example/audit-2023',
  } satisfies FrozenPaper),
  alignment: Object.freeze({
    key: 'alignment',
    title: 'AlignChoice',
    authors: 'Ema Wu',
    year: '2026',
    category: 'alignment',
    problem: 'Recommendation policies may ignore explicit user constraints.',
    method: 'A constraint checker rejects candidates that violate the declared task scope.',
    conclusion: 'All twenty frozen prohibited candidates are rejected before presentation.',
    classificationReason: 'The contribution enforces explicit user constraints.',
    limitations:
      'The checker covers declared fixture constraints and cannot infer unstated intent.',
    benchmark: 'Fixture Constraint Set E.',
    url: 'https://papers.acceptance.example/alignment-2026',
  } satisfies FrozenPaper),
  homonym: Object.freeze({
    key: 'homonym',
    title: 'AnchorRec',
    authors: 'Fan Li',
    year: '2022',
    category: 'graph',
    problem: 'Graph recommendation requires sparse neighbor aggregation.',
    method: 'A fixed graph convolution pools neighborhood features.',
    conclusion: 'Graph accuracy increases by five points on Fixture Graph Set F.',
    classificationReason: 'The contribution modifies graph neighborhood aggregation.',
    limitations: 'The graph result is unrelated to the retrieval paper by Ada Lin.',
    benchmark: 'Fixture Graph Set F.',
    url: 'https://papers.acceptance.example/anchor-2022',
  } satisfies FrozenPaper),
  conflict: Object.freeze({
    key: 'conflict',
    title: 'AnchorRec benchmark disclosure',
    authors: 'Ada Lin',
    year: '2025',
    category: 'retrieval',
    problem: 'The latency claim changes under a different candidate distribution.',
    method: 'The sparse retrieval method is measured with warm-cache candidates.',
    conclusion: 'Candidate retrieval latency decreases by forty percent on Fixture Benchmark G.',
    classificationReason:
      'The disclosure measures the same retrieval method under another setting.',
    limitations: 'The warm-cache result cannot be substituted for the fixed-distribution result.',
    benchmark: 'Fixture Benchmark G with warm-cache candidates.',
    url: 'https://papers.acceptance.example/anchor-benchmark-disclosure',
  } satisfies FrozenPaper),
  followUp: Object.freeze({
    key: 'follow-up',
    title: 'AnchorRec limitation note',
    authors: 'Ada Lin',
    year: '2025',
    category: 'retrieval',
    problem: 'A fixed candidate distribution omits changing user histories.',
    method:
      'The limitation note compares the tested distribution with an untested cold-start setting.',
    conclusion:
      'Cold-start improvement remains unverified because no cold-start measurement is reported.',
    classificationReason: 'The note limits the retrieval claim rather than adding a new skill.',
    limitations: 'A cold-start experiment is required before claiming generalization.',
    benchmark: 'No cold-start benchmark is reported.',
    url: 'https://papers.acceptance.example/anchor-limitations',
  } satisfies FrozenPaper),
});

const official = Object.freeze({
  url: 'https://docs.fixtureruntime.example/compatibility/2.4',
  title: 'FixtureRuntime 2.4 official compatibility',
  vendor: 'FixtureRuntime synthetic vendor',
  version: '2.4',
  supported: 'macOS 14 or later on arm64',
  boundary: 'Intel x64 and macOS 13 or earlier are not verified by this fixture document.',
});
const retiredUrl = 'https://papers.acceptance.example/anchor-retired';
const primaryQuery = 'AnchorRec broad candidate search';
const refinedQuery = 'AnchorRec Ada Lin 2025 sparse retrieval';
const officialQuery = 'FixtureRuntime 2.4 official macOS architecture compatibility';
const homonymQuery = 'AnchorRec author Ada Lin year 2025';
const conflictQuery = 'AnchorRec candidate retrieval latency benchmark disclosure';
const alternateQuery = 'AnchorRec Ada Lin 2025 working paper page';
const followUpQuery = 'AnchorRec Ada Lin 2025 limitations cold start';
const bodyMarker = (paper: FrozenPaper) => `FULL_WEB_BODY_ONLY_${paper.key}_fixture_v1`;
const paperQuery = (paper: FrozenPaper) => `${paper.title} ${paper.authors} ${paper.year} paper`;

function htmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function frozenPaperHtml(paper: FrozenPaper): string {
  const fields = {
    Fixture: WEB_FIXTURE_VERSION,
    Title: paper.title,
    Authors: paper.authors,
    Year: paper.year,
    Problem: paper.problem,
    Method: paper.method,
    Conclusion: paper.conclusion,
    Category: paper.category,
    ClassificationReason: paper.classificationReason,
    Limitations: paper.limitations,
    Benchmark: paper.benchmark,
  };
  const paragraphs = Object.entries(fields)
    .map(([key, value]) => `<p>${key}: ${htmlText(value)}</p>`)
    .join('');
  // Keep the raw-body sentinel beyond the 1,200-character retained excerpt.
  return `<html><head><title>${htmlText(paper.title)}</title></head><body><main>${paragraphs}<p>Background: ${'Frozen synthetic background context. '.repeat(70)}</p><p>RetentionProbe: ${bodyMarker(paper)}</p></main></body></html>`;
}

function searchEntry(paper: FrozenPaper) {
  return {
    url: paper.url,
    title: paper.title,
    description: `Authors: ${paper.authors}; Year: ${paper.year}; Category: ${paper.category}. ${paper.problem}`,
  };
}

function configure(ctx: CaseContext): void {
  const searches: Record<string, { url: string; title: string; description?: string }[]> = {};
  const pages: Record<string, { html: string; status?: number }> = {};
  for (const paper of Object.values(webCorpus)) {
    searches[paperQuery(paper)] = [searchEntry(paper)];
    pages[paper.url] = { html: frozenPaperHtml(paper) };
  }
  searches[officialQuery] = [
    {
      url: official.url,
      title: official.title,
      description: `${official.vendor}: ${official.version} compatibility.`,
    },
  ];
  pages[official.url] = {
    html: `<html><title>${official.title}</title><main><p>Fixture: ${WEB_FIXTURE_VERSION}</p><p>Vendor: ${official.vendor}</p><p>Version: ${official.version}</p><p>Supported: ${official.supported}</p><p>Boundary: ${official.boundary}</p></main></html>`,
  };
  searches[homonymQuery] = [searchEntry(webCorpus.homonym), searchEntry(webCorpus.anchor)];
  searches[conflictQuery] = [searchEntry(webCorpus.anchor), searchEntry(webCorpus.conflict)];
  searches[primaryQuery] = [];
  searches[refinedQuery] = [searchEntry(webCorpus.anchor)];
  searches[alternateQuery] = [
    { ...searchEntry(webCorpus.anchor), url: retiredUrl, title: 'AnchorRec retired page' },
    searchEntry(webCorpus.anchor),
  ];
  pages[retiredUrl] = {
    status: 404,
    html: '<html><main>RETIRED_PAGE_BODY_MUST_NOT_BECOME_EVIDENCE</main></html>',
  };
  searches[followUpQuery] = [searchEntry(webCorpus.followUp)];
  ctx.configureWeb({ searches, pages });
}

interface Evidence extends SourceRecord {
  readonly content: string;
}

function evidence(results: CapturedRequest['messages']): Evidence[] {
  const found: Evidence[] = [];
  for (const result of results) {
    let value: unknown;
    try {
      value = JSON.parse(result.content);
    } catch {
      continue;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('sources' in value) ||
      !Array.isArray(value.sources)
    )
      continue;
    for (const item of value.sources) {
      if (
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.url === 'string' &&
        typeof item.content === 'string' &&
        (item.kind === 'search' || item.kind === 'page')
      )
        found.push(item as Evidence);
    }
  }
  return found;
}

function field(page: Evidence, name: string): string {
  return (
    page.content
      .split('\n')
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? ''
  );
}

function reportPaper(page: Evidence): string {
  const citation = `[source:${page.id}]`;
  const title = field(page, 'Title');
  const authors = field(page, 'Authors');
  const year = field(page, 'Year');
  if (
    !title ||
    !authors ||
    !year ||
    !field(page, 'Problem') ||
    !field(page, 'Method') ||
    !field(page, 'Conclusion')
  )
    return 'Research incomplete: the actual fetched evidence does not contain the required paper fields.';
  return [
    `${title}; Authors: ${authors}; Year: ${year}. ${citation}`,
    `Problem: ${field(page, 'Problem')} ${citation}`,
    `Method: ${field(page, 'Method')} ${citation}`,
    `Conclusion: ${field(page, 'Conclusion')} ${citation}`,
    `Category: ${field(page, 'Category')}. Reason: ${field(page, 'ClassificationReason')} ${citation}`,
    `Limitations: ${field(page, 'Limitations')} ${citation}`,
  ].join('\n');
}

function comparePapers(pages: readonly Evidence[]): string {
  if (pages.length !== 3) return 'Comparison incomplete: three actual page sources are required.';
  const cell = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const dimensions = ['Problem', 'Method', 'Conclusion', 'Limitations'] as const;
  const headings = pages.map((page) =>
    cell(`${field(page, 'Title')} — ${field(page, 'Authors')} (${field(page, 'Year')})`),
  );
  if (pages.some((page) => dimensions.some((dimension) => !field(page, dimension))))
    return 'Comparison incomplete: required evidence fields are missing.';
  const rows = dimensions.map(
    (dimension) =>
      `| ${dimension} | ${pages.map((page) => `${cell(field(page, dimension))} [source:${page.id}]`).join(' | ')} |`,
  );
  const differences = pages.map(
    (page) =>
      `${field(page, 'Title')}: ${field(page, 'Category')} — ${field(page, 'ClassificationReason')}; limitation: ${field(page, 'Limitations')} [source:${page.id}]`,
  );
  return [
    'Synthetic chain proof: the comparison uses actual fetched fixture fields; it does not evaluate real-model reasoning.',
    `| Dimension | ${headings.join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...rows,
    `Applicability differences: ${differences.join(' versus ')}`,
  ].join('\n');
}

function researchPlanner(
  queries: readonly string[],
  settings: {
    select?: (sources: readonly Evidence[]) => Evidence[];
    render?: (pages: readonly Evidence[], results: CapturedRequest['messages']) => string;
    maxFetches?: number;
  } = {},
): Planner {
  return (_request, _task, results) => {
    if (!results.length)
      return {
        tool: 'authorize_research',
        args: {
          title: 'Frozen offline acceptance research',
          queries: queries.map((query) => ({ query, maxResults: 4 })),
          maxFetches: settings.maxFetches ?? 10,
          maxResponseBytes: 16 * 1024 * 1024,
          lifetimeSeconds: 120,
        },
      };
    if (results.length <= queries.length)
      return { tool: 'web_search', args: { query: queries[results.length - 1], maxResults: 4 } };
    const observed = evidence(results);
    const searchSources = [
      ...new Map(
        observed.filter((source) => source.kind === 'search').map((source) => [source.url, source]),
      ).values(),
    ];
    const targets = settings.select ? settings.select(searchSources) : searchSources;
    const next = results.length - queries.length - 1;
    if (next < targets.length)
      return { tool: 'fetch_source', args: { sourceId: targets[next].id } };
    const pages = observed.filter((source) => source.kind === 'page');
    const text = settings.render
      ? settings.render(pages, results)
      : pages.map(reportPaper).join('\n\n');
    return { text: text || 'Research incomplete: no actual page evidence was returned.' };
  };
}

function finalAnswer(conversation: Conversation): string {
  return (
    conversation.messages.findLast(
      (message) => message.role === 'assistant' && !message.toolCalls?.length,
    )?.content ?? ''
  );
}

function pageSources(conversation: Conversation): SourceRecord[] {
  return (conversation.sources ?? []).filter((source) => source.kind === 'page');
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required observed source evidence is missing.');
  return value;
}

/** Every source-like marker must resolve; a valid citation cannot hide an extra forged one. */
export function validateCitationMarkers(
  answer: string,
  registeredSources: readonly Pick<SourceRecord, 'id'>[],
): string[] {
  const prefixes = [...answer.matchAll(/\[source:/gi)];
  const markers = [...answer.matchAll(/\[source:([^\]]*)\]/gi)];
  if (!markers.length || markers.length !== prefixes.length)
    throw new Error('Research citations are missing or incomplete.');
  const registered = new Set(registeredSources.map((source) => source.id));
  return markers.map((marker) => {
    const id = marker[1];
    if (!/^src_[a-f0-9]{24}$/.test(id) || marker[0] !== `[source:${id}]`)
      throw new Error('Research citation format is invalid.');
    if (!registered.has(id))
      throw new Error('Research citation is not an actual registered source.');
    return id;
  });
}

function checkCitations(
  ctx: CaseContext,
  conversation: Conversation,
  expectedUrls: readonly string[],
  fresh: { providerStart?: number; webStart?: number } = {},
): SourceRecord[] {
  const sources = pageSources(conversation);
  const answer = finalAnswer(conversation);
  const actualPages = evidence(
    ctx.providerRequests
      .slice(fresh.providerStart ?? 0)
      .flatMap((request) => request.messages.filter((message) => message.role === 'tool')),
  ).filter((source) => source.kind === 'page');
  const successfulFetches = ctx.webRequests
    .slice(fresh.webStart ?? 0)
    .filter(
      (receipt) =>
        receipt.kind === 'fetch' &&
        receipt.status === 200 &&
        receipt.outcome === 'response' &&
        receipt.responseBytesKnown,
    );
  const ids = validateCitationMarkers(answer, sources);
  for (const id of ids) {
    const source = required(sources.find((item) => item.id === id));
    expect(expectedUrls).toContain(source.url);
    expect(source.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isSafeInteger(source.retrievedAt)).toBe(true);
    const actual = required(
      actualPages.find(
        (page) =>
          page.id === source.id &&
          page.url === source.url &&
          page.contentHash === source.contentHash,
      ),
    );
    expect(createHash('sha256').update(actual.content, 'utf8').digest('hex')).toBe(
      source.contentHash,
    );
    expect(successfulFetches.some((receipt) => receipt.input === source.url)).toBe(true);
  }
  for (const url of expectedUrls) {
    const source = required(sources.find((item) => item.url === url));
    expect(ids).toContain(source.id);
  }
  return sources;
}

function checkPaper(conversation: Conversation, paper: FrozenPaper): void {
  expect(conversation.state).toBe('completed');
  const answer = finalAnswer(conversation);
  for (const value of [
    paper.title,
    paper.authors,
    paper.year,
    paper.problem,
    paper.method,
    paper.conclusion,
  ])
    expect(answer).toContain(value);
}

function checkResearch(ctx: CaseContext, approvals = 1): void {
  const researchApprovals = ctx.approvals.filter((request) => request.preview.research);
  expect(researchApprovals).toHaveLength(approvals);
  expect(researchApprovals.every((request) => !request.allowSession)).toBe(true);
  for (const request of researchApprovals) {
    const plan = request.preview.research;
    expect(plan?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan?.conversationId).toBe(ctx.conversationId);
  }
  expect(
    ctx.webRequests.every((request) => Number.isSafeInteger(request.bytes) && request.bytes >= 0),
  ).toBe(true);
}

export const webCases: AcceptanceCase[] = [
  {
    id: 'W01',
    title: '研究一篇论文：问题、方法、结论及有效来源',
    async run(ctx) {
      configure(ctx);
      const paper = webCorpus.anchor;
      const conversation = await ctx.run(
        `W01 Research the synthetic paper ${paper.title} by ${paper.authors} (${paper.year}).`,
        researchPlanner([paperQuery(paper)]),
      );
      checkPaper(conversation, paper);
      checkCitations(ctx, conversation, [paper.url]);
      checkResearch(ctx);
      expect(ctx.webRequests.map(({ kind }) => kind)).toEqual(['search', 'fetch']);
    },
  },
  {
    id: 'W02',
    title: '比较三篇论文：逐项比较和正确引用',
    async run(ctx) {
      configure(ctx);
      const papers = [webCorpus.anchor, webCorpus.memory, webCorpus.routing];
      const conversation = await ctx.run(
        'W02 Compare three synthetic papers by problem, method, conclusion and limitation.',
        researchPlanner(papers.map(paperQuery), { render: comparePapers }),
      );
      for (const paper of papers) {
        checkPaper(conversation, paper);
        expect(finalAnswer(conversation)).toContain(paper.limitations);
      }
      const sources = checkCitations(
        ctx,
        conversation,
        papers.map((paper) => paper.url),
      );
      const answer = finalAnswer(conversation);
      const matrix = answer
        .split('\n')
        .filter((line) => line.startsWith('|'))
        .map((line) =>
          line
            .split('|')
            .slice(1, -1)
            .map((value) => value.trim()),
        );
      expect(matrix).toHaveLength(6);
      expect(matrix.every((row) => row.length === 4)).toBe(true);
      expect(matrix[0][0]).toBe('Dimension');
      const dimensions = [
        ['Problem', 'problem'],
        ['Method', 'method'],
        ['Conclusion', 'conclusion'],
        ['Limitations', 'limitations'],
      ] as const;
      for (const [column, paper] of papers.entries()) {
        const source = required(sources.find((item) => item.url === paper.url));
        expect(matrix[0][column + 1]).toContain(paper.title);
        expect(matrix[0][column + 1]).toContain(paper.authors);
        expect(matrix[0][column + 1]).toContain(String(paper.year));
        for (const [label, key] of dimensions) {
          const row = required(matrix.find((entry) => entry[0] === label));
          expect(row[column + 1]).toContain(paper[key]);
          expect(row[column + 1]).toContain(`[source:${source.id}]`);
        }
        const applicability = required(
          answer.split('\n').find((line) => line.startsWith('Applicability differences:')),
        );
        expect(applicability).toContain(`${paper.title}: ${paper.category}`);
        expect(applicability).toContain(paper.classificationReason);
        expect(applicability).toContain(paper.limitations);
        expect(applicability).toContain(`[source:${source.id}]`);
      }
      expect(answer).toContain('does not evaluate real-model reasoning');
      expect(answer).toContain(' versus ');
      checkResearch(ctx);
      expect(ctx.webRequests.filter(({ kind }) => kind === 'fetch')).toHaveLength(3);
    },
  },
  {
    id: 'W03',
    title: '官方版本兼容说明：官方来源、查询时间与边界',
    async run(ctx) {
      configure(ctx);
      const startedAt = Date.now();
      const conversation = await ctx.run(
        'W03 Check the synthetic FixtureRuntime 2.4 official compatibility. State retrieval time and the exact verified boundary.',
        researchPlanner([officialQuery], {
          render(pages) {
            const page = pages[0];
            if (!page) return 'Compatibility research incomplete: no official page was fetched.';
            return `${field(page, 'Vendor')}\nVersion: ${field(page, 'Version')}\nSupported: ${field(page, 'Supported')}\nBoundary: ${field(page, 'Boundary')}\nQueriedAt: ${new Date(page.retrievedAt).toISOString()} [source:${page.id}]`;
          },
        }),
      );
      expect(conversation.state).toBe('completed');
      for (const value of [
        official.vendor,
        official.version,
        official.supported,
        official.boundary,
        'QueriedAt:',
      ])
        expect(finalAnswer(conversation)).toContain(value);
      const sources = checkCitations(ctx, conversation, [official.url]);
      expect(new URL(sources[0].url).hostname).toBe('docs.fixtureruntime.example');
      expect(sources[0].retrievedAt).toBeGreaterThanOrEqual(startedAt);
      expect(sources[0].retrievedAt).toBeLessThanOrEqual(Date.now());
      checkResearch(ctx);
    },
  },
  {
    id: 'W04',
    title: '同名论文消歧：作者与年份匹配',
    async run(ctx) {
      configure(ctx);
      const paper = webCorpus.anchor;
      const conversation = await ctx.run(
        'W04 Research AnchorRec by Ada Lin in 2025, not the graph paper by Fan Li in 2022.',
        researchPlanner([homonymQuery], {
          select: (sources) =>
            sources.filter((source) => source.content.includes('Authors: Ada Lin; Year: 2025')),
        }),
      );
      checkPaper(conversation, paper);
      checkCitations(ctx, conversation, [paper.url]);
      expect(finalAnswer(conversation)).not.toContain(webCorpus.homonym.method);
      expect(finalAnswer(conversation)).not.toContain(webCorpus.homonym.conclusion);
      expect(
        ctx.webRequests.filter(({ kind }) => kind === 'fetch').map(({ input }) => input),
      ).toEqual([paper.url]);
      checkResearch(ctx);
    },
  },
  {
    id: 'W05',
    title: '来源冲突：双方证据和剩余不确定性',
    async run(ctx) {
      configure(ctx);
      const conversation = await ctx.run(
        'W05 Resolve the conflicting AnchorRec latency descriptions and preserve any unresolved uncertainty.',
        researchPlanner([conflictQuery], {
          render(pages) {
            const conclusions = pages.map((page) => field(page, 'Conclusion'));
            const benchmarks = pages.map((page) => field(page, 'Benchmark'));
            const conflict = new Set(conclusions).size > 1;
            return `${pages.map(reportPaper).join('\n\n')}\n${conflict ? 'Conflict observed' : 'No observed conflict'}: ${conclusions.join(' versus ')}.\nBenchmarks: ${benchmarks.join(' versus ')}.\nUnresolved: Different benchmark conditions do not establish one general latency percentage.`;
          },
        }),
      );
      for (const paper of [webCorpus.anchor, webCorpus.conflict]) checkPaper(conversation, paper);
      expect(finalAnswer(conversation)).toContain('Conflict observed');
      expect(finalAnswer(conversation)).toContain('Unresolved:');
      expect(finalAnswer(conversation)).toContain(webCorpus.anchor.benchmark);
      expect(finalAnswer(conversation)).toContain(webCorpus.conflict.benchmark);
      checkCitations(ctx, conversation, [webCorpus.anchor.url, webCorpus.conflict.url]);
      checkResearch(ctx);
    },
  },
  {
    id: 'W06',
    title: '搜索不足后有界调整查询并完成研究',
    async run(ctx) {
      configure(ctx);
      const planner = researchPlanner([primaryQuery, refinedQuery]);
      const conversation = await ctx.run(
        'W06 Search broadly; if the search returns no results, use the preapproved author/year-specific query once.',
        (request, task, results) => {
          if (results.length === 2) {
            const primary = JSON.parse(results[1].content) as { sources?: unknown[] };
            if (!Array.isArray(primary.sources) || primary.sources.length !== 0)
              return {
                text: 'The primary query did not produce the required empty-result fixture; research is incomplete.',
              };
          }
          return planner(request, task, results);
        },
      );
      checkPaper(conversation, webCorpus.anchor);
      checkCitations(ctx, conversation, [webCorpus.anchor.url]);
      expect(
        ctx.webRequests.filter(({ kind }) => kind === 'search').map(({ input }) => input),
      ).toEqual([primaryQuery, refinedQuery]);
      expect(ctx.approvals[0].preview.research?.queries.map(({ query }) => query)).toEqual([
        primaryQuery,
        refinedQuery,
      ]);
      checkResearch(ctx);
    },
  },
  {
    id: 'W07',
    title: '失效页面后使用实际返回的有效替代来源',
    async run(ctx) {
      configure(ctx);
      const conversation = await ctx.run(
        'W07 Research AnchorRec despite a retired source page, using an actual returned alternative source.',
        researchPlanner([alternateQuery], {
          render(pages) {
            return `${pages.map(reportPaper).join('\n\n')}\nThe retired page did not provide usable page evidence; conclusions use the fetched replacement.`;
          },
        }),
      );
      checkPaper(conversation, webCorpus.anchor);
      checkCitations(ctx, conversation, [webCorpus.anchor.url]);
      expect(pageSources(conversation).some((source) => source.url === retiredUrl)).toBe(false);
      expect(
        ctx.webRequests
          .filter(({ kind }) => kind === 'fetch')
          .map(({ input, status }) => [input, status]),
      ).toEqual([
        [retiredUrl, 404],
        [webCorpus.anchor.url, 200],
      ]);
      expect(finalAnswer(conversation)).not.toContain('RETIRED_PAGE_BODY_MUST_NOT_BECOME_EVIDENCE');
      expect(finalAnswer(conversation)).toContain(
        'retired page did not provide usable page evidence',
      );
      checkResearch(ctx);
    },
  },
  {
    id: 'W08',
    title: '研究五篇论文并给出完整分类依据',
    async run(ctx) {
      configure(ctx);
      const papers = [
        webCorpus.anchor,
        webCorpus.memory,
        webCorpus.routing,
        webCorpus.audit,
        webCorpus.alignment,
      ];
      const conversation = await ctx.run(
        'W08 Research five synthetic papers and classify each by contribution with source-backed reasons.',
        researchPlanner(papers.map(paperQuery)),
      );
      for (const paper of papers) {
        checkPaper(conversation, paper);
        expect(finalAnswer(conversation)).toContain(`Category: ${paper.category}`);
        expect(finalAnswer(conversation)).toContain(paper.classificationReason);
      }
      checkCitations(
        ctx,
        conversation,
        papers.map((paper) => paper.url),
      );
      expect(ctx.webRequests.filter(({ kind }) => kind === 'search')).toHaveLength(5);
      expect(ctx.webRequests.filter(({ kind }) => kind === 'fetch')).toHaveLength(5);
      checkResearch(ctx);
    },
  },
  {
    id: 'W09',
    title: '多轮追问：正确来源身份与新增证据',
    async run(ctx) {
      configure(ctx);
      const first = await ctx.run(
        'W09 First research AnchorRec by Ada Lin in 2025.',
        researchPlanner([paperQuery(webCorpus.anchor)]),
      );
      checkPaper(first, webCorpus.anchor);
      const oldSource = required(
        checkCitations(ctx, first, [webCorpus.anchor.url]).find(
          (source) => source.url === webCorpus.anchor.url,
        ),
      );
      const requestStart = ctx.providerRequests.length;
      const requestCount = ctx.webRequests.length;
      const followUp = await ctx.run(
        'W09 Continue the same paper identity and research whether its retrieval gains establish cold-start generalization.',
        researchPlanner([followUpQuery]),
      );
      checkPaper(followUp, webCorpus.followUp);
      checkCitations(ctx, followUp, [webCorpus.followUp.url], {
        providerStart: requestStart,
        webStart: requestCount,
      });
      expect(finalAnswer(followUp)).toContain('Cold-start improvement remains unverified');
      expect(JSON.stringify(ctx.providerRequests[requestStart].messages)).toContain(oldSource.id);
      expect(ctx.webRequests.slice(requestCount).map(({ kind }) => kind)).toEqual([
        'search',
        'fetch',
      ]);
      checkResearch(ctx, 2);
      expect(new Set(ctx.approvals.map((request) => request.preview.research?.id)).size).toBe(2);
    },
  },
  {
    id: 'W10',
    title: '重启后保留来源 metadata，重新授权并抓取正文',
    async run(ctx) {
      configure(ctx);
      await ctx.setRetention('sources');
      const paper = webCorpus.anchor;
      const first = await ctx.run(
        'W10 Research AnchorRec before restarting.',
        researchPlanner([paperQuery(paper)]),
      );
      checkPaper(first, paper);
      const oldSource = required(
        checkCitations(ctx, first, [paper.url]).find((source) => source.url === paper.url),
      );
      expect(
        ctx.store.sources(ctx.conversationId).some((source) => source.id === oldSource.id),
      ).toBe(true);
      expect(JSON.stringify(ctx.store.conversations())).not.toContain(bodyMarker(paper));
      expect(JSON.stringify(ctx.store.sources(ctx.conversationId))).not.toContain(
        bodyMarker(paper),
      );
      const webCount = ctx.webRequests.length;
      const approvalCount = ctx.approvals.length;
      await ctx.restart();
      expect(ctx.webRequests).toHaveLength(webCount);
      expect(ctx.approvals).toHaveLength(approvalCount);
      expect(
        ctx.service
          .getConversation(ctx.conversationId)
          .sources?.some((source) => source.id === oldSource.id),
      ).toBe(true);
      const requestStart = ctx.providerRequests.length;
      const resumed = await ctx.run(
        'W10 Continue after restart. Treat retained metadata as identity only, and fetch fresh evidence after a new approval.',
        researchPlanner([paperQuery(paper)], {
          render(pages) {
            return `Retained metadata identified the paper; page evidence was fetched again under a new research approval.\n${pages.map(reportPaper).join('\n\n')}`;
          },
        }),
      );
      checkPaper(resumed, paper);
      checkCitations(ctx, resumed, [paper.url], {
        providerStart: requestStart,
        webStart: webCount,
      });
      const initialContext = JSON.stringify(ctx.providerRequests[requestStart].messages);
      expect(initialContext).toContain(oldSource.id);
      expect(initialContext).toContain('metadata only');
      expect(initialContext).not.toContain(bodyMarker(paper));
      expect(ctx.webRequests.slice(webCount).map(({ kind }) => kind)).toEqual(['search', 'fetch']);
      expect(finalAnswer(resumed)).toContain('fetched again under a new research approval');
      checkResearch(ctx, 2);
      expect(new Set(ctx.approvals.map((request) => request.preview.research?.id)).size).toBe(2);
    },
  },
];
