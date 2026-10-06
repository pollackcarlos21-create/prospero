import { mkdtemp, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PermissionDecision, PermissionRequest } from '../../packages/core/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { BraveWebClient, type WebTransportResponse } from '../../packages/web/src';
import type { Conversation, DesktopEvent } from '../../apps/desktop/src/bridge';
import {
  DesktopService,
  type CredentialVault,
  type DesktopHost,
} from '../../apps/desktop/src/main/service';
import { startFakeProvider, type CapturedRequest, type FakeResponse } from '../e2e/fake-provider';

/** Task-layer acceptance uses the real service/provider/parser/SQLite/hosts and synthetic ports. */
export type Planner = (
  request: CapturedRequest,
  task: string,
  results: CapturedRequest['messages'],
) => FakeResponse | undefined;
export interface AcceptanceCase {
  id: string;
  title: string;
  run(ctx: CaseContext): Promise<void>;
}
export interface WebFixture {
  searches: Record<string, { url: string; title: string; description?: string }[]>;
  pages: Record<string, { html: string; status?: number }>;
}
export interface WebReceipt {
  kind: 'search' | 'fetch';
  input: string;
  status: number;
  bytes: number;
  outcome: 'started' | 'response' | 'failed' | 'cancelled';
  responseBytesKnown: boolean;
}
export interface RunOptions {
  onPermission?: (
    request: PermissionRequest,
    ctx: CaseContext,
  ) => Promise<PermissionDecision | undefined>;
  timeoutMs?: number;
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export class CaseContext {
  service!: DesktopService;
  store!: ProsperoStore;
  conversationId = '';
  scopeId = '';
  readonly approvals: PermissionRequest[] = [];
  readonly webRequests: WebReceipt[] = [];
  readonly nativeEffects: { kind: 'trash' | 'open' | 'reveal'; path: string }[] = [];
  readonly events: DesktopEvent[] = [];
  readonly runReceipts: { modelRequests: number; toolCalls: number; state: string }[] = [];
  beforeNative?: (kind: 'trash' | 'open' | 'reveal', path: string) => Promise<void>;
  beforeWeb?: (
    kind: 'search' | 'fetch',
    input: string,
    signal: AbortSignal,
  ) => Promise<WebTransportResponse | undefined>;
  private planner?: Planner;
  private plannerFailure?: unknown;
  private web: WebFixture = { searches: {}, pages: {} };
  private credentials = new Map<string, string>();
  private provider!: Awaited<ReturnType<typeof startFakeProvider>>;
  private selectedFolder = '';
  private storeOpen = false;

  private constructor(
    readonly temp: string,
    readonly root: string,
  ) {}
  static async create(): Promise<CaseContext> {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'prospero-acceptance-')));
    const root = join(temp, 'files');
    await mkdir(root);
    await mkdir(join(temp, 'fixture-trash'));
    const ctx = new CaseContext(temp, root);
    try {
      ctx.selectedFolder = root;
      ctx.provider = await startFakeProvider((request, task, results) => {
        if (!ctx.planner) throw new Error('Acceptance planner has not been configured.');
        try {
          const answer = ctx.planner(request, task, results);
          if (!answer)
            throw new Error('Acceptance planner must explicitly handle every model turn.');
          return answer;
        } catch (error) {
          ctx.plannerFailure = error;
          return {
            text: 'The synthetic fixture planner failed; this acceptance task is incomplete.',
          };
        }
      });
      ctx.openService();
      const provider = await ctx.service.saveProvider({
        displayName: 'Synthetic offline acceptance',
        baseUrl: ctx.provider.baseUrl,
        model: 'deterministic-fixture-planner',
        supportsTools: true,
      });
      const conversation = ctx.service.createConversation();
      ctx.conversationId = conversation.id;
      ctx.service.selectProvider(conversation.id, provider.id);
      ctx.scopeId = (await ctx.service.addScope(conversation.id, 'write')).scopes?.[0]?.id ?? '';
      if (!ctx.scopeId) throw new Error('Main did not issue the temporary fixture scope.');
      await ctx.service.saveWebSearch({
        enabled: true,
        retention: 'sources',
        apiKey: 'offline-brave-fixture-key',
      });
      return ctx;
    } catch (error) {
      await ctx.close();
      throw error;
    }
  }
  get providerRequests() {
    return this.provider.requests;
  }
  setPlanner(planner: Planner) {
    this.planner = planner;
    this.plannerFailure = undefined;
  }
  configureWeb(value: WebFixture) {
    this.web = structuredClone(value);
  }
  async setRetention(retention: 'session' | 'sources') {
    await this.service.saveWebSearch({ enabled: true, retention });
  }
  async addScope(path: string, mode: 'read' | 'write' = 'write') {
    this.selectedFolder = path;
    const before = new Set(
      this.service.getConversation(this.conversationId).scopes?.map((scope) => scope.id),
    );
    const updated = await this.service.addScope(this.conversationId, mode);
    this.selectedFolder = this.root;
    const scope = updated.scopes?.find((value) => !before.has(value.id));
    if (!scope) throw new Error('Expected a new main-owned fixture scope.');
    return scope.id;
  }
  private openService() {
    this.store = new ProsperoStore(join(this.temp, 'prospero.sqlite'));
    this.storeOpen = true;
    const vault: CredentialVault = {
      put: async (id, key) => {
        this.credentials.set(id, key);
        this.store.saveEncryptedCredential(id, new Uint8Array([3, 1, 4, 1, 5]));
      },
      get: async (id, signal) => {
        signal?.throwIfAborted();
        return this.credentials.get(id);
      },
    };
    const native: DesktopHost = {
      appearance: () => ({ dark: false, reducedMotion: false }),
      ready() {},
      contextMenu() {},
      copy() {},
      taskFinished() {},
      reveal: (path) => {
        this.nativeEffects.push({ kind: 'reveal', path });
      },
      trash: async (path) => {
        await this.beforeNative?.('trash', path);
        await rename(path, join(this.temp, 'fixture-trash', basename(path)));
        this.nativeEffects.push({ kind: 'trash', path });
      },
      openSource: async (path) => {
        await this.beforeNative?.('open', path);
        this.nativeEffects.push({ kind: 'open', path });
      },
    };
    this.service = new DesktopService(
      this.store,
      vault,
      { folder: async () => this.selectedFolder, files: async () => [] },
      (event) => this.events.push(structuredClone(event)),
      '0.2.0',
      undefined,
      native,
      (apiKey) =>
        new BraveWebClient(
          { apiKey },
          {
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            transport: async ({ url, signal, maxBytes }) => {
              signal.throwIfAborted();
              const searching = url.origin === 'https://api.search.brave.com';
              const kind = searching ? 'search' : 'fetch';
              const input = searching ? (url.searchParams.get('q') ?? '') : url.href;
              const receipt: WebReceipt = {
                kind,
                input,
                status: 0,
                bytes: 0,
                outcome: 'started',
                responseBytesKnown: false,
              };
              this.webRequests.push(receipt);
              try {
                const injected = await this.beforeWeb?.(kind, input, signal);
                signal.throwIfAborted();
                let response: WebTransportResponse;
                if (injected) response = injected;
                else if (searching) {
                  if (!Object.hasOwn(this.web.searches, input))
                    throw new Error('Unconfigured synthetic search query.');
                  response = {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: new TextEncoder().encode(
                      JSON.stringify({
                        type: 'search',
                        web: { results: this.web.searches[input] },
                      }),
                    ),
                  };
                } else {
                  const page = this.web.pages[input];
                  if (!page) throw new Error('Unconfigured synthetic page URL.');
                  response = {
                    status: page.status ?? 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    body: new TextEncoder().encode(page.html),
                  };
                }
                Object.assign(receipt, {
                  status: response.status,
                  bytes: response.body.byteLength,
                  responseBytesKnown: true,
                });
                if (response.body.byteLength > maxBytes)
                  throw new Error('Fixture exceeded the actual request body cap.');
                receipt.outcome = 'response';
                return response;
              } catch (error) {
                receipt.outcome = signal.aborted ? 'cancelled' : 'failed';
                throw error;
              }
            },
          },
        ),
    );
  }
  approve(request: PermissionRequest, decision: PermissionDecision = 'allow-once') {
    if (request.preview.plan) {
      if (decision === 'allow-session') throw new Error('Plans never accept session approval.');
      this.service.decideActionPlan(
        this.conversationId,
        request.requestId,
        request.preview.plan.digest,
        decision,
      );
    } else if (request.preview.research) {
      if (decision === 'allow-session') throw new Error('Research never accepts session approval.');
      this.service.decideResearch(
        this.conversationId,
        request.requestId,
        request.preview.research.digest,
        decision,
      );
    } else this.service.decidePermission(this.conversationId, request.requestId, decision);
  }
  async waitPermission() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const request = this.service.getConversation(this.conversationId).pendingPermission;
      if (request) return request;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Acceptance deadline waiting for a permission preview.');
  }
  async run(task: string, planner: Planner, options: RunOptions = {}): Promise<Conversation> {
    this.setPlanner(planner);
    const requestStart = this.providerRequests.length;
    const toolStart = this.service
      .getConversation(this.conversationId)
      .timeline.filter((item) => item.type === 'tool').length;
    await this.service.sendTask(this.conversationId, task);
    const handled = new Set<string>();
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const value = this.service.getConversation(this.conversationId);
      const request = value.pendingPermission;
      if (request && !handled.has(request.requestId)) {
        handled.add(request.requestId);
        this.approvals.push(structuredClone(request));
        const decision = options.onPermission
          ? await options.onPermission(request, this)
          : request.allowSession
            ? 'allow-session'
            : 'allow-once';
        if (decision !== undefined) this.approve(request, decision);
      }
      if (terminal.has(value.state) && !value.streamingText && !value.pendingPermission) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (this.plannerFailure) throw this.plannerFailure;
        const finished = this.service.getConversation(this.conversationId);
        this.runReceipts.push({
          modelRequests: this.providerRequests.length - requestStart,
          toolCalls: finished.timeline.filter((item) => item.type === 'tool').length - toolStart,
          state: finished.state,
        });
        return finished;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.service.stopTask(this.conversationId);
    throw new Error('Acceptance task exceeded its fixture wall clock deadline.');
  }
  async restart() {
    await this.suspendForCrash();
    this.openService();
  }
  async suspendForCrash() {
    await this.service.shutdown();
    if (this.storeOpen) this.store.close();
    this.storeOpen = false;
  }
  reopenAfterCrash() {
    this.openService();
  }
  evidence() {
    const value = this.service.getConversation(this.conversationId);
    return {
      planner: 'deterministic synthetic planner over actual tool results',
      ports: {
        model: 'loopback HTTP SSE',
        web: 'fake DNS/raw transport + real Brave parsing',
        vault: 'fake port',
        nativeTrash: 'temporary fixture rename',
      },
      modelRequests: this.providerRequests.length,
      runReceipts: this.runReceipts,
      webRequests: this.webRequests,
      approvalSnapshots: this.approvals.map(({ call, preview }) => ({
        tool: call.name,
        digest: preview.plan?.digest ?? preview.research?.digest,
        actions: preview.plan?.actions.length,
        queries: preview.research?.queries.length,
      })),
      sources: value.sources?.map(({ id, url, kind, contentHash, retrievedAt }) => ({
        id,
        url,
        kind,
        contentHash,
        retrievedAt,
      })),
      actionPlans: value.actionPlans?.map(({ plan, status, journal }) => ({
        digest: plan.digest,
        status,
        actions: plan.actions.map(({ id, kind }) => ({
          id,
          kind,
          status: journal.findLast((entry) => entry.actionId === id)?.status,
        })),
      })),
      researchPlans: value.researchPlans?.map(({ snapshot, events }) => ({
        digest: snapshot.digest,
        events: events.map(({ type, status, responseBytes, kind }) => ({
          type,
          status,
          responseBytes,
          kind,
        })),
      })),
      finalState: value.state,
    };
  }
  async close() {
    if (this.service) await this.service.shutdown();
    if (this.provider) await this.provider.close();
    if (this.storeOpen) this.store.close();
    this.storeOpen = false;
    await rm(this.temp, { recursive: true, force: true });
  }
}
