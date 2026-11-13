import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createDotResearchPolicy,
  rehydrateDotResearchPolicy,
  type DotResearchPolicy,
  type DotResearchPolicyInput,
  type DotPolicyUsage,
  type Dot,
  type DotRun,
} from '@prospero/dots';
import { DotRepositoryError } from './dot-errors';
import type { DotIntent, DotIntentProvider, DotIntentInput } from './dot-intent';
import type { DotIntentStore } from './dot-intent-store';
export interface DotPolicySnapshot {
  readonly policy: DotResearchPolicy;
  readonly usage: DotPolicyUsage;
}
function blocked(): never {
  throw new DotRepositoryError('policy-blocked');
}
function corrupt(): never {
  throw new DotRepositoryError('invalid-stored-state');
}
const sameProvider = (a: DotIntentProvider, b: DotIntentProvider) =>
  a.id === b.id && a.baseUrl === b.baseUrl && a.model === b.model;
const binding = (p: DotResearchPolicy): DotResearchPolicyInput => ({
  id: p.id,
  dotId: p.dotId,
  createdAt: p.createdAt,
  expiresAt: p.expiresAt,
  provider: p.provider,
  configurationRevision: p.configurationRevision,
  queries: p.queries,
  allowDiscoveredPages: p.allowDiscoveredPages,
  limits: p.limits,
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class DotPolicyStore {
  constructor(
    private db: DatabaseSync,
    private dot: (id: string) => Dot,
    private run: (id: string) => DotRun,
    private intents: DotIntentStore,
  ) {}
  get(id: string): DotPolicySnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM dot_policies WHERE id=?').get(id);
    if (!row) return;
    let policy: DotResearchPolicy;
    try {
      if (typeof row.binding !== 'string' || Buffer.byteLength(row.binding, 'utf8') > 32 * 1024)
        corrupt();
      const initial = createDotResearchPolicy(JSON.parse(row.binding));
      if (hash(binding(initial)) !== row.digest) corrupt();
      policy = rehydrateDotResearchPolicy({
        ...initial,
        status: row.status,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
    } catch {
      corrupt();
    }
    if (
      row.id !== policy.id ||
      row.dot_id !== policy.dotId ||
      row.created_at !== policy.createdAt ||
      row.expires_at !== policy.expiresAt
    )
      corrupt();
    this.dot(policy.dotId);
    const usage = {
      runs: 0,
      searches: 0,
      fetches: 0,
      reservedResponseBytes: 0,
      reservedModelTurns: 0,
      reservedModelRequestBytes: 0,
    };
    const rows = this.db
      .prepare('SELECT * FROM dot_policy_usage WHERE policy_id=? ORDER BY at,id LIMIT 902')
      .all(id);
    if (rows.length > 900) corrupt();
    for (const entry of rows) {
      const run = this.run(String(entry.run_id));
      if (
        run.dotId !== policy.dotId ||
        entry.dot_id !== policy.dotId ||
        typeof entry.at !== 'number' ||
        !Number.isSafeInteger(entry.at) ||
        entry.at < policy.createdAt ||
        entry.at >= policy.expiresAt ||
        (policy.status === 'revoked' && entry.at > policy.updatedAt) ||
        entry.at < run.createdAt
      )
        corrupt();
      if (entry.kind === 'run') {
        if (
          entry.id !== `run:${run.id}` ||
          entry.intent_id !== null ||
          entry.at !== run.createdAt ||
          entry.model_turns !== 8 ||
          entry.model_bytes !== 8 * 96 * 1024 ||
          entry.body_bytes !== 0
        )
          corrupt();
        usage.runs++;
        usage.reservedModelTurns += 8;
        usage.reservedModelRequestBytes += 8 * 96 * 1024;
      } else {
        if (typeof entry.intent_id !== 'string') corrupt();
        const intent = this.intents.required(entry.intent_id);
        const cap =
          entry.kind === 'search' ? 256 * 1024 : entry.kind === 'fetch' ? 1024 * 1024 : corrupt();
        if (
          entry.id !== `intent:${intent.id}` ||
          intent.runId !== run.id ||
          intent.dotId !== policy.dotId ||
          intent.dispatchedAt !== entry.at ||
          intent.policyRevision !== policy.configurationRevision ||
          !sameProvider(intent.provider, policy.provider) ||
          intent.request.call.name !== (entry.kind === 'search' ? 'web_search' : 'fetch_page') ||
          entry.model_turns !== 0 ||
          entry.model_bytes !== 0 ||
          entry.body_bytes !== cap ||
          !this.db
            .prepare(
              "SELECT id FROM dot_policy_usage WHERE run_id=? AND policy_id=? AND kind='run'",
            )
            .get(run.id, policy.id)
        )
          corrupt();
        if (entry.kind === 'search') usage.searches++;
        else usage.fetches++;
        usage.reservedResponseBytes += cap;
      }
    }
    if (
      usage.runs > policy.limits.maxRuns ||
      usage.searches > policy.limits.maxSearches ||
      usage.fetches > policy.limits.maxFetches ||
      usage.reservedResponseBytes > policy.limits.maxResponseBytes ||
      usage.reservedModelTurns > policy.limits.maxModelTurns ||
      usage.reservedModelRequestBytes > policy.limits.maxModelRequestBytes
    )
      corrupt();
    return Object.freeze({ policy, usage: Object.freeze(usage) });
  }
  required(id: string): DotPolicySnapshot {
    const snapshot = this.get(id);
    if (!snapshot) throw new DotRepositoryError('not-found');
    return snapshot;
  }
  current(dotId: string): DotPolicySnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM dot_policies WHERE dot_id=? ORDER BY (status='active') DESC,created_at DESC,id DESC LIMIT 1",
      )
      .get(dotId);
    return row ? this.required(String(row.id)) : undefined;
  }
  create(input: DotResearchPolicyInput, revision: number): DotPolicySnapshot {
    const policy = createDotResearchPolicy(input);
    const dot = this.dot(policy.dotId);
    if (dot.revision !== revision) throw new DotRepositoryError('conflict');
    const previous = this.current(policy.dotId);
    if (
      dot.lifecycle !== 'active' ||
      dot.inFlightRunId ||
      policy.createdAt < dot.updatedAt ||
      (previous && policy.createdAt < previous.policy.updatedAt) ||
      this.db.prepare("SELECT id FROM dot_policies WHERE dot_id=? AND status='active'").get(dot.id)
    )
      blocked();
    if (this.db.prepare('SELECT id FROM dot_policies WHERE id=?').get(policy.id))
      throw new DotRepositoryError('duplicate-id');
    const encoded = JSON.stringify(binding(policy));
    this.db
      .prepare(
        'INSERT INTO dot_policies(id,dot_id,binding,digest,status,revision,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        policy.id,
        policy.dotId,
        encoded,
        hash(binding(policy)),
        policy.status,
        policy.revision,
        policy.createdAt,
        policy.expiresAt,
        policy.updatedAt,
      );
    return this.required(policy.id);
  }
  revoke(id: string, revision: number, at: number): DotPolicySnapshot {
    const snapshot = this.required(id);
    const p = snapshot.policy;
    if (p.revision !== revision) throw new DotRepositoryError('conflict');
    if (p.status !== 'active') blocked();
    const result = this.db
      .prepare(
        "UPDATE dot_policies SET status='revoked',revision=1,updated_at=? WHERE id=? AND status='active' AND revision=0",
      )
      .run(
        Math.max(
          at,
          p.updatedAt,
          Number(
            this.db
              .prepare('SELECT MAX(at) AS latest FROM dot_policy_usage WHERE policy_id=?')
              .get(id)?.latest ?? 0,
          ),
        ),
        id,
      );
    if (result.changes !== 1) throw new DotRepositoryError('conflict');
    return this.required(id);
  }
  forRun(runId: string): DotPolicySnapshot | undefined {
    const row = this.db
      .prepare("SELECT policy_id FROM dot_policy_usage WHERE run_id=? AND kind='run'")
      .get(runId);
    return row ? this.required(String(row.policy_id)) : undefined;
  }
  private active(snapshot: DotPolicySnapshot, at: number) {
    if (
      snapshot.policy.status !== 'active' ||
      at < snapshot.policy.createdAt ||
      at >= snapshot.policy.expiresAt
    )
      blocked();
  }
  private insert(
    policy: DotResearchPolicy,
    run: DotRun,
    at: number,
    kind: 'run' | 'search' | 'fetch',
    intentId?: string,
  ) {
    this.db
      .prepare(
        'INSERT INTO dot_policy_usage(id,policy_id,dot_id,run_id,intent_id,kind,model_turns,model_bytes,body_bytes,at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        kind === 'run' ? `run:${run.id}` : `intent:${intentId}`,
        policy.id,
        policy.dotId,
        run.id,
        intentId ?? null,
        kind,
        kind === 'run' ? 8 : 0,
        kind === 'run' ? 8 * 96 * 1024 : 0,
        kind === 'run' ? 0 : kind === 'search' ? 256 * 1024 : 1024 * 1024,
        at,
      );
  }
  nextRunBlock(
    id: string,
    provider: DotIntentProvider | undefined,
    configurationRevision: number | undefined,
    at: number,
  ): 'policy' | 'configuration' | 'budget' | undefined {
    const { policy: p, usage: u } = this.required(id);
    if (p.status !== 'active' || at < p.createdAt || at >= p.expiresAt) return 'policy';
    if (
      !provider ||
      !sameProvider(provider, p.provider) ||
      configurationRevision !== p.configurationRevision
    )
      return 'configuration';
    if (
      u.runs + 1 > p.limits.maxRuns ||
      u.reservedModelTurns + 8 > p.limits.maxModelTurns ||
      u.reservedModelRequestBytes + 8 * 96 * 1024 > p.limits.maxModelRequestBytes
    )
      return 'budget';
  }
  reserveRun(
    run: DotRun,
    provider: DotIntentProvider | undefined,
    configurationRevision: number | undefined,
  ) {
    const snapshot = this.current(run.dotId);
    if (snapshot?.policy.status !== 'active') return;
    if (this.nextRunBlock(snapshot.policy.id, provider, configurationRevision, run.createdAt))
      blocked();
    this.insert(snapshot.policy, run, run.createdAt, 'run');
  }

  assertRun(runId: string, provider: DotIntentProvider, configurationRevision: number, at: number) {
    const snapshot = this.forRun(runId);
    if (!snapshot) return;
    const run = this.run(runId);
    const dot = this.dot(run.dotId);
    if (
      !['pending', 'running'].includes(run.status) ||
      dot.lifecycle !== 'active' ||
      dot.inFlightRunId !== run.id
    )
      blocked();
    this.active(snapshot, at);
    if (
      !sameProvider(provider, snapshot.policy.provider) ||
      configurationRevision !== snapshot.policy.configurationRevision
    )
      blocked();
  }
  private canCharge(snapshot: DotPolicySnapshot, intent: DotIntent) {
    const { policy: p, usage: u } = snapshot;
    const search = intent.request.call.name === 'web_search';
    if (!search && intent.request.call.name !== 'fetch_page') return false;
    return (
      u.searches + (search ? 1 : 0) <= p.limits.maxSearches &&
      u.fetches + (search ? 0 : 1) <= p.limits.maxFetches &&
      u.reservedResponseBytes + (search ? 256 * 1024 : 1024 * 1024) <= p.limits.maxResponseBytes
    );
  }
  checkIntent(input: DotIntentInput) {
    if (!this.forRun(input.runId)) return;
    this.assertRun(input.runId, input.provider, input.policyRevision, input.createdAt);
    if (
      input.continuation.limits.maxModelTurns > 8 ||
      input.continuation.limits.maxContextBytes > 96 * 1024
    )
      blocked();
  }
  private matchesScope(snapshot: DotPolicySnapshot, intent: DotIntent): boolean {
    let args: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(intent.request.call.arguments);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      args = raw as Record<string, unknown>;
    } catch {
      return false;
    }
    if (intent.request.call.name === 'web_search') {
      if (
        Object.keys(args).some((key) => !['query', 'maxResults'].includes(key)) ||
        typeof args.query !== 'string'
      )
        return false;
      const query = args.query.trim();
      const count = args.maxResults ?? 5;
      return (
        query === intent.request.preview.query &&
        typeof count === 'number' &&
        Number.isInteger(count) &&
        count >= 1 &&
        snapshot.policy.queries.some((entry) => entry.query === query && count <= entry.maxResults)
      );
    }
    if (
      intent.request.call.name !== 'fetch_page' ||
      !snapshot.policy.allowDiscoveredPages ||
      Object.keys(args).some((key) => key !== 'url') ||
      typeof args.url !== 'string'
    )
      return false;
    let url: string;
    try {
      const parsed = new URL(args.url);
      parsed.hash = '';
      url = parsed.href;
    } catch {
      return false;
    }
    if (url !== intent.request.preview.url) return false;
    const searches = this.db
      .prepare("SELECT intent_id FROM dot_policy_usage WHERE policy_id=? AND kind='search'")
      .all(snapshot.policy.id);
    return searches.some((row) => {
      const source = this.intents.required(String(row.intent_id));
      return (
        source.status === 'succeeded' &&
        this.matchesScope(snapshot, source) &&
        source.receipt?.sources?.some((item) => item.kind === 'search' && item.url === url)
      );
    });
  }
  private eligibleApproval(
    intent: DotIntent,
    snapshot: DotPolicySnapshot | undefined,
    at: number,
  ): boolean {
    if (
      snapshot?.policy.status !== 'active' ||
      at < snapshot.policy.createdAt ||
      at >= snapshot.policy.expiresAt ||
      at < intent.updatedAt ||
      at >= intent.expiresAt ||
      !sameProvider(intent.provider, snapshot.policy.provider) ||
      intent.policyRevision !== snapshot.policy.configurationRevision ||
      !this.canCharge(snapshot, intent) ||
      !this.matchesScope(snapshot, intent)
    )
      return false;
    return (
      intent.status === 'pending' ||
      (intent.status === 'approved' && this.hasProof(intent, snapshot.policy))
    );
  }
  canApprove(intentId: string, at: number): boolean {
    const intent = this.intents.required(intentId);
    return this.eligibleApproval(intent, this.forRun(intent.runId), at);
  }
  approve(intentId: string, at: number): DotIntent | undefined {
    const intent = this.intents.required(intentId);
    const snapshot = this.forRun(intent.runId);
    if (!this.eligibleApproval(intent, snapshot, at) || !snapshot) return;
    if (intent.status === 'approved') {
      return this.hasProof(intent, snapshot.policy) ? intent : undefined;
    }
    if (intent.status !== 'pending') return;
    const approved = this.intents.decide(intent.id, intent.revision, intent.digest, 'approve', at);
    this.db
      .prepare('INSERT INTO dot_policy_approvals(intent_id,policy_id,digest,at) VALUES(?,?,?,?)')
      .run(intent.id, snapshot.policy.id, intent.digest, at);
    return approved;
  }
  charge(intent: DotIntent, at: number) {
    const snapshot = this.forRun(intent.runId);
    if (!snapshot) return;
    this.assertRun(intent.runId, intent.provider, intent.policyRevision, at);
    if (!this.canCharge(snapshot, intent)) blocked();
    if (this.hasProof(intent, snapshot.policy) && !this.matchesScope(snapshot, intent)) blocked();
    this.insert(
      snapshot.policy,
      this.run(intent.runId),
      at,
      intent.request.call.name === 'web_search' ? 'search' : 'fetch',
      intent.id,
    );
  }
  private hasProof(intent: DotIntent, policy: DotResearchPolicy): boolean {
    const proof = this.db
      .prepare('SELECT * FROM dot_policy_approvals WHERE intent_id=?')
      .get(intent.id);
    if (!proof) return false;
    const approved = this.intents.events(intent.id).find((event) => event.status === 'approved');
    if (
      proof.policy_id !== policy.id ||
      proof.digest !== intent.digest ||
      !approved ||
      proof.at !== approved.at ||
      approved.at < policy.createdAt ||
      approved.at >= policy.expiresAt
    )
      corrupt();
    return true;
  }
  revokeRun(runId: string, at: number) {
    const snapshot = this.forRun(runId);
    if (snapshot?.policy.status === 'active') this.revoke(snapshot.policy.id, 0, at);
    return snapshot?.policy.id;
  }
  recover(at: number) {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT u.policy_id FROM dot_policy_usage u JOIN dot_intents i ON i.id=u.intent_id WHERE i.status='unknown'",
      )
      .all();
    for (const row of rows) {
      const snapshot = this.required(String(row.policy_id));
      if (snapshot.policy.status === 'active') this.revoke(snapshot.policy.id, 0, at);
    }
    const requests = this.db
      .prepare(
        "SELECT i.id,i.run_id FROM dot_intents i JOIN dot_policy_usage u ON u.run_id=i.run_id AND u.kind='run' JOIN dot_policies p ON p.id=u.policy_id WHERE i.status IN ('pending','approved') AND (p.status='revoked' OR p.expires_at<=?)",
      )
      .all(at);
    for (const row of requests) {
      const intent = this.intents.required(String(row.id));
      this.intents.invalidate(
        intent.id,
        intent.revision,
        intent.digest,
        'stale',
        Math.max(at, intent.updatedAt),
      );
    }
  }
  candidates(at: number, limit: number): readonly string[] {
    const rows = this.db
      .prepare(
        "SELECT i.id FROM dot_intents i JOIN dot_policy_usage u ON u.run_id=i.run_id AND u.kind='run' JOIN dot_policies p ON p.id=u.policy_id JOIN dots d ON d.id=i.dot_id WHERE i.status IN ('pending','approved') AND i.expires_at>? AND p.status='active' AND p.created_at<=? AND p.expires_at>? AND d.lifecycle='active' AND d.in_flight_run_id=i.run_id ORDER BY i.created_at,i.id LIMIT ?",
      )
      .all(at, at, at, limit);
    return Object.freeze(
      rows.map((row) => {
        if (typeof row.id !== 'string') corrupt();
        this.intents.required(row.id);
        return row.id;
      }),
    );
  }
}
