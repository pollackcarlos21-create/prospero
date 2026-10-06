/** Host-neutral v0.2 contracts. Paths/scopes are issued by the application, never by a model. */
export type Effect =
  | 'file.read'
  | 'file.write'
  | 'file.remove'
  | 'process.execute'
  | 'network.search'
  | 'network.fetch'
  | 'native.reveal'
  | 'native.clipboard';
export interface FileScope {
  id: string;
  path: string;
  label: string;
  mode: 'read' | 'write';
  kind: 'directory' | 'file';
  identity?: { dev: number; ino: number };
}
export interface FileReference {
  scopeId: string;
  path: string;
}
export type StructuredAction =
  | {
      kind: 'copy_file' | 'move_file' | 'rename_file';
      source: FileReference;
      target: FileReference;
    }
  | { kind: 'create_directory'; target: FileReference }
  | { kind: 'write_text'; target: FileReference; content: string }
  | { kind: 'trash_file' | 'reveal_in_finder' | 'copy_path'; target: FileReference };
export interface PlannedAction {
  id: string;
  kind: StructuredAction['kind'];
  source?: string;
  target: string;
  effects: readonly Effect[];
  bytes?: number;
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
}
export interface ActionPlan {
  id: string;
  digest: string;
  title: string;
  createdAt: number;
  scopeIds: readonly string[];
  actions: readonly PlannedAction[];
}
export type ActionStatus =
  | 'prepared'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'denied'
  | 'cancelled'
  | 'skipped'
  | 'interrupted';
export type PlanStatus =
  | 'prepared'
  | 'approved'
  | 'completed'
  | 'denied'
  | 'stale'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface ActionJournalEntry {
  planId: string;
  actionId: string;
  sequence: number;
  status: ActionStatus;
  at: number;
  detail?: string;
}
export interface ActionPlanOutcome {
  planId: string;
  digest: string;
  status: PlanStatus;
  journal: ActionJournalEntry[];
}
/** A transition must commit successfully before the executor may begin an effect. */
export interface ActionJournalPort {
  prepare(plan: ActionPlan): void;
  decision(planId: string, decision: 'allow-once' | 'deny'): void;
  transition(planId: string, actionId: string, status: ActionStatus, detail?: string): void;
  finish(planId: string, status: PlanStatus): void;
  entries(planId: string): ActionJournalEntry[];
}
export interface NativeActionAdapter {
  reveal(path: string): void | Promise<void>;
  copyPath(path: string): void | Promise<void>;
  trash(path: string): Promise<void>;
}
export interface SourceRecord {
  id: string;
  url: string;
  title: string;
  kind: 'search' | 'page';
  retrievedAt: number;
  contentHash: string;
  excerpt: string;
}

/** Preview and audit data only. Authority stays in the current main-owned execution. */
export interface ResearchPlan {
  readonly version: 1;
  readonly id: string;
  readonly digest: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly queries: readonly { readonly query: string; readonly maxResults: number }[];
  readonly maxSearches: number;
  readonly maxFetches: number;
  readonly maxResponseBytes: number;
}
export interface ResearchEvent {
  readonly sequence: number;
  readonly at: number;
  readonly snapshotId: string;
  readonly digest: string;
  readonly type: string;
  readonly status: string;
  readonly decision?: 'allow-once' | 'deny';
  readonly reservationId?: string;
  readonly kind?: 'search' | 'fetch';
  readonly sourceIds?: readonly string[];
  readonly responseBytes?: number;
  readonly maxResponseBytes?: number;
  readonly code?: string;
}
