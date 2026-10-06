import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseContext } from '../tests/acceptance/harness';
import { fileCases } from '../tests/acceptance/file-cases';
import { webCases, WEB_FIXTURE_VERSION } from '../tests/acceptance/web-cases';
import { continuityCases } from '../tests/acceptance/continuity-cases';
import { desktopTaskLimits } from '../apps/desktop/src/main/service';
import { acceptanceSourceIdentity } from './acceptance-identity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = ['W', 'F', 'C'].flatMap((prefix) =>
  Array.from({ length: 10 }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`),
);
const cases = [...webCases, ...fileCases, ...continuityCases];
if (
  cases.length !== 30 ||
  new Set(cases.map((test) => test.id)).size !== 30 ||
  expected.some((id) => !cases.some((test) => test.id === id))
)
  throw new Error(
    'The fixed acceptance set must contain W01-W10, F01-F10 and C01-C10 exactly once.',
  );
const option = process.argv.indexOf('--cases');
const requested = option === -1 ? expected : (process.argv[option + 1] ?? '').split(',');
if (
  !requested.length ||
  requested.some((id) => !expected.includes(id)) ||
  new Set(requested).size !== requested.length
)
  throw new Error('Unknown or duplicate acceptance case ID.');
const selected = cases.filter((test) => requested.includes(test.id));
const full = selected.length === 30;
const output = join(root, 'output/v1-acceptance');
await mkdir(output, { recursive: true });
const source = await acceptanceSourceIdentity(root);
const startedAt = new Date().toISOString();
const results: {
  id: string;
  title: string;
  offline: 'pass' | 'fail';
  real: 'pending';
  elapsedMs: number;
  error?: string;
  evidence?: unknown;
}[] = [];
function evidence(ctx: CaseContext | undefined) {
  try {
    return ctx?.evidence();
  } catch {
    return { unavailable: 'The fixture runtime could not read its saved evidence.' };
  }
}
for (const test of selected) {
  const started = performance.now();
  let ctx: CaseContext | undefined;
  try {
    ctx = await CaseContext.create();
    await test.run(ctx);
    const caseEvidence = ctx.evidence();
    if (
      ctx.runReceipts.some(
        (run) =>
          run.modelRequests > desktopTaskLimits.maxModelTurns ||
          run.toolCalls > desktopTaskLimits.maxToolCalls,
      )
    )
      throw new Error('Observed model/tool calls exceeded the actual desktop task budget.');
    results.push({
      id: test.id,
      title: test.title,
      offline: 'pass',
      real: 'pending',
      elapsedMs: Math.round(performance.now() - started),
      evidence: caseEvidence,
    });
    console.log(`${test.id} PASS — ${test.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown acceptance failure.';
    results.push({
      id: test.id,
      title: test.title,
      offline: 'fail',
      real: 'pending',
      elapsedMs: Math.round(performance.now() - started),
      error: message,
      evidence: evidence(ctx),
    });
    console.error(`${test.id} FAIL — ${message}`);
  } finally {
    try {
      await ctx?.close();
    } catch {
      const result = results.at(-1);
      if (result) {
        result.offline = 'fail';
        result.error = `${result.error ? `${result.error}\n` : ''}Fixture cleanup failed.`;
      }
    }
  }
}
const unchanged = (await acceptanceSourceIdentity(root)).sha256 === source.sha256;
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  fixtureVersion: WEB_FIXTURE_VERSION,
  scope:
    'Offline task-layer integration; deterministic synthetic model, loopback HTTP SSE, fake DNS/raw Web transport, fake vault/native ports. Not real-model, real-TLS, physical Trash or 30 desktop UI E2E proof.',
  fixedSetComplete: full,
  sourceUnchangedDuringRun: unchanged,
  overallStatus: unchanged
    ? results.every((test) => test.offline === 'pass')
      ? 'pass'
      : 'fail'
    : 'invalid-source-changed-during-run',
  sourceIdentity: source,
  buildIdentity: {
    usedByThisRunner: false,
    status: 'not-used',
    reason:
      'This task-layer runner directly executes current TypeScript sources. Production bundle/package identity is verified separately in output/v1-validation.',
  },
  applicationVersion: '0.2.0',
  budgets: desktopTaskLimits,
  offline: {
    executed: results.length,
    passed: results.filter((test) => test.offline === 'pass').length,
    failed: results.filter((test) => test.offline === 'fail').length,
  },
  real: {
    executed: 0,
    completed: 0,
    total: 30,
    status: 'pending-explicit-credential-and-budget-authorization',
  },
  results,
};
const filename = full ? 'offline-tasks.json' : 'offline-subset.json';
await writeFile(join(output, filename), `${JSON.stringify(report, null, 2)}\n`);
const archive = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${filename}`;
await writeFile(join(output, archive), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${report.overallStatus}: offline ${report.offline.passed}/${results.length}; real 0/30. Evidence: ${relative(root, join(output, filename))}`,
);
if (report.offline.failed || !unchanged) process.exitCode = 1;
