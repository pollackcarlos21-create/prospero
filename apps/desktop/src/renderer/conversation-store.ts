import type { Conversation, ConversationSummary } from '../bridge';

/** Coalesce IPC snapshots to one paint and preserve unchanged timeline identities. */
export class ConversationStore {
  private values = new Map<string, Conversation>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<string, Conversation>();
  private frame: ReturnType<typeof setTimeout> | undefined;
  get = (id: string) => this.values.get(id);
  subscribe = (id: string, listener: () => void) => {
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
    };
  };
  put(conversation: Conversation) {
    this.pending.delete(conversation.id);
    const previous = this.values.get(conversation.id);
    if (previous) {
      const old = new Map(previous.timeline.map((item) => [item.id, item]));
      const timeline = conversation.timeline.map((item) => {
        const existing = old.get(item.id);
        return existing && JSON.stringify(existing) === JSON.stringify(item) ? existing : item;
      });
      conversation = {
        ...conversation,
        timeline:
          timeline.length === previous.timeline.length &&
          timeline.every((item, i) => item === previous.timeline[i])
            ? previous.timeline
            : timeline,
      };
    }
    this.values.set(conversation.id, conversation);
    this.listeners.get(conversation.id)?.forEach((listener) => {
      listener();
    });
  }
  queue(conversation: Conversation) {
    this.pending.set(conversation.id, conversation);
    if (!this.frame)
      this.frame = setTimeout(() => {
        this.frame = undefined;
        const values = [...this.pending.values()];
        this.pending.clear();
        values.forEach((value) => {
          this.put(value);
        });
      }, 32);
  }
  dispose() {
    if (this.frame) clearTimeout(this.frame);
    this.pending.clear();
  }
}
export function summaryOf(value: Conversation): ConversationSummary {
  return {
    id: value.id,
    title: value.title,
    updatedAt: value.updatedAt,
    workspace: value.workspace,
    providerId: value.providerId,
    state: value.state,
  };
}
export const activeStates = new Set([
  'planning',
  'model-request',
  'waiting-permission',
  'tool-running',
  'model-continuation',
]);
export function statusLabel(state: string) {
  const labels: Record<string, string> = {
    idle: 'Ready',
    planning: 'Planning task',
    'model-request': 'Thinking',
    'waiting-permission': 'Needs your approval',
    'tool-running': 'Running tool',
    'model-continuation': 'Continuing task',
    completed: 'Completed',
    failed: 'Task failed',
    cancelled: 'Stopped',
    interrupted: 'Interrupted — ready to continue',
  };
  return labels[state] ?? 'Ready';
}
