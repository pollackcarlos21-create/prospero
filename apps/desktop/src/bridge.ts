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
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'bootstrap'; data: Bootstrap }
  | { type: 'desktop-action'; action: DesktopAction; conversationId?: string }
  | { type: 'desktop-appearance'; appearance: DesktopAppearance };
export interface DesktopBridge {
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
