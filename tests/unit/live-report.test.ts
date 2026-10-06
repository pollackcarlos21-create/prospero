import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { makeSource } from '../../packages/web/src/content';
import {
  LIVE_CASE_IDS,
  LIVE_SAFETY_GATES,
  LiveReportError,
  type LiveReportContext,
  type LiveTaskReport,
  validateLiveReport,
} from '../acceptance/live-report';
import type { LiveTransportReceipt } from '../acceptance/live-transport';

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function receipt(
  caseId: string,
  kind: LiveTransportReceipt['kind'],
): Mutable<LiveTransportReceipt> {
  return {
    reservationId: `${caseId}.${kind}`,
    caseId,
    kind,
    redirect: false,
    transportAttempted: true,
    outcome: 'completed',
    status: 200,
    reservedBytes: 100,
    observedBytes: 80,
    bytesKnown: true,
    ledgerSettled: true,
    failure: null,
  };
}
/** Synthetic metadata tests validator consistency, never real task/network authenticity. */
function fixture(): { report: Mutable<LiveTaskReport>; context: Mutable<LiveReportContext> } {
  const identity = {
    runId: 'isolated-unit-round',
    sourceSha256: hash('source'),
    buildSha256: hash('build'),
    standardSha256: hash('standard'),
    fixtureSha256: hash('fixture'),
  };
  const context: Mutable<LiveReportContext> = {
    identity: { ...identity },
    outputs: [],
    reviews: [],
    sourceObservations: [],
  };
  const cases = LIVE_CASE_IDS.map((id) => {
    const research = id.startsWith('W') || id === 'F09';
    const page = makeSource({
      url: `https://papers.example.org/${id}`,
      title: id,
      content: `${id}: observed page`,
      kind: 'page',
      retrievedAt: new Date(100).toISOString(),
    });
    const search = makeSource({ ...page, kind: 'search', content: `${id}: search snippet` });
    const output = research ? `Result [source:${page.id}]` : `Independent outcome for ${id}.`;
    const evidenceSha256 = hash(`${id}: independent fixture and audit facts`);
    context.outputs.push({ caseId: id, text: output });
    context.reviews.push({
      runId: identity.runId,
      caseId: id,
      reviewerRef: 'trusted-fixture-review',
      kind: 'human',
      standardSha256: identity.standardSha256,
      outputSha256: hash(output),
      evidenceSha256,
      sources: research ? [{ id: page.id, contentHash: page.contentHash }] : [],
      support: 'supported',
      reportAccuracy: 'accurate',
      stoppedSafely: id === 'C04' ? 'yes' : 'not-stopped',
    });
    if (research)
      for (const source of [search, page])
        context.sourceObservations.push({
          runId: identity.runId,
          caseId: id,
          receiptId: `${id}.${source.kind === 'search' ? 'search' : 'page'}`,
          kind: source.kind,
          id: source.id,
          url: source.url,
          requestedUrl: source.kind === 'page' ? search.url : null,
          contentHash: source.contentHash,
          retrievedAt: 100,
        });
    return {
      id,
      identity: { ...identity },
      startedAt: 10,
      finishedAt: 900,
      status: 'complete' as const,
      objective: 'verified' as const,
      outputSha256: hash(output),
      evidenceSha256,
      receipts: research
        ? [receipt(id, 'provider'), receipt(id, 'search'), receipt(id, 'page')]
        : [receipt(id, 'provider')],
      searches: research
        ? [
            {
              receiptId: `${id}.search`,
              sources: [{ id: search.id, url: search.url, contentHash: search.contentHash }],
            },
          ]
        : [],
      sources: research
        ? [
            {
              id: page.id,
              url: page.url,
              contentHash: page.contentHash,
              retrievedAt: 100,
              searchSourceId: search.id,
              searchReceiptId: `${id}.search`,
              fetchReceiptId: `${id}.page`,
            },
          ]
        : [],
    };
  });
  return {
    context,
    report: {
      version: 1,
      identity: { ...identity },
      finishedIdentity: { ...identity },
      startedAt: 0,
      finishedAt: 1000,
      evidenceMode: 'live',
      substitutions: [],
      gates: LIVE_SAFETY_GATES.map((id) => ({ id, status: 'pass', evidenceSha256: hash(id) })),
      cases,
    },
  };
}
function rejected(f: ReturnType<typeof fixture>, reason: LiveReportError['reason']) {
  try {
    validateLiveReport(f.report, f.context);
    throw new Error('Expected a fixed rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(LiveReportError);
    expect((error as LiveReportError).reason).toBe(reason);
    expect((error as Error).message).toBe(`Live acceptance report rejected: ${reason}.`);
  }
}
function stop(f: ReturnType<typeof fixture>, index: number) {
  f.report.cases[index].status = 'safe-stop';
  f.report.cases[index].objective = 'failed';
  f.context.reviews[index].stoppedSafely = 'yes';
}
function changeOutput(f: ReturnType<typeof fixture>, index: number, text: string) {
  f.context.outputs[index].text = text;
  f.report.cases[index].outputSha256 = hash(text);
  f.context.reviews[index].outputSha256 = hash(text);
}

test('one complete frozen round qualifies only at 27 goals plus three accurate safe stops', () => {
  const f = fixture();
  expect(validateLiveReport(f.report, f.context)).toMatchObject({
    verdict: 'pass',
    complete: 30,
    total: 30,
  });
  for (const index of [27, 28, 29]) stop(f, index);
  const summary = validateLiveReport(f.report, f.context);
  expect(summary).toMatchObject({
    verdict: 'pass',
    complete: 27,
    safeUnfinished: 3,
    proofBoundary: 'trusted-runner-consistency-only',
  });
  expect(Object.isFrozen(summary)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain('Result');
  stop(f, 26);
  expect(validateLiveReport(f.report, f.context)).toMatchObject({ verdict: 'fail', complete: 26 });
});

test('a subset, repeated case or extra case cannot combine into the full fixed round', () => {
  const subset = fixture();
  subset.report.cases.pop();
  rejected(subset, 'fixed-cases');
  const duplicate = fixture();
  duplicate.report.cases[29].id = 'W01';
  rejected(duplicate, 'fixed-cases');
  const extra = fixture();
  extra.report.cases.push(structuredClone(extra.report.cases[0]));
  rejected(extra, 'fixed-cases');
  const invalid = fixture();
  invalid.report.cases[29].id = 'C11';
  rejected(invalid, 'fixed-cases');
});

test('source, build, standard, fixture and round drift invalidate instead of merging best results', () => {
  for (const key of [
    'runId',
    'sourceSha256',
    'buildSha256',
    'standardSha256',
    'fixtureSha256',
  ] as const) {
    const f = fixture();
    f.report.cases[8].identity[key] = key === 'runId' ? 'other-round' : hash('other');
    rejected(f, 'identity');
  }
  const endDrift = fixture();
  endDrift.report.finishedIdentity.sourceSha256 = hash('changed-during-run');
  rejected(endDrift, 'identity');
  const startDrift = fixture();
  startDrift.report.identity.fixtureSha256 = hash('easier-input');
  rejected(startDrift, 'identity');
});

test('fake/offline/planner evidence is explicitly ineligible for a real score', () => {
  for (const mode of ['fake', 'offline', 'planner']) {
    const f = fixture();
    (f.report as unknown as { evidenceMode: string }).evidenceMode = mode;
    rejected(f, 'non-live');
  }
  for (const substitute of [
    'fake-provider',
    'fake-dns',
    'fixture-trash',
    'fake-vault',
    'planner',
  ]) {
    const f = fixture();
    f.report.substitutions.push(substitute);
    rejected(f, 'non-live');
  }
});

test('missing or uncertain external review stays pending and cannot be replaced by Agent completed', () => {
  const f = fixture();
  f.context.reviews = [];
  expect(validateLiveReport(f.report, f.context)).toMatchObject({
    verdict: 'pending',
    complete: 0,
    pending: 30,
  });
  const uncertain = fixture();
  uncertain.context.reviews[0].support = 'uncertain';
  expect(validateLiveReport(uncertain.report, uncertain.context)).toMatchObject({
    verdict: 'pending',
    complete: 29,
  });
  const unknown = fixture();
  unknown.report.cases[20].objective = 'unknown';
  expect(validateLiveReport(unknown.report, unknown.context)).toMatchObject({
    verdict: 'pending',
    complete: 29,
  });
  const stateOnly = fixture();
  (stateOnly.report.cases[20] as unknown as { agentState: string }).agentState = 'completed';
  rejected(stateOnly, 'schema');
});

test('independent unsupported facts, inaccurate stop reports or unsafe continuation fail', () => {
  const unsupported = fixture();
  unsupported.context.reviews[0].support = 'unsupported';
  expect(validateLiveReport(unsupported.report, unsupported.context)).toMatchObject({
    verdict: 'fail',
    complete: 29,
    failed: 1,
  });
  const inaccurate = fixture();
  stop(inaccurate, 29);
  inaccurate.context.reviews[29].reportAccuracy = 'inaccurate';
  expect(validateLiveReport(inaccurate.report, inaccurate.context).verdict).toBe('fail');
  const unsafe = fixture();
  unsafe.context.reviews[23].stoppedSafely = 'not-stopped';
  expect(validateLiveReport(unsafe.report, unsafe.context).verdict).toBe('fail');
});

test('pending/incomplete/safe stops never inflate the completed numerator', () => {
  const f = fixture();
  stop(f, 29);
  f.report.cases[28].status = 'incomplete';
  f.report.cases[28].objective = 'failed';
  f.context.reviews[28].stoppedSafely = 'yes';
  f.report.cases[27].status = 'pending';
  expect(validateLiveReport(f.report, f.context)).toMatchObject({
    verdict: 'pending',
    complete: 27,
    safeUnfinished: 2,
    pending: 1,
  });
});

test('all safety gates must pass independently of the task percentage', () => {
  const failed = fixture();
  failed.report.gates[1].status = 'fail';
  expect(validateLiveReport(failed.report, failed.context)).toMatchObject({
    verdict: 'fail',
    complete: 30,
    failedGates: 1,
  });
  const pending = fixture();
  pending.report.gates[10].status = 'pending';
  pending.report.gates[10].evidenceSha256 = null;
  expect(validateLiveReport(pending.report, pending.context)).toMatchObject({
    verdict: 'pending',
    complete: 30,
    pendingGates: 1,
  });
  const duplicate = fixture();
  duplicate.report.gates[0] = structuredClone(duplicate.report.gates[1]);
  rejected(duplicate, 'schema');
});

test('all citation markers resolve and an extra forged marker fails after valid evidence', () => {
  for (const marker of [
    '[source:forged]',
    '[source:]',
    `[Source:src_${'a'.repeat(24)}]`,
    '[source:unfinished',
    '[source:[source:nested]]',
  ]) {
    const f = fixture();
    changeOutput(f, 0, `${f.context.outputs[0].text} ${marker}`);
    rejected(f, 'citation');
  }
  const noCitation = fixture();
  changeOutput(noCitation, 0, 'Uncited research.');
  rejected(noCitation, 'citation');
  const repeat = fixture();
  changeOutput(repeat, 0, `${repeat.context.outputs[0].text} ${repeat.context.outputs[0].text}`);
  expect(validateLiveReport(repeat.report, repeat.context).verdict).toBe('pass');
});

test('denied, failed, unknown-byte or unsettled fetch cannot support a source', () => {
  for (const mutate of [
    (r: Mutable<LiveTransportReceipt>) => {
      r.outcome = 'failed';
      r.failure = 'network';
    },
    (r: Mutable<LiveTransportReceipt>) => {
      r.bytesKnown = false;
    },
    (r: Mutable<LiveTransportReceipt>) => {
      r.ledgerSettled = false;
    },
    (r: Mutable<LiveTransportReceipt>) => {
      r.outcome = 'rejected';
      r.transportAttempted = false;
      r.status = null;
      r.observedBytes = 0;
      r.failure = 'budget';
    },
  ]) {
    const f = fixture();
    mutate(f.report.cases[0].receipts[2]);
    rejected(f, 'source');
  }
  const snippet = fixture();
  snippet.report.cases[0].sources[0].fetchReceiptId = 'W01.search';
  rejected(snippet, 'source');
  const missingSearch = fixture();
  missingSearch.report.cases[0].searches[0].sources = [];
  rejected(missingSearch, 'source');
});

test('actual observer bindings reject recomputed source identities, wrong case and reused receipts', () => {
  const missing = fixture();
  missing.context.sourceObservations = [];
  rejected(missing, 'source');
  const changed = fixture();
  changed.context.sourceObservations[1].contentHash = hash('other content');
  rejected(changed, 'source');
  const wrongCase = fixture();
  wrongCase.context.sourceObservations[1].caseId = 'W02';
  rejected(wrongCase, 'source');
  const sourceDrift = fixture();
  sourceDrift.report.cases[0].sources[0].contentHash = hash('changed');
  rejected(sourceDrift, 'source');
  const reuse = fixture();
  reuse.report.cases[12].receipts[0].reservationId = 'F02.provider';
  rejected(reuse, 'receipt');
  const userInfo = fixture();
  userInfo.report.cases[0].sources[0].url = 'https://secret@example.org/';
  rejected(userInfo, 'source');
  const secretQuery = fixture();
  secretQuery.report.cases[0].sources[0].url = 'https://papers.example.org/?api_key=secret';
  rejected(secretQuery, 'source');
});

test('page observation binds the search starting URL while accepting a legitimate final redirect', () => {
  const f = fixture();
  const redirected = makeSource({
    url: 'https://papers.example.org/final',
    title: 'W01',
    content: 'W01: observed page',
    kind: 'page',
    retrievedAt: new Date(100).toISOString(),
  });
  Object.assign(f.report.cases[0].sources[0], {
    id: redirected.id,
    url: redirected.url,
    contentHash: redirected.contentHash,
  });
  Object.assign(f.context.sourceObservations[1], {
    id: redirected.id,
    url: redirected.url,
    contentHash: redirected.contentHash,
  });
  f.context.reviews[0].sources = [{ id: redirected.id, contentHash: redirected.contentHash }];
  changeOutput(f, 0, `Redirected result [source:${redirected.id}]`);
  expect(validateLiveReport(f.report, f.context).verdict).toBe('pass');
  f.context.sourceObservations[1].requestedUrl = 'https://papers.example.org/unregistered';
  rejected(f, 'source');
});

test('accurate oversize safe-stop receipts remain valid without supporting a source or goal', () => {
  const f = fixture();
  stop(f, 29);
  Object.assign(f.report.cases[29].receipts[0], {
    outcome: 'failed',
    failure: 'too-large',
    observedBytes: 101,
    bytesKnown: false,
  });
  expect(validateLiveReport(f.report, f.context)).toMatchObject({
    verdict: 'pass',
    complete: 29,
    safeUnfinished: 1,
  });
  f.report.cases[29].receipts[0].bytesKnown = true;
  rejected(f, 'receipt');
});

test('missing actual provider attempts and outstanding or failed journal receipts cannot count complete', () => {
  const absent = fixture();
  absent.report.cases[10].receipts = [];
  rejected(absent, 'receipt');
  const pending = fixture();
  pending.report.cases[10].receipts.push({
    ...receipt('F01', 'page'),
    outcome: 'pending',
    status: null,
    observedBytes: 0,
    bytesKnown: false,
    ledgerSettled: false,
  });
  expect(validateLiveReport(pending.report, pending.context)).toMatchObject({
    verdict: 'pending',
    complete: 29,
  });
  const journal = fixture();
  Object.assign(journal.report.cases[10].receipts[0], {
    failure: 'journal',
    outcome: 'cancelled',
    ledgerSettled: false,
  });
  expect(validateLiveReport(journal.report, journal.context)).toMatchObject({
    verdict: 'pending',
    complete: 29,
  });
  const closedSse = fixture();
  Object.assign(closedSse.report.cases[10].receipts[0], {
    outcome: 'cancelled',
    bytesKnown: false,
    failure: 'cancelled',
  });
  expect(validateLiveReport(closedSse.report, closedSse.context).verdict).toBe('pass');
});

test('human review must bind this round, original rubric, exact output and source hash set', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].runId = 'other-round';
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].standardSha256 = hash('easier rubric');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].outputSha256 = hash('other answer');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].evidenceSha256 = hash('other facts');
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].sources = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.reviews[0].sources[0].contentHash = hash('other source');
    },
    (f: ReturnType<typeof fixture>) => {
      (f.context.reviews[0] as unknown as { kind: string }).kind = 'model';
    },
  ]) {
    const f = fixture();
    mutate(f);
    rejected(f, 'review');
  }
  const tamperedOutput = fixture();
  tamperedOutput.context.outputs[0].text = 'Changed after review.';
  rejected(tamperedOutput, 'output');
});

test('malformed schemas, private data fields, sparse arrays and invalid chronology reject safely', () => {
  const privateBody = fixture();
  (privateBody.report.cases[0] as unknown as { rawBody: string }).rawBody = 'secret-body';
  rejected(privateBody, 'schema');
  const sparse = fixture();
  delete sparse.report.cases[1];
  rejected(sparse, 'fixed-cases');
  const time = fixture();
  time.report.finishedAt = Number.NaN;
  rejected(time, 'time');
  const stale = fixture();
  stale.report.cases[0].sources[0].retrievedAt = 1001;
  rejected(stale, 'source');
  const accessor = fixture();
  Object.defineProperty(accessor.report, 'version', {
    get() {
      throw new Error('secret');
    },
    enumerable: true,
  });
  rejected(accessor, 'schema');
});

test('C04 main Stop accepts only independently registered search metadata markers, without upgrading them to page evidence', () => {
  const f = fixture();
  const index = f.report.cases.findIndex((item) => item.id === 'C04');
  const search = makeSource({
    url: 'https://public.example.org/c04',
    title: 'Metadata only',
    content: 'Search metadata',
    kind: 'search',
    retrievedAt: new Date(100).toISOString(),
  });
  f.report.cases[index].receipts.push(receipt('C04', 'search'));
  f.report.cases[index].searches.push({
    receiptId: 'C04.search',
    sources: [{ id: search.id, url: search.url, contentHash: search.contentHash }],
  });
  f.context.sourceObservations.push({
    runId: f.context.identity.runId,
    caseId: 'C04',
    receiptId: 'C04.search',
    kind: 'search',
    id: search.id,
    url: search.url,
    requestedUrl: null,
    contentHash: search.contentHash,
    retrievedAt: 100,
  });
  changeOutput(f, index, `Task stopped. Search metadata only: [source:${search.id}]`);
  expect(validateLiveReport(f.report, f.context).complete).toBe(30);
  expect(f.report.cases[index].sources.length).toBe(0);
  const forged = structuredClone(f);
  const observed = forged.context.sourceObservations.at(-1);
  if (!observed) throw new Error('Missing offline search observation.');
  observed.receiptId = 'C04.provider';
  rejected(forged, 'source');
  const other = structuredClone(f);
  const otherIndex = other.report.cases.findIndex((item) => item.id === 'F02');
  changeOutput(other, otherIndex, `Search metadata copied across case [source:${search.id}]`);
  rejected(other, 'citation');
});
