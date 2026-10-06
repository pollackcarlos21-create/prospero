import { TOOL_LIMITS } from '@prospero/tools';

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Operation cancelled.', 'AbortError');
}

export function boundOutput(
  value: string,
  maxBytes = TOOL_LIMITS.outputBytes,
): { content: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { content: value, truncated: false };
  const marker = '\n… output truncated …\n';
  const available = maxBytes - Buffer.byteLength(marker);
  const head = Math.floor(available / 2);
  // UTF-8 boundaries are maintained so the final encoded result stays within the cap.
  const decode = (slice: Buffer) => slice.toString('utf8').replace(/^\uFFFD+|\uFFFD+$/g, '');
  return {
    content:
      decode(bytes.subarray(0, head)) +
      marker +
      decode(bytes.subarray(bytes.length - (available - head))),
    truncated: true,
  };
}
