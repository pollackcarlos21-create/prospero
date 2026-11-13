import type {
  Dot,
  DotRun,
  DotCheckpoint,
  DotResearchPolicy,
  DotResearchPolicyInput,
  DotPolicyUsage,
  DotWake,
  DotIntentReview,
  DotContextQuery,
  DotRecordQuery,
} from '@prospero/dots';
export type DotPolicyTerms = Pick<
  DotResearchPolicyInput,
  'queries' | 'allowDiscoveredPages' | 'expiresAt' | 'limits'
>;
import type {
  ExecutionState,
  Message,
  PermissionDecision,
  PermissionRequest,
  ToolCall,
  ToolPreview,
  ToolResult,
  FileScope,
  SourceRecord,
  ActionPlan,
  ActionJournalEntry,
  PlanStatus,
  ResearchPlan,
  ResearchEvent,
} from '@prospero/core';
export interface ProviderConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  supportsTools: boolean;
  hasApiKey: boolean;
}
export interface DotPage {
  limit?: number;
  offset?: number;
}
export type DotControl = 'pause' | 'resume' | 'complete' | 'cancel' | 'archive';
export interface DotLiveRun {
  runId: string;
  state: ExecutionState;
  streamingText: string;
  startedAt: number;
  worked: boolean;
}
export interface DotView {
  dot: Dot;
  checkpoint?: DotCheckpoint;
  runs: readonly DotRun[];
  runCount: number;
  sequence: number;
  live?: DotLiveRun;
  attention?: 'persistence' | 'missing-progress' | 'initialization' | 'uncertain';
  approvals?: readonly DotApprovalView[];
  wakes?: readonly DotWake[];
  policy?: { readonly policy: DotResearchPolicy; readonly usage: DotPolicyUsage };
}
export interface DotReviewInput {
  acknowledge: true;
  note: string;
}
export interface DotRequestHistoryView {
  requests: readonly DotApprovalView[];
  total: number;
  offset: number;
  limit: number;
}
export interface DotApprovalView {
  dispatchedAt?: number;
  review?: DotIntentReview;
  id: string;
  runId: string;
  revision: number;
  digest: string;
  status:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'stale'
    | 'cancelled'
    | 'dispatching'
    | 'succeeded'
    | 'unknown';
  createdAt: number;
  expiresAt: number;
  preview: ToolPreview;
  receipt?: {
    summary: string;
    sourceIds: readonly string[];
    sources?: readonly Readonly<SourceRecord>[];
    responseBytes?: number;
  };
}
export interface DotSupervisionItem {
  readonly dotId: string;
  readonly runId: string;
  readonly intentId: string;
  readonly intentRevision: number;
  readonly intentDigest: string;
  readonly kind: 'approval' | 'uncertain';
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface DotSupervisionSnapshot {
  readonly recheckAt?: number;
  readonly sequence: number;
  readonly items: readonly DotSupervisionItem[];
  readonly more: boolean;
}
export interface DotsBridge {
  record(id: string, query: DotRecordQuery): Promise<DotRecordView>;
  context(id: string, query?: DotContextQuery): Promise<DotContextView>;
  supervision(): Promise<DotSupervisionSnapshot>;
  list(options?: DotPage & { includeArchived?: boolean }): Promise<readonly Dot[]>;
  get(id: string): Promise<DotView>;
  create(input: { name: string; goal: string }): Promise<DotView>;
  run(id: string, expectedRevision: number, providerId: string): Promise<DotView>;
  stop(id: string): Promise<DotView>;
  transition(id: string, expectedRevision: number, command: DotControl): Promise<DotView>;
  history(id: string, options?: DotPage): Promise<readonly DotRun[]>;
  checkpoints(id: string, options?: DotPage): Promise<readonly DotCheckpoint[]>;
  decide(
    id: string,
    dotRevision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    decision: 'approve' | 'deny',
  ): Promise<DotView>;
  resumeApproval(id: string, dotRevision: number, intentId: string): Promise<DotView>;
  openSource(id: string, intentId: string, sourceId: string): Promise<void>;
  authorizeResearch(
    id: string,
    revision: number,
    providerId: string,
    input: DotPolicyTerms,
  ): Promise<DotView>;
  revokeResearch(id: string, policyId: string, revision: number): Promise<DotView>;
  scheduleWake(id: string, revision: number, policyId: string, dueAt: number): Promise<DotView>;
  cancelWake(id: string, wakeId: string, revision: number): Promise<DotView>;
  requests(id: string, options?: DotPage): Promise<DotRequestHistoryView>;
  reviewUnknown(
    id: string,
    dotRevision: number,
    intentId: string,
    intentRevision: number,
    digest: string,
    input: DotReviewInput,
  ): Promise<DotView>;
}
export interface DotRecordView {
  readonly dotId: string;
  readonly runId: string;
  readonly dotRevision: number;
  readonly kind: DotRecordQuery['kind'];
  readonly recordId: string;
  readonly version: string;
  readonly section: DotRecordQuery['section'];
  readonly item: number;
  readonly itemCount: number;
  readonly available: boolean;
  readonly status: DotRun['status'] | DotApprovalView['status'];
  readonly text?: {
    readonly content: string;
    readonly offset: number;
    readonly end: number;
    readonly total: number;
  };
  readonly sourceId?: string;
  readonly source?: Pick<
    SourceRecord,
    'id' | 'url' | 'title' | 'kind' | 'retrievedAt' | 'contentHash'
  >;
  readonly next?: DotRecordQuery;
  readonly notice: string;
}
export interface DotContextView {
  readonly dotId: string;
  readonly dotRevision: number;
  readonly run?: DotRun;
  readonly checkpoint?: {
    readonly revision: number;
    readonly summary: string;
    readonly completed: readonly string[];
    readonly next: readonly string[];
    readonly truncated: boolean;
  };
  readonly requests: readonly {
    readonly id: string;
    readonly status: DotApprovalView['status'];
    readonly tool: string;
    readonly query?: string;
    readonly url?: string;
    readonly updatedAt: number;
    readonly receipt?: {
      readonly summary: string;
      readonly sourceCount: number;
      readonly sources: readonly Pick<
        SourceRecord,
        'id' | 'kind' | 'title' | 'contentHash' | 'retrievedAt'
      >[];
    };
    readonly review?: { readonly note: string; readonly reviewedAt: number };
    readonly truncated: boolean;
  }[];
  readonly requestOffset: number;
  readonly requestCount: number;
  readonly olderRunId?: string;
  readonly notice: string;
}
export interface ProviderInput {
  id?: string;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  supportsTools?: boolean;
}
export interface MemoryEntry {
  id: string;
  text: string;
}
export interface Settings {
  dotNotifications?: boolean;
  theme: 'system' | 'light' | 'dark';
  defaultProviderId?: string;
  askBeforeReads: boolean;
  memory: MemoryEntry[];
}
export type WebSearchProvider = 'brave' | 'tavily';
export interface WebSearchConfig {
  provider: WebSearchProvider;
  enabled: boolean;
  hasApiKey: boolean;
  retention: 'session' | 'sources';
}
export interface WebSearchInput {
  provider?: WebSearchProvider;
  enabled: boolean;
  retention: 'session' | 'sources';
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface WebSearchTestInput {
  provider?: WebSearchProvider;
  apiKey?: string;
}
export interface ActionPlanRecord {
  plan: ActionPlan;
  status: PlanStatus;
  journal: ActionJournalEntry[];
  executionId: string;
}
export interface ResearchPlanRecord {
  snapshot: ResearchPlan;
  events: ResearchEvent[];
}
export interface ConversationSummary {
  parentId?: string;
  id: string;
  title: string;
  updatedAt: number;
  workspace?: string;
  providerId?: string;
  state: ExecutionState | 'interrupted';
}
export interface TimelineItem {
  id: string;
  at: number;
  type: 'message' | 'tool' | 'permission' | 'error' | 'status';
  message?: Message;
  call?: ToolCall;
  preview?: ToolPreview;
  request?: PermissionRequest;
  decision?: PermissionDecision;
  result?: ToolResult;
  state?: ExecutionState | 'interrupted';
  text?: string;
  durationMs?: number;
}
export interface Conversation extends ConversationSummary {
  assignment?: string;
  team?: ConversationSummary[];
  messages: Message[];
  timeline: TimelineItem[];
  attachments: string[];
  streamingText: string;
  pendingPermission?: PermissionRequest;
  scopes?: FileScope[];
  sources?: SourceRecord[];
  actionPlans?: ActionPlanRecord[];
  researchPlans?: ResearchPlanRecord[];
}
export interface DesktopAppearance {
  dark: boolean;
  reducedMotion: boolean;
}
export type DesktopAction =
  | 'new-task'
  | 'settings'
  | 'command-palette'
  | 'search'
  | 'toggle-sidebar'
  | 'about'
  | 'rename-conversation'
  | 'confirm-delete-conversation';
export type ContextMenuTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'message'; conversationId: string; itemId: string }
  | { kind: 'file'; conversationId: string; path: string };
export interface Bootstrap {
  conversations: ConversationSummary[];
  providers: ProviderConfig[];
  settings: Settings;
  version: string;
  appearance?: DesktopAppearance;
  webSearch?: WebSearchConfig;
}
export interface ConnectionResult {
  status:
    | 'connected'
    | 'auth'
    | 'rate-limit'
    | 'server'
    | 'incompatible'
    | 'network'
    | 'timeout'
    | 'cancelled';
  message: string;
}
export type DesktopEvent =
  | { type: 'open-dot'; dotId: string }
  | { type: 'dot-supervision'; snapshot: DotSupervisionSnapshot }
  | { type: 'dot'; snapshot: DotView }
  | { type: 'dot-error'; dotId: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'bootstrap'; data: Bootstrap }
  | { type: 'desktop-action'; action: DesktopAction; conversationId?: string }
  | { type: 'desktop-appearance'; appearance: DesktopAppearance };
export interface DesktopBridge {
  readonly dots?: DotsBridge;
  bootstrap(): Promise<Bootstrap>;
  ready(): Promise<void>;
  createConversation(): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<Conversation>;
  showContextMenu(target: ContextMenuTarget): Promise<void>;
  copyText(text: string): Promise<void>;
  selectProvider(conversationId: string, providerId: string): Promise<Conversation>;
  chooseWorkspace(conversationId: string): Promise<Conversation>;
  attachFiles(conversationId: string): Promise<Conversation>;
  addScope(conversationId: string, mode: 'read' | 'write'): Promise<Conversation>;
  removeScope(conversationId: string, scopeId: string): Promise<Conversation>;
  sendTask(conversationId: string, text: string): Promise<void>;
  sendTeamTask?(conversationId: string, text: string): Promise<void>;
  stopTask(conversationId: string): Promise<void>;
  decidePermission(
    conversationId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  decideActionPlan(
    conversationId: string,
    requestId: string,
    digest: string,
    decision: 'allow-once' | 'deny',
  ): Promise<void>;
  decideResearch(
    conversationId: string,
    requestId: string,
    digest: string,
    decision: 'allow-once' | 'deny',
  ): Promise<void>;
  saveWebSearch(input: WebSearchInput): Promise<WebSearchConfig>;
  testWebSearch(input: WebSearchTestInput): Promise<ConnectionResult>;
  openSource(conversationId: string, sourceId: string): Promise<void>;
  saveProvider(input: ProviderInput): Promise<ProviderConfig>;
  deleteProvider(id: string): Promise<void>;
  testProvider(input: ProviderInput): Promise<ConnectionResult>;
  saveSettings(settings: Settings): Promise<Settings>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    prospero: DesktopBridge;
  }
}
