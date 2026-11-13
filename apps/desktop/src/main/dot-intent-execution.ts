import type {
  PermissionRequest,
  PreparedTool,
  ToolCall,
  ToolHost,
  ToolResult,
  AgentContinuation,
} from '@prospero/core';
import type { Dot, DotRun } from '@prospero/dots';
import {
  DotRepositoryError,
  type DotIntent,
  type DotIntentProvider,
  type DotIntentReceipt,
  type DotRepository,
} from '@prospero/persistence';
import { UserError } from './validation';

export interface DotResearchSession extends ToolHost {
  isSensitive?(value: string): boolean;
  /** Durable bounded metadata only; do not persist raw page bodies or secrets. */
  receipt(call: ToolCall, result: ToolResult): DotIntentReceipt;
  close(): void | Promise<void>;
  retain?(continuation: AgentContinuation): AgentContinuation;
}
/** Main-owned research adapter; no generic runtime/plugin or renderer capability. */
export interface DotResearchRuntime {
  provider(id: string): DotIntentProvider | undefined;
  policyRevision(dotId: string): number;
  open(input: {
    dot: Dot;
    run: DotRun;
    signal: AbortSignal;
    isSensitive?: (value: string) => boolean;
  }): Promise<DotResearchSession>;
}
function providerMatches(actual: DotIntentProvider | undefined, saved: DotIntentProvider): boolean {
  return (
    !!actual &&
    actual.id === saved.id &&
    actual.baseUrl === saved.baseUrl &&
    actual.model === saved.model
  );
}
function signature(request: PermissionRequest): string {
  const preview = request.preview;
  if (
    Reflect.ownKeys(preview).some(
      (key) =>
        typeof key !== 'string' || !['kind', 'title', 'effects', 'query', 'url'].includes(key),
    )
  )
    throw new UserError('The Dot research preview must be prepared again.');
  return JSON.stringify({
    requestId: request.requestId,
    call: { id: request.call.id, name: request.call.name, arguments: request.call.arguments },
    permissionKey: request.permissionKey,
    allowSession: request.allowSession,
    preview: {
      kind: preview.kind,
      title: preview.title,
      effects: [...(preview.effects ?? [])].sort(),
      ...(preview.query === undefined ? {} : { query: preview.query }),
      ...(preview.url === undefined ? {} : { url: preview.url }),
    },
  });
}
export function dotIntentStillMatches(intent: DotIntent, runtime: DotResearchRuntime): boolean {
  return dotResearchConfigurationMatches(
    intent.provider,
    intent.policyRevision,
    intent.dotId,
    runtime,
  );
}
export function dotResearchConfigurationMatches(
  provider: DotIntentProvider,
  policyRevision: number,
  dotId: string,
  runtime: DotResearchRuntime,
): boolean {
  return (
    providerMatches(runtime.provider(provider.id), provider) &&
    runtime.policyRevision(dotId) === policyRevision
  );
}
function requestsMatch(actual: PermissionRequest, saved: PermissionRequest): boolean {
  try {
    return signature(actual) === signature(saved);
  } catch {
    return false;
  }
}

/** Exact permission/dispatch boundary for one invocation; it never drives another agent loop. */
export class DotIntentExecution implements ToolHost {
  readonly definitions: ToolHost['definitions'];
  failure?: DotRepositoryError;
  uncertain = false;
  private granted = new Map<ToolCall, PreparedTool>();
  private approvedConsumed = false;
  private authorised?: PreparedTool;
  constructor(
    private repository: DotRepository,
    private session: DotResearchSession,
    private runtime: DotResearchRuntime,
    private approved: DotIntent | undefined,
    private now: () => number,
    private abort: () => void,
  ) {
    this.definitions = session.definitions;
    if (
      approved &&
      !this.definitions.some((definition) => definition.name === approved.request.call.name)
    )
      throw new UserError('The approved Dot research tool is no longer available.');
    for (const definition of this.definitions) {
      if (
        !['web_search', 'fetch_source', 'fetch_page'].includes(definition.name) ||
        definition.riskLevel !== 'read' ||
        !definition.effects?.length ||
        definition.effects.some(
          (effect) => effect !== 'network.search' && effect !== 'network.fetch',
        )
      )
        throw new UserError('This Dot research adapter is not supported.');
    }
  }
  async prepare(call: ToolCall, signal: AbortSignal): Promise<PreparedTool> {
    const prepared = await this.session.prepare(call, signal);
    signal.throwIfAborted();
    if (
      !prepared.onSuspended ||
      prepared.preview.kind !== 'web' ||
      prepared.allowSession ||
      !prepared.requiresPermission
    )
      throw new UserError('The Dot research request cannot be suspended safely.');
    const wrapper: PreparedTool = {
      ...prepared,
      execute: async (executionSignal) => {
        executionSignal.throwIfAborted();
        if (
          !this.approved ||
          this.granted.get(call) !== wrapper ||
          this.authorised !== wrapper ||
          this.approvedConsumed
        ) {
          this.abort();
          throw new UserError('This Dot research request needs a fresh approval.');
        }
        const freshRequest = {
          requestId: this.approved.request.requestId,
          call,
          preview: prepared.preview,
          permissionKey: prepared.permissionKey,
          allowSession: prepared.allowSession,
        };
        if (
          !dotIntentStillMatches(this.approved, this.runtime) ||
          !requestsMatch(freshRequest, this.approved.request)
        ) {
          try {
            this.repository.invalidateIntent(
              this.approved.id,
              this.approved.revision,
              this.approved.digest,
              'stale',
              Math.max(this.now(), this.approved.updatedAt),
            );
          } catch (error) {
            this.persistenceFailed(error);
            throw error;
          }
          this.abort();
          throw new UserError('The Dot request changed before dispatch. Review it again.');
        }
        this.granted.delete(call);
        this.approvedConsumed = true;
        let dispatched: DotIntent;
        try {
          dispatched = this.repository.dispatchIntent(
            this.approved.id,
            this.approved.revision,
            this.approved.digest,
            this.now(),
          );
        } catch (error) {
          this.persistenceFailed(error);
          throw error;
        }
        let result: ToolResult;
        try {
          result = await prepared.execute(executionSignal);
          if (!result || typeof result.content !== 'string' || result.isError)
            throw new Error('No confirmed response.');
        } catch {
          try {
            this.repository.settleIntent(
              dispatched.id,
              dispatched.revision,
              dispatched.digest,
              { status: 'unknown' },
              Math.max(this.now(), dispatched.updatedAt),
            );
          } catch (error) {
            this.persistenceFailed(error);
            throw error;
          }
          this.uncertain = true;
          this.abort();
          throw new UserError(
            'The research request has an uncertain outcome. Inspect it before continuing.',
          );
        }
        try {
          const receipt = this.session.receipt(call, result);
          this.repository.settleIntent(
            dispatched.id,
            dispatched.revision,
            dispatched.digest,
            { status: 'succeeded', receipt },
            Math.max(this.now(), dispatched.updatedAt),
          );
        } catch (error) {
          this.persistenceFailed(error);
          throw error;
        }
        return result;
      },
    };
    this.granted.set(call, wrapper);
    return wrapper;
  }
  private persistenceFailed(error: unknown) {
    this.failure =
      error instanceof DotRepositoryError ? error : new DotRepositoryError('storage-failure');
    this.abort();
  }
  async decide(request: PermissionRequest): Promise<'allow-once' | 'suspend'> {
    const prepared = this.granted.get(request.call);
    if (
      !prepared ||
      request.preview !== prepared.preview ||
      request.permissionKey !== prepared.permissionKey ||
      request.allowSession
    )
      throw new UserError('The prepared Dot request no longer matches its preview.');
    if (!this.approved || this.approvedConsumed) return 'suspend';
    if (
      !dotIntentStillMatches(this.approved, this.runtime) ||
      !requestsMatch(request, this.approved.request)
    ) {
      try {
        this.repository.invalidateIntent(
          this.approved.id,
          this.approved.revision,
          this.approved.digest,
          'stale',
          Math.max(this.now(), this.approved.updatedAt),
        );
      } catch (error) {
        this.persistenceFailed(error);
        throw error;
      }
      throw new UserError('The Dot request changed. Review a fresh preview before continuing.');
    }
    this.authorised = prepared;
    return 'allow-once';
  }
}
