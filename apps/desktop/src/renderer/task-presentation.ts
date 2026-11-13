import type { TimelineItem } from '../bridge';
import { activeStates } from './conversation-store';

/** Colours supplement the visible status text; they never replace it. */
export function statusTone(state: string): 'working' | 'complete' | 'incomplete' | 'neutral' {
  if (
    activeStates.has(state) ||
    ['pending', 'prepared', 'approved', 'running', 'dispatching'].includes(state)
  )
    return 'working';
  if (['completed', 'succeeded'].includes(state)) return 'complete';
  if (
    [
      'failed',
      'cancelled',
      'interrupted',
      'denied',
      'stale',
      'partial',
      'skipped',
      'unknown',
      'expired',
      'blocked',
    ].includes(state)
  )
    return 'incomplete';
  return 'neutral';
}

export function elapsedLabel(start: number, end: number, worked: boolean): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${worked ? 'Worked' : 'Thought'} for ${duration}`;
}

/** Elapsed task time from host timestamps, with no generated reasoning or invented timings. */
export function turnTimings(items: readonly TimelineItem[], now: number) {
  const messages = new Map<string, string>();
  let start: number | undefined;
  let worked = false;
  for (const item of items) {
    if (item.type === 'message' && item.message?.role === 'user') {
      start = item.at;
      worked = false;
    } else if (item.type === 'tool') worked = true;
    else if (item.type === 'message' && item.message?.role === 'assistant' && start !== undefined)
      messages.set(item.id, elapsedLabel(start, item.at, worked));
  }
  return { messages, current: start === undefined ? undefined : elapsedLabel(start, now, worked) };
}
