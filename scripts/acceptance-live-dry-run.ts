import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLiveBudgetManifest,
  LiveBudgetError,
  LiveBudgetLedger,
} from '../tests/acceptance/live-budget';
import { LIVE_CASE_CATALOG, LIVE_CATALOG_SHA256 } from '../tests/acceptance/live-cases';
import { createLiveFixture, LIVE_FIXTURE_VERSION } from '../tests/acceptance/live-fixtures';
import { acceptanceSourceIdentity } from './acceptance-identity';

// Constructs no provider, Web transport, vault or native adapter; no network is called.
// This command is an offline gate check, never an entrypoint for live task execution.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const offline = JSON.parse(
  await readFile(join(root, 'output/v1-acceptance/offline-tasks.json'), 'utf8'),
);
if (
  !offline.fixedSetComplete ||
  !offline.sourceUnchangedDuringRun ||
  offline.overallStatus !== 'pass'
)
  throw new Error('A current complete offline acceptance report is required.');
const expected = ['W', 'F', 'C'].flatMap((prefix) =>
  Array.from({ length: 10 }, (_, index) => prefix + String(index + 1).padStart(2, '0')),
);
if (
  offline.results.length !== 30 ||
  new Set(offline.results.map((item: { id: string }) => item.id)).size !== 30 ||
  expected.some(
    (id) =>
      !offline.results.some(
        (item: { id: string; offline: string }) => item.id === id && item.offline === 'pass',
      ),
  )
)
  throw new Error('The exact fixed offline task set must pass before dry-run preparation.');
if ((await acceptanceSourceIdentity(root)).sha256 !== offline.sourceIdentity.sha256)
  throw new Error('Offline source evidence is stale; rerun the fixed offline task set.');
const bundle = JSON.parse(
  await readFile(join(root, 'output/v1-validation/bundle-manifest.json'), 'utf8'),
);
for (const file of bundle) {
  if (hash(await readFile(join(root, file.path))) !== file.sha256)
    throw new Error('Production bundle evidence is stale.');
}
const now = Date.now();
const manifest = createLiveBudgetManifest({
  authorizationId: `pending_offline_${now}`,
  sourceSha256: offline.sourceIdentity.sha256,
  buildSha256: hash(JSON.stringify(bundle)),
  journalSha256: hash('offline-preparation-only; no durable journal is created'),
  caseIds: expected,
  createdAt: now,
  expiresAt: now + 30_000,
  limits: {
    provider: 0,
    search: 0,
    page: 0,
    redirects: 0,
    responseBodyBytes: 0,
    wallClockMs: 30_000,
  },
});
const ledger = new LiveBudgetLedger(manifest, {
  executionIdentity: { sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 },
});
let gateDenials = 0;
for (const caseId of expected) {
  try {
    ledger.reserve({ caseId, kind: 'provider', responseBytes: 1 });
    throw new Error('An unapproved dry-run reservation was accepted.');
  } catch (error) {
    if (!(error instanceof LiveBudgetError) || error.reason !== 'authorization') throw error;
    gateDenials++;
  }
}
const caseFixtures: { caseId: string; fixtureSha256: string; placeholderPdf: boolean }[] = [];
for (const caseId of expected) {
  const fixture = await createLiveFixture(caseId);
  try {
    caseFixtures.push({
      caseId,
      fixtureSha256: fixture.fixtureSha256,
      placeholderPdf: fixture.placeholderPdf,
    });
  } finally {
    await fixture.close();
  }
}
const inputPlan = {
  schemaVersion: 1,
  mode: 'offline-plan-only',
  isExecutionAuthorization: false,
  completeLiveRunnerAvailable: false,
  sourceSha256: manifest.sourceSha256,
  buildSha256: manifest.buildSha256,
  standardSha256: hash(await readFile(join(root, 'docs/V1-REAL-VALIDATION.md'))),
  catalogSha256: LIVE_CATALOG_SHA256,
  fixtureVersion: LIVE_FIXTURE_VERSION,
  fixtureSha256: hash(JSON.stringify(caseFixtures)),
  allocatedPathsRetained: false,
  providerAndModel: null,
  credentialReferences: null,
  approvedBudget: null,
  financialPolicy: null,
  dataScope:
    'Public research and generated dedicated temporary files only; paper titles are identity hints; PDF fixture bytes are placeholders. No user Downloads/Documents or real PDF parsing.',
  cases: LIVE_CASE_CATALOG.map((definition) => ({
    ...definition,
    fixture: caseFixtures.find((item) => item.caseId === definition.id),
  })),
  pending: [
    'actual main-only Electron/vault/native assembly',
    'actual crash and controlled-fault adapters',
    'trusted source observations and semantic human review capture',
    'credential/data/budget authorization and native readiness',
  ],
};
if ((await acceptanceSourceIdentity(root)).sha256 !== manifest.sourceSha256)
  throw new Error('Source changed during zero-network input preparation.');
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  mode: 'zero-network-offline-preparation',
  isLiveRunner: false,
  liveInputPlan: 'output/v1-validation/live-input-plan.json',
  catalogSha256: LIVE_CATALOG_SHA256,
  fixtureSha256: inputPlan.fixtureSha256,
  sourceSha256: manifest.sourceSha256,
  buildSha256: manifest.buildSha256,
  sourceAndBundleFilesMatchRecordedEvidence: true,
  humanConsentRecorded: false,
  dispatchGateDenials: gateDenials,
  externalHTTPRequests: 0,
  realCompleted: 0,
  realTotal: 30,
  ledger: ledger.usage(),
  pending: [
    'actual human credential/data/budget authorization',
    'actual Electron assembly and controlled fault adapters for the tested phase controller',
    'trusted real-task observations, ledger reconciliation and independent semantic reviews',
    'actual native cold credential readiness',
  ],
  scope:
    'This checks current recorded files and default-deny ledger behavior. It does not load credentials, construct network clients or execute real tasks; cannot prove future transport coverage or authorize execution.',
};
await mkdir(join(root, 'output/v1-validation'), { recursive: true });
await writeFile(
  join(root, 'output/v1-validation/live-input-plan.json'),
  `${JSON.stringify(inputPlan, null, 2)}\n`,
);
await writeFile(
  join(root, 'output/v1-validation/live-dry-run.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Offline preparation: ${gateDenials}/30 unapproved cases rejected; external HTTP 0; real 0/30. No live runner is invoked.`,
);
