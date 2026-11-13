import type { ActionPlan, ActionPlanOutcome, Effect, SourceRecord } from './actions';
export const ExecutionStates = {
  idle: 'idle',
  planning: 'planning',
  modelRequest: 'model-request',
  waitingPermission: 'waiting-permission',
  suspended: 'suspended',
  toolRunning: 'tool-running',
  modelContinuation: 'model-continuation',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;
export type ExecutionState = (typeof ExecutionStates)[keyof typeof ExecutionStates];
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny';
export type RiskLevel = 'read' | 'write' | 'shell';
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  effects?: readonly Effect[];
}
export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
}
export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface ModelPort {
  stream(
    request: ModelRequest,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<ModelResponse>;
}
export interface ToolPreview {
  kind: 'read' | 'write' | 'shell' | 'plan' | 'web' | 'research';
  title: string;
  path?: string;
  cwd?: string;
  command?: string;
  before?: string;
  after?: string;
  diff?: string;
  plan?: ActionPlan;
  research?: import('./actions').ResearchPlan;
  query?: string;
  url?: string;
  effects?: readonly Effect[];
}
export interface ToolResult {
  content: string;
  isError?: boolean;
  exitCode?: number | null;
  truncated?: boolean;
  planOutcome?: ActionPlanOutcome;
  sources?: SourceRecord[];
}
export interface PreparedTool {
  call: ToolCall;
  definition: ToolDefinition;
  preview: ToolPreview;
  permissionKey: string;
  allowSession: boolean;
  requiresPermission: boolean;
  execute(signal: AbortSignal): Promise<ToolResult>;
  onDecision?(decision: PermissionDecision): void | Promise<void>;
  onSkipped?(reason: 'cancelled' | 'failed'): void | Promise<void>;
  /** Explicit host opt-in: release preparation resources without dispatch or cancellation. */
  onSuspended?(): void | Promise<void>;
}
export interface ToolHost {
  definitions: ToolDefinition[];
  prepare(call: ToolCall, signal: AbortSignal): Promise<PreparedTool>;
}
export interface PermissionRequest {
  requestId: string;
  call: ToolCall;
  preview: ToolPreview;
  permissionKey: string;
  allowSession: boolean;
}
export interface PermissionPort {
  decide(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
}
export type AgentEvent =
  | { type: 'state'; state: ExecutionState }
  | { type: 'text'; delta: string }
  | { type: 'message'; message: Message; replacesMessage?: number }
  | { type: 'tool-request'; call: ToolCall; preview: ToolPreview }
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'permission-decision'; requestId: string; decision: PermissionDecision }
  | { type: 'tool-result'; call: ToolCall; result: ToolResult; durationMs: number }
  | { type: 'error'; message: string };
export interface AgentLimits {
  maxModelTurns?: number;
  maxToolCalls?: number;
  /** Active execution time, excluding waits for user approval. */
  maxExecutionMs?: number;
  /** Maximum wait for each approval, additionally bounded by maxWallClockMs. */
  maxPermissionWaitMs?: number;
  /** Total elapsed time, including all approvals. */
  maxWallClockMs?: number;
  /** Serialized core ModelRequest bytes, not a provider-specific token guarantee. */
  maxContextBytes?: number;
}
export interface AgentOptions {
  executionId: string;
  model: ModelPort;
  host: ToolHost;
  permissions: PermissionPort;
  messages: Message[];
  memory?: string[];
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
  limits?: AgentLimits;
  suspension?: never;
}
export interface AgentOutcome {
  state: 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  modelTurns: number;
  toolCalls: number;
  error?: string;
}

export interface SuspendablePermissionPort {
  decide(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision | 'suspend'>;
}
export interface SuspendableAgentOptions extends Omit<AgentOptions, 'permissions' | 'suspension'> {
  permissions: SuspendablePermissionPort;
  suspension: { continuation?: AgentContinuation };
}
/** Serializable execution data only. Never authority to dispatch the pending call. */
export interface AgentContinuation {
  readonly version: 1;
  readonly executionId: string;
  readonly messages: readonly Readonly<Message>[];
  readonly memory: readonly string[];
  readonly pending: {
    readonly assistantIndex: number;
    readonly resultIndex: number;
    readonly expiresAt: number;
  };
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly remainingExecutionMs: number;
  readonly suspendedAt: number;
  readonly wallDeadline: number;
  readonly limits: Readonly<Required<AgentLimits>>;
  readonly denied: {
    readonly mutations: boolean;
    readonly network: boolean;
    readonly reads: readonly string[];
  };
  readonly sources: readonly Readonly<SourceRecord>[];
}
export interface SuspendedAgentOutcome extends Omit<AgentOutcome, 'state'> {
  state: 'suspended';
  continuation: AgentContinuation;
  request: PermissionRequest;
}
